package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var moduleRevision = regexp.MustCompile(`^[a-f0-9]{64}$`)

func (s *server) nodePackage(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	if r.Method != "GET" {
		return fail(405, "插件发行包只支持 GET")
	}
	name, revision := r.URL.Query().Get("name"), r.URL.Query().Get("revision")
	if !pluginName.MatchString(name) || !moduleRevision.MatchString(revision) {
		return fail(400, "插件发行版本无效")
	}
	directory := filepath.Join(s.dataDirectory, "nodes")
	if _, err := os.Stat(filepath.Join(directory, name+".disabled")); err == nil {
		return fail(404, "插件已禁用")
	}
	root := filepath.Join(directory, name, revision)
	actual, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	if actual != root {
		return fail(403, "插件目录不能是符号链接")
	}
	read := func(relative string, limit int64) ([]byte, error) {
		path, err := workspacePath(root, relative, false)
		if err != nil {
			return nil, err
		}
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > limit {
			return nil, fail(413, "插件资源不是普通文件或超过大小限制")
		}
		data, err := io.ReadAll(io.LimitReader(file, limit+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > limit {
			return nil, fail(413, "插件资源超过大小限制")
		}
		return data, nil
	}
	metadata, err := read("manifest.json", 2*1024*1024)
	if err != nil {
		return err
	}
	var manifest object
	if json.Unmarshal(metadata, &manifest) != nil || str(manifest["revision"]) != revision || str(manifest["renderer"]) != "react" {
		return fail(409, "插件清单与版本不一致")
	}
	source, err := read("index.js", 20*1024*1024)
	if err != nil {
		return err
	}
	assets := []any{}
	var total int
	if len(array(manifest["assets"])) > 1000 {
		return fail(413, "插件资源数量过多")
	}
	for _, raw := range array(manifest["assets"]) {
		asset := asObject(raw)
		data, err := read(str(asset["path"]), 32*1024*1024)
		if err != nil {
			return err
		}
		total += len(data)
		if total > 64*1024*1024 || hash(data) != str(asset["sha256"]) {
			return fail(409, "插件资源大小或 SHA256 不一致")
		}
		assets = append(assets, object{"path": asset["path"], "base64": base64.StdEncoding.EncodeToString(data), "sha256": asset["sha256"], "mimeType": asset["mimeType"], "size": len(data)})
	}
	success(w, object{"manifest": manifest, "source": string(source), "assets": assets})
	return nil
}

func (s *server) installNodeModule(name, source string, manifest, input object) (object, error) {
	directory := filepath.Join(s.dataDirectory, "nodes")
	pointer := filepath.Join(directory, name+".json")
	release, err := s.lockFiles(pointer, filepath.Join(directory, name))
	if err != nil {
		return nil, err
	}
	defer release()
	force := boolean(input["force"])
	if info, err := os.Lstat(pointer); err == nil {
		if !info.Mode().IsRegular() {
			return nil, fail(403, "插件清单不能是链接或特殊文件")
		}
		if !force {
			return nil, fail(409, "插件已存在，请明确 force 后更新")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	type moduleAsset struct {
		path, mimeType, sha256 string
		bytes                  []byte
	}
	assets := []moduleAsset{}
	seen := map[string]bool{"index.js": true, "manifest.json": true}
	total := 0
	rawAssets := array(input["assets"])
	if len(rawAssets) > 1000 {
		return nil, fail(413, "插件资源超过1000项")
	}
	for _, raw := range rawAssets {
		asset := asObject(raw)
		path := str(asset["path"])
		if path == "" || strings.Contains(path, "\\") || strings.HasPrefix(path, "/") {
			return nil, fail(400, "插件资源路径无效")
		}
		for _, part := range strings.Split(path, "/") {
			if part == "" || part == "." || part == ".." || strings.HasPrefix(part, ".") || invalidPath.MatchString(part) {
				return nil, fail(400, "插件资源不能越界或使用隐藏路径")
			}
		}
		key := strings.ToLower(path)
		if seen[key] {
			return nil, fail(400, "插件资源路径重复或覆盖入口")
		}
		seen[key] = true
		encoded := str(asset["base64"])
		if len(encoded) > 45*1024*1024 {
			return nil, fail(413, "单插件资源超过32MiB")
		}
		bytes, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fail(400, "插件资源 base64 无效")
		}
		total += len(bytes)
		if len(bytes) > 32*1024*1024 || total > 64*1024*1024 {
			return nil, fail(413, "插件资源超过单项32MiB或合计64MiB")
		}
		digest := str(asset["sha256"])
		if !moduleRevision.MatchString(digest) || hash(bytes) != digest {
			return nil, fail(400, "插件资源 SHA256 校验失败")
		}
		mimeType := str(asset["mimeType"])
		if mimeType == "" {
			mimeType = mime.TypeByExtension(filepath.Ext(path))
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		if _, _, err = mime.ParseMediaType(mimeType); err != nil {
			return nil, fail(400, "插件资源 MIME 无效")
		}
		assets = append(assets, moduleAsset{path, mimeType, digest, bytes})
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].path < assets[j].path })
	metadata := []any{}
	for _, asset := range assets {
		metadata = append(metadata, object{"path": asset.path, "sha256": asset.sha256, "mimeType": asset.mimeType, "size": len(asset.bytes)})
	}
	manifest = asObject(clone(manifest))
	delete(manifest, "revision")
	delete(manifest, "url")
	manifest["assets"] = metadata
	seed, _ := json.Marshal(object{"source": source, "manifest": manifest})
	revision := hash(seed)
	manifest["revision"] = revision
	manifest["url"] = "/api/nodes/modules/" + name + "/" + revision + "/index.js"
	staging, err := os.MkdirTemp(directory, ".nodeInstall")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	if err = atomicWrite(filepath.Join(staging, "index.js"), []byte(source), true, 0600); err != nil {
		return nil, err
	}
	for _, asset := range assets {
		path, err := workspacePath(staging, asset.path, true)
		if err != nil {
			return nil, err
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
		if err = atomicWrite(path, asset.bytes, true, 0600); err != nil {
			return nil, err
		}
	}
	data, _ := json.Marshal(manifest)
	if err = atomicWrite(filepath.Join(staging, "manifest.json"), data, true, 0600); err != nil {
		return nil, err
	}
	versions, err := workspacePath(directory, name, true)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(versions, 0700); err != nil {
		return nil, err
	}
	target := filepath.Join(versions, revision)
	if info, e := os.Lstat(target); e == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, fail(403, "已有插件版本目录无效")
		}
		previous, e := os.ReadFile(filepath.Join(target, "manifest.json"))
		if e != nil || string(previous) != string(data) {
			return nil, fail(409, "同修订插件内容不一致，保留原版本")
		}
	} else if os.IsNotExist(e) {
		if err = os.Rename(staging, target); err != nil {
			return nil, err
		}
	} else {
		return nil, e
	}
	// 最后发布入口；此前失败保留旧版本，已发布版本目录不再覆盖。
	if err = atomicWrite(pointer, data, !force, 0600); err != nil {
		return nil, err
	}
	return manifest, nil
}
func (s *server) serveNodeModule(w http.ResponseWriter, r *http.Request) error {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/api/nodes/modules/"), "/", 3)
	if len(parts) != 3 || !pluginName.MatchString(parts[0]) || !moduleRevision.MatchString(parts[1]) {
		return fail(400, "插件模块版本路径无效")
	}
	name, revision, relative := parts[0], parts[1], parts[2]
	directory := filepath.Join(s.dataDirectory, "nodes")
	if _, err := os.Stat(filepath.Join(directory, name+".disabled")); err == nil {
		return fail(404, "插件已禁用")
	}
	root := filepath.Join(directory, name, revision)
	actual, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	if actual != root {
		return fail(403, "插件版本目录不能是符号链接")
	}
	path, err := workspacePath(root, relative, false)
	if err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fail(403, "插件资源必须是普通文件")
	}
	mimeType := ""
	if relative == "index.js" || strings.HasSuffix(relative, ".js") || strings.HasSuffix(relative, ".mjs") {
		mimeType = "text/javascript; charset=utf-8"
	} else {
		data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
		if err != nil {
			return err
		}
		var manifest object
		if err = json.Unmarshal(data, &manifest); err != nil {
			return err
		}
		for _, raw := range array(manifest["assets"]) {
			asset := asObject(raw)
			if str(asset["path"]) == relative {
				mimeType = str(asset["mimeType"])
				break
			}
		}
	}
	if mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, path)
	return nil
}
