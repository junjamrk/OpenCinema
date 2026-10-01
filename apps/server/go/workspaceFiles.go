package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

func within(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
func atomicWrite(path string, content []byte, exclusive bool, mode os.FileMode) error {
	return atomicWriteStream(path, bytes.NewReader(content), exclusive, mode)
}
func atomicWriteStream(path string, content io.Reader, exclusive bool, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".openCinemaWrite")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(mode); err == nil {
		_, err = io.Copy(file, content)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if exclusive {
		if err = os.Link(name, path); err != nil {
			return err
		}
	} else {
		if info, e := os.Stat(path); e == nil {
			_ = os.Chmod(name, info.Mode().Perm())
		}
		if err = os.Rename(name, path); err != nil {
			return err
		}
	}
	if parent, e := os.Open(filepath.Dir(path)); e == nil {
		_ = parent.Sync()
		_ = parent.Close()
	}
	return nil
}

// atomicImportMedia 将本机明确指定的媒体流式复制为工作区新文件，不修改来源，不覆盖目标。
func atomicImportMedia(source, path string) (string, int64, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", 0, err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > 100*1024*1024 {
		return "", 0, fail(413, "仅支持100MiB以内普通媒体文件")
	}
	header := make([]byte, 512)
	n, err := input.Read(header)
	if err != nil && err != io.EOF {
		return "", 0, err
	}
	mediaType := http.DetectContentType(header[:n])
	if !strings.HasPrefix(mediaType, "image/") && !strings.HasPrefix(mediaType, "video/") && !strings.HasPrefix(mediaType, "audio/") {
		return "", 0, fail(415, "导入入口仅接受可识别的图片、视频或音频；其他文件使用专属操作")
	}
	if _, err = input.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	output, err := os.CreateTemp(filepath.Dir(path), ".openCinemaImport")
	if err != nil {
		return "", 0, err
	}
	name := output.Name()
	defer os.Remove(name)
	defer output.Close()
	if err = output.Chmod(0600); err != nil {
		return "", 0, err
	}
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(output, digest), io.LimitReader(input, 100*1024*1024+1))
	if err != nil {
		return "", 0, err
	}
	if size > 100*1024*1024 {
		return "", 0, fail(413, "媒体超过100MiB")
	}
	after, err := input.Stat()
	if err != nil {
		return "", 0, err
	}
	if after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return "", 0, stale("导入期间来源媒体已变化，未发布目标")
	}
	if err = output.Sync(); err != nil {
		return "", 0, err
	}
	if err = output.Close(); err != nil {
		return "", 0, err
	}
	if err = os.Link(name, path); err != nil {
		return "", 0, err
	}
	if parent, e := os.Open(filepath.Dir(path)); e == nil {
		_ = parent.Sync()
		_ = parent.Close()
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}
func (s *server) lockFiles(paths ...string) (func(), error) {
	s.fileMu.Lock()
	defer s.fileMu.Unlock()
	for _, path := range paths {
		for busy := range s.busy {
			if within(path, busy) || within(busy, path) {
				return nil, &apiError{409, "文件正在使用，请等待操作完成", "EBUSY"}
			}
		}
	}
	for _, path := range paths {
		s.busy[path] = true
	}
	return func() {
		s.fileMu.Lock()
		defer s.fileMu.Unlock()
		for _, path := range paths {
			delete(s.busy, path)
		}
	}, nil
}
func (s *server) workspace(r *http.Request, directory string) (string, error) {
	if !filepath.IsAbs(directory) || len(directory) > 4096 {
		return "", fail(400, "工作目录必须是绝对路径")
	}
	root, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fail(404, "工作目录不是文件夹")
	}
	if s.localRequest(r) {
		return root, nil
	}
	base, err := filepath.EvalSymlinks(filepath.Join(s.dataDirectory, "workspaces"))
	if err != nil {
		return "", err
	}
	if !within(base, root) {
		return "", fail(403, "服务器部署只能使用服务器工作区")
	}
	return root, nil
}

var invalidPath = regexp.MustCompile(`[<>:"|?*\x00-\x1f]`)

func workspacePath(root, path string, missingParents bool) (string, error) {
	if filepath.IsAbs(path) || strings.Contains(path, "\\") || len(path) > 4096 {
		return "", fail(400, "文件路径无效")
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." || invalidPath.MatchString(part) {
			return "", fail(400, "文件路径无效")
		}
	}
	target := filepath.Join(root, filepath.FromSlash(path))
	if !within(root, target) {
		return "", fail(403, "只能操作当前工作区内的文件")
	}
	parts := strings.Split(filepath.ToSlash(strings.TrimPrefix(strings.TrimPrefix(target, root), string(filepath.Separator))), "/")
	current := root
	for i, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if i < len(parts)-1 && !missingParents {
				return "", err
			}
			return target, nil
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fail(403, "不能通过符号链接操作文件")
		}
		if i < len(parts)-1 && !info.IsDir() {
			return "", fail(400, "路径父级不是文件夹")
		}
	}
	return target, nil
}
func (s *server) resolveFile(r *http.Request, directory, path string) (string, string, error) {
	root, err := s.workspace(r, directory)
	if err != nil {
		return "", "", err
	}
	target, err := workspacePath(root, path, false)
	return root, target, err
}
func decodeText(content []byte) (string, string, error) {
	encoding := "utf-8"
	data := content
	if bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		encoding = "utf-8-bom"
		data = data[3:]
	} else if bytes.HasPrefix(data, []byte{0xff, 0xfe}) || bytes.HasPrefix(data, []byte{0xfe, 0xff}) {
		be := data[0] == 0xfe
		encoding = "utf-16le"
		if be {
			encoding = "utf-16be"
		}
		data = data[2:]
		if len(data)%2 != 0 {
			return "", "", fail(415, "UTF-16 文本长度无效")
		}
		units := make([]uint16, len(data)/2)
		for i := range units {
			if be {
				units[i] = binary.BigEndian.Uint16(data[i*2:])
			} else {
				units[i] = binary.LittleEndian.Uint16(data[i*2:])
			}
		}
		for i := 0; i < len(units); i++ {
			u := units[i]
			if u >= 0xd800 && u <= 0xdbff {
				if i+1 >= len(units) || units[i+1] < 0xdc00 || units[i+1] > 0xdfff {
					return "", "", fail(415, "UTF-16 文本编码无效")
				}
				i++
			} else if u >= 0xdc00 && u <= 0xdfff {
				return "", "", fail(415, "UTF-16 文本编码无效")
			}
		}
		data = []byte(string(utf16.Decode(units)))
	}
	if !utf8.Valid(data) || bytes.ContainsRune(data, 0) {
		return "", "", fail(415, "文件不是受支持的 UTF-8 或带 BOM 的 UTF-16 文本，原文件未修改")
	}
	return string(data), encoding, nil
}
func encodeText(content []byte, encoding string) ([]byte, error) {
	if encoding == "" || encoding == "utf-8" {
		return content, nil
	}
	if !utf8.Valid(content) {
		return nil, fail(415, "输入不是 UTF-8 文本")
	}
	if encoding == "utf-8-bom" {
		return append([]byte{0xef, 0xbb, 0xbf}, content...), nil
	}
	if encoding != "utf-16le" && encoding != "utf-16be" {
		return nil, fail(400, "文本编码无效")
	}
	units := utf16.Encode([]rune(string(content)))
	out := make([]byte, 2+len(units)*2)
	out[0], out[1] = 0xff, 0xfe
	for i, u := range units {
		if encoding == "utf-16be" {
			binary.BigEndian.PutUint16(out[2+i*2:], u)
		} else {
			binary.LittleEndian.PutUint16(out[2+i*2:], u)
		}
	}
	if encoding == "utf-16be" {
		out[0], out[1] = 0xfe, 0xff
	}
	return out, nil
}
func (s *server) workspaceRoute(w http.ResponseWriter, r *http.Request) error {
	p := strings.TrimPrefix(r.URL.Path, "/api/workspaces/")
	if p == "list" {
		base := filepath.Join(s.dataDirectory, "workspaces")
		target, err := workspacePath(base, r.URL.Query().Get("path"), false)
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(target)
		if err != nil {
			return err
		}
		directories := []any{}
		for _, e := range entries {
			if e.IsDir() {
				relative, _ := filepath.Rel(base, filepath.Join(target, e.Name()))
				directories = append(directories, object{"name": e.Name(), "path": filepath.ToSlash(relative)})
			}
		}
		relative, _ := filepath.Rel(base, target)
		if relative == "." {
			relative = ""
		}
		var parent any
		if relative != "" {
			parent = filepath.ToSlash(filepath.Dir(relative))
			if parent == "." {
				parent = ""
			}
		}
		success(w, object{"path": filepath.ToSlash(relative), "absolutePath": target, "parent": parent, "directories": directories})
		return nil
	}
	if p == "check" {
		root, err := s.workspace(r, r.URL.Query().Get("directory"))
		if err != nil {
			return err
		}
		success(w, object{"directory": root})
		return nil
	}
	if p == "exportProject" {
		return s.exportProject(w, r)
	}
	if p == "restoreProject" {
		return s.restoreProject(w, r)
	}
	if p == "clone" {
		return s.cloneProject(w, r)
	}
	if !strings.HasPrefix(p, "files/") {
		return fail(404, "工作区接口不存在")
	}
	operation := strings.TrimPrefix(p, "files/")
	var input object
	var err error
	if r.Method == "GET" || r.Method == "PUT" {
		input = object{"directory": r.URL.Query().Get("directory"), "path": r.URL.Query().Get("path")}
	} else {
		input, err = decode(r)
		if err != nil {
			return err
		}
	}
	root, target, err := s.resolveFile(r, str(input["directory"]), str(input["path"]))
	if err != nil {
		return err
	}
	if r.Method != "GET" {
		if err = s.appRequest(r); err != nil {
			return err
		}
		if target == root && operation != "importImage" {
			return fail(400, "不能修改工作区根目录")
		}
	}
	switch operation {
	case "stat":
		if r.Method != "GET" {
			return fail(405, "HTTP方法不支持")
		}
		release, err := s.lockFiles(target)
		if err != nil {
			return err
		}
		defer release()
		revision, err := fileSnapshotRevision(target)
		if err != nil {
			return err
		}
		info, err := os.Stat(target)
		if err != nil {
			return err
		}
		success(w, object{"directory": root, "path": input["path"], "fileRevision": revision, "size": info.Size(), "isDirectory": info.IsDir()})
	case "list":
		if r.Method != "GET" {
			return fail(405, "HTTP 方法不支持")
		}
		entries, err := os.ReadDir(target)
		if err != nil {
			return err
		}
		items := []any{}
		for _, entry := range entries {
			if entry.IsDir() || entry.Type().IsRegular() {
				relative, _ := filepath.Rel(root, filepath.Join(target, entry.Name()))
				kind := "file"
				if entry.IsDir() {
					kind = "directory"
				}
				items = append(items, object{"name": entry.Name(), "path": filepath.ToSlash(relative), "type": kind})
			}
		}
		sort.Slice(items, func(i, j int) bool { return str(asObject(items[i])["name"]) < str(asObject(items[j])["name"]) })
		success(w, object{"directory": root, "empty": len(entries) == 0, "entries": items})
	case "read":
		if r.Method != "GET" {
			return fail(405, "HTTP 方法不支持")
		}
		file, err := os.Open(target)
		if err != nil {
			return err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fail(400, "只能读取普通文件")
		}
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Query().Get("snapshot") == "true" {
			limit := int64(100 * 1024 * 1024)
			if raw := r.URL.Query().Get("maxBytes"); raw != "" {
				limit, err = strconv.ParseInt(raw, 10, 64)
				if err != nil || limit < 1 || limit > 20*1024*1024 {
					return fail(400, "读取大小无效")
				}
			}
			if info.Size() > limit {
				return fail(413, "文件超过本次文本读取大小限制")
			}
			data, err := io.ReadAll(io.LimitReader(file, limit+1))
			if err != nil {
				return err
			}
			if int64(len(data)) > limit {
				return fail(413, "文件超过本次文本读取大小限制")
			}
			text, encoding, err := decodeText(data)
			if err != nil {
				return err
			}
			success(w, object{"text": text, "encoding": encoding, "revision": hash(data)})
		} else {
			http.ServeContent(w, r, info.Name(), info.ModTime(), file)
		}
	case "range":
		return s.readRange(w, r, target)
	case "write":
		if r.Method != "PUT" || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/octet-stream") {
			return fail(400, "请使用 PUT 发送文件原始内容")
		}
		release, err := s.lockFiles(target)
		if err != nil {
			return err
		}
		defer release()
		if err = s.protectCollaboration(root, str(input["path"])); err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 100*1024*1024+1))
		if err != nil {
			return err
		}
		if len(data) > 100*1024*1024 {
			return fail(413, "文件超过100MiB")
		}
		revision := r.URL.Query().Get("expectedRevision")
		if revision != "" {
			previous, err := os.ReadFile(target)
			if err != nil || hash(previous) != revision {
				return stale("文件已被其他编辑器修改，当前修改已保留，未覆盖磁盘内容")
			}
		}
		data, err = encodeText(data, r.URL.Query().Get("encoding"))
		if err != nil {
			return err
		}
		if err = atomicWrite(target, data, r.URL.Query().Get("exclusive") == "true", 0600); err != nil {
			return err
		}
		if revision != "" {
			success(w, object{"revision": hash(data)})
		} else {
			success(w, nil)
		}
	case "mkdir":
		release, err := s.lockFiles(target)
		if err != nil {
			return err
		}
		defer release()
		if err = os.Mkdir(target, 0755); err != nil {
			return err
		}
		success(w, nil)
	case "remove":
		release, err := s.lockFiles(target)
		if err != nil {
			return err
		}
		defer release()
		if _, err = requireFileRevision(target, object{"path": input["path"], "fileRevision": input["expectedRevision"]}); err != nil {
			return err
		}
		if err = s.protectCollaboration(root, str(input["path"])); err != nil {
			return err
		}
		if boolean(input["recursive"]) {
			err = os.RemoveAll(target)
		} else {
			err = os.Remove(target)
		}
		if err != nil {
			return err
		}
		success(w, nil)
	case "copy", "rename":
		destination, err := workspacePath(root, str(input["target"]), false)
		if err != nil {
			return err
		}
		if destination == root {
			return fail(400, "不能覆盖工作区根目录")
		}
		release, err := s.lockFiles(target, destination)
		if err != nil {
			return err
		}
		defer release()
		if _, err = requireFileRevision(target, object{"path": input["path"], "fileRevision": input["expectedRevision"]}); err != nil {
			return err
		}
		if _, err = os.Lstat(destination); !os.IsNotExist(err) {
			if err == nil {
				return &apiError{409, "目标名称已经存在", "EEXIST"}
			}
			return err
		}
		if operation == "rename" {
			if err = s.protectCollaboration(root, str(input["path"])); err != nil {
				return err
			}
			err = os.Rename(target, destination)
		} else {
			err = copyTree(target, destination)
		}
		if err != nil {
			return err
		}
		success(w, nil)
	case "importImage":
		return s.importImage(w, r, root, str(input["url"]))
	default:
		return fail(404, "文件接口不存在")
	}
	return nil
}
func fileRangeRevision(path string, info os.FileInfo) string {
	identity := fmt.Sprintf("%s:%d:%d", path, info.Size(), info.ModTime().UnixNano())
	stat := reflect.ValueOf(info.Sys())
	if stat.Kind() == reflect.Pointer {
		stat = stat.Elem()
	}
	if stat.Kind() == reflect.Struct {
		for _, key := range []string{"Dev", "Ino", "Ctim", "Ctimespec"} {
			field := stat.FieldByName(key)
			if field.IsValid() && field.CanInterface() {
				identity += fmt.Sprintf(":%v", field.Interface())
			}
		}
	}
	return hash([]byte(identity))
}
func (s *server) readRange(w http.ResponseWriter, r *http.Request, path string) error {
	offset, e1 := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	length, e2 := strconv.ParseInt(r.URL.Query().Get("length"), 10, 64)
	if e1 != nil || e2 != nil || offset < 0 || length < 1 || length > 8*1024*1024 {
		return fail(400, "分段读取范围无效")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fail(400, "只能读取文件")
	}
	revision := fileRangeRevision(path, info)
	if requested := r.URL.Query().Get("revision"); requested != "" && requested != revision {
		return stale("文件已变化，请重新检查素材")
	}
	w.Header().Set("X-Toonflow-File-Revision", revision)
	w.Header().Set("Cache-Control", "no-store")
	if offset >= info.Size() {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", info.Size()))
		w.WriteHeader(416)
		return nil
	}
	if length > info.Size()-offset {
		length = info.Size() - offset
	}
	data := make([]byte, length)
	if _, err = file.ReadAt(data, offset); err != nil {
		return err
	}
	after, err := file.Stat()
	if err != nil {
		return err
	}
	if after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return stale("读取期间文件已变化")
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, offset+length-1, info.Size()))
	w.WriteHeader(206)
	_, err = w.Write(data)
	return err
}
func copyTree(source, target string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fail(403, "不能复制符号链接")
	}
	if info.IsDir() {
		if within(source, target) {
			return fail(400, "不能复制目录到自身或子目录")
		}
		if err = os.Mkdir(target, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err = copyTree(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fail(403, "不能复制特殊文件")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return atomicWrite(target, data, true, info.Mode().Perm())
}
func (s *server) exportProject(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	if r.Method != "GET" && r.Method != "POST" {
		return fail(405, "HTTP方法不支持")
	}
	directory, outputPath := r.URL.Query().Get("directory"), ""
	if r.Method == "POST" {
		input, err := decode(r)
		if err != nil {
			return err
		}
		for key := range input {
			if key != "directory" && key != "path" {
				return fail(400, "未知归档参数: "+key)
			}
		}
		directory, outputPath = str(input["directory"]), str(input["path"])
		if outputPath == "" || !strings.HasSuffix(strings.ToLower(outputPath), ".zip") {
			return fail(400, "归档目标必须是工程内的ZIP相对路径")
		}
	}
	root, err := s.workspace(r, directory)
	if err != nil {
		return err
	}
	release, err := s.lockFiles(root)
	if err != nil {
		return err
	}
	defer release()
	output := ""
	if outputPath != "" {
		output, err = workspacePath(root, outputPath, false)
		if err != nil {
			return err
		}
		if _, err = os.Lstat(output); err == nil {
			return &apiError{409, "归档目标已存在，未覆盖文件", "EEXIST"}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err = s.protectCollaboration(root, outputPath); err != nil {
			return err
		}
	}
	type member struct {
		path     string
		size     int64
		sha256   string
		modified time.Time
	}
	members := []member{}
	directories := []string{}
	seen := map[string]bool{}
	var total int64
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = r.Context().Err(); err != nil {
			return err
		}
		if path == root {
			return nil
		}
		relative, _ := filepath.Rel(root, path)
		relative = filepath.ToSlash(relative)
		if strings.HasPrefix(relative, "/") || invalidPath.MatchString(relative) || strings.Contains(relative, "\\") {
			return fail(400, "工程归档路径无效")
		}
		key := strings.ToLower(relative)
		if seen[key] {
			return fail(400, "工程文件存在跨平台名称冲突")
		}
		seen[key] = true
		if len(seen) > 10000 {
			return fail(413, "工程超过10000项")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fail(403, "工程不能包含符号链接")
		}
		if entry.IsDir() {
			directories = append(directories, relative)
			return nil
		}
		if !info.Mode().IsRegular() {
			return fail(403, "工程不能包含特殊文件")
		}
		total += info.Size()
		if info.Size() > 256*1024*1024 || total > 2*1024*1024*1024 || strings.HasSuffix(relative, ".json") && info.Size() > 32*1024*1024 {
			return fail(413, "工程超过归档大小限制")
		}
		digest, err := hashFile(r.Context(), path)
		if err != nil {
			return err
		}
		members = append(members, member{relative, info.Size(), digest, info.ModTime()})
		return nil
	})
	if err != nil {
		return err
	}
	entries := []any{}
	for _, m := range members {
		entries = append(entries, object{"path": m.path, "size": m.size, "sha256": m.sha256})
	}
	manifest := object{"format": "openCinema-workspace", "schemaVersion": 1, "name": filepath.Base(root), "createdAt": time.Now().UTC().Format(time.RFC3339Nano), "directories": directories, "entries": entries}
	manifestBytes, _ := json.Marshal(manifest)
	spool, err := os.CreateTemp(s.dataDirectory, ".openCinemaExport")
	if err != nil {
		return err
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	archive := zip.NewWriter(spool)
	writer, err := archive.Create("manifest.json")
	if err != nil {
		return err
	}
	if _, err = writer.Write(manifestBytes); err != nil {
		return err
	}
	for _, m := range members {
		if err = r.Context().Err(); err != nil {
			return err
		}
		path := filepath.Join(root, filepath.FromSlash(m.path))
		writer, err := archive.Create("workspace/" + m.path)
		if err != nil {
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		digest := sha256.New()
		size, copyErr := io.Copy(io.MultiWriter(writer, digest), io.LimitReader(file, m.size+1))
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if size != m.size || hex.EncodeToString(digest.Sum(nil)) != m.sha256 {
			return stale("导出期间工程文件已变化，请重新保存后导出")
		}
		if err = r.Context().Err(); err != nil {
			return err
		}
	}
	if err = archive.Close(); err != nil {
		return err
	}
	if _, err = spool.Seek(0, 0); err != nil {
		return err
	}
	info, err := spool.Stat()
	if err != nil {
		return err
	}
	if info.Size() > 2*1024*1024*1024+128*1024*1024 {
		return fail(413, "ZIP归档超过2GiB及128MiB元数据余量")
	}
	if output != "" {
		if err = r.Context().Err(); err != nil {
			return err
		}
		expectedRevision, err := hashFile(r.Context(), spool.Name())
		if err != nil {
			return err
		}
		if err = atomicWriteStream(output, spool, true, 0600); err != nil {
			return err
		}
		actualRevision, err := hashFile(r.Context(), output)
		if err != nil {
			return err
		}
		saved, err := os.Stat(output)
		if err != nil {
			return err
		}
		if saved.Size() != info.Size() || actualRevision != expectedRevision {
			return stale("归档保存后的内容或大小已变化，请读取产物确认")
		}
		relative, err := filepath.Rel(root, output)
		if err != nil {
			return err
		}
		success(w, object{"path": filepath.ToSlash(relative), "size": saved.Size(), "fileRevision": actualRevision, "sourceRevision": fileRangeRevision(output, saved), "mimeType": "application/zip"})
		return nil
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(root) + ".openCinema.zip"}))
	w.Header().Set("Content-Security-Policy", "sandbox")
	http.ServeContent(w, r, filepath.Base(root)+".openCinema.zip", info.ModTime(), spool)
	return nil
}
func (s *server) restoreProject(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	directory := r.URL.Query().Get("directory")
	root, err := s.workspace(r, directory)
	if err != nil {
		return err
	}
	name := r.URL.Query().Get("name")
	if name == "" || filepath.Base(name) != name || invalidPath.MatchString(name) {
		return fail(400, "工程名称无效")
	}
	spool, err := os.CreateTemp(s.dataDirectory, ".openCinemaImport")
	if err != nil {
		return err
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	archiveSize, err := io.Copy(spool, io.LimitReader(r.Body, 2*1024*1024*1024+1))
	if err != nil {
		return err
	}
	if archiveSize > 2*1024*1024*1024 {
		return fail(413, "工程归档超过2GiB")
	}
	archive, err := zip.NewReader(spool, archiveSize)
	if err != nil {
		return fail(400, "工程 ZIP 无效")
	}
	var manifest object
	files := map[string]*zip.File{}
	for _, file := range archive.File {
		if len(files) > 10000 {
			return fail(413, "工程项目过多")
		}
		if _, ok := files[file.Name]; ok {
			return fail(400, "归档名称重复")
		}
		files[file.Name] = file
	}
	mf := files["manifest.json"]
	if mf == nil || mf.UncompressedSize64 > 32*1024*1024 {
		return fail(400, "工程清单缺失或过大")
	}
	reader, err := mf.Open()
	if err != nil {
		return err
	}
	err = json.NewDecoder(reader).Decode(&manifest)
	_ = reader.Close()
	if err != nil || str(manifest["format"]) != "openCinema-workspace" || number(manifest["schemaVersion"]) != 1 {
		return fail(400, "工程清单无效")
	}
	destination, err := workspacePath(root, name, false)
	if err != nil {
		return err
	}
	if _, err = os.Lstat(destination); !os.IsNotExist(err) {
		return fail(409, "目标工程已存在")
	}
	temporary, err := os.MkdirTemp(root, ".openCinemaImport")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temporary)
	var total uint64
	for _, raw := range array(manifest["entries"]) {
		entry := asObject(raw)
		relative := str(entry["path"])
		path, err := workspacePath(temporary, relative, true)
		if err != nil {
			return err
		}
		file := files["workspace/"+relative]
		if file == nil || file.Mode()&os.ModeSymlink != 0 || file.UncompressedSize64 > 256*1024*1024 {
			return fail(400, "归档文件无效")
		}
		total += file.UncompressedSize64
		if total > 2*1024*1024*1024 {
			return fail(413, "工程过大")
		}
		reader, err := file.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(reader, 256*1024*1024+1))
		_ = reader.Close()
		if err != nil {
			return err
		}
		if hash(data) != str(entry["sha256"]) || float64(len(data)) != number(entry["size"]) {
			return fail(400, "归档内容校验失败")
		}
		if err = os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			return err
		}
		if err = atomicWrite(path, data, true, 0600); err != nil {
			return err
		}
	}
	for _, raw := range array(manifest["directories"]) {
		path, err := workspacePath(temporary, str(raw), true)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(path, 0755); err != nil {
			return err
		}
	}
	if err = os.Rename(temporary, destination); err != nil {
		return err
	}
	success(w, object{"directory": destination})
	return nil
}
func (s *server) cloneProject(w http.ResponseWriter, r *http.Request) error {
	v, err := decode(r)
	if err != nil {
		return err
	}
	directory, err := s.workspace(r, str(v["directory"]))
	if err != nil {
		return err
	}
	name := str(v["name"])
	target, err := workspacePath(directory, name, false)
	if err != nil || name == "" || strings.Contains(name, "/") {
		return fail(400, "工程名称无效")
	}
	if err = s.appRequest(r); err != nil {
		return err
	}
	source := str(v["url"])
	u, err := url.Parse(source)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return fail(400, "仅支持 HTTPS 工程 Git 地址")
	}
	return s.gitClone(w, r, directory, target, source)
}
func (s *server) importImage(w http.ResponseWriter, r *http.Request, root, source string) error {
	var data []byte
	var contentType string
	var err error
	if strings.HasPrefix(source, "data:image/") {
		parts := strings.SplitN(source, ",", 2)
		if len(parts) != 2 {
			return fail(400, "图片数据无效")
		}
		contentType = strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
		data, err = base64.StdEncoding.DecodeString(parts[1])
	} else {
		request, e := http.NewRequestWithContext(r.Context(), "GET", source, nil)
		if e != nil {
			return e
		}
		u := request.URL
		if u.Scheme != "https" && u.Scheme != "http" {
			return fail(400, "图片地址必须使用 HTTP(S)")
		}
		response, e := safeClient().Do(request)
		if e != nil {
			return e
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return fail(502, "图片下载失败")
		}
		contentType = strings.Split(response.Header.Get("Content-Type"), ";")[0]
		data, err = io.ReadAll(io.LimitReader(response.Body, 20*1024*1024+1))
	}
	if err != nil {
		return err
	}
	if len(data) == 0 || len(data) > 20*1024*1024 {
		return fail(413, "图片大小须在20MiB以内")
	}
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		contentType = detected
	}
	if !strings.HasPrefix(contentType, "image/") {
		return fail(415, "资源不是图片")
	}
	ext := ".png"
	if contentType == "image/jpeg" {
		ext = ".jpg"
	} else if contentType == "image/webp" {
		ext = ".webp"
	}
	path := filepath.Join("assets", "imported", randomID()+ext)
	target, err := workspacePath(root, filepath.ToSlash(path), true)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	if err = atomicWrite(target, data, true, 0600); err != nil {
		return err
	}
	success(w, object{"path": filepath.ToSlash(path), "mimeType": contentType})
	return nil
}
