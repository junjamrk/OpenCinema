package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

func workspaceFileSchema() object {
	path := object{"type": "string", "maxLength": 4096, "description": "工作区内相对路径，不接受绝对路径、..或符号链接。"}
	revision := object{"type": "string", "pattern": "^[a-f0-9]{64}$", "description": "readText/readBinary/stat返回的fileRevision；不能用documentRevision代替。"}
	variants := []any{}
	add := func(action string, properties object, required ...string) {
		properties["action"], properties["path"] = object{"const": action}, path
		variant := object{"type": "object", "properties": properties, "required": append([]string{"action", "path"}, required...), "additionalProperties": false}
		if action == "writeText" || action == "writeBinary" {
			variant["if"] = object{"properties": object{"exclusive": object{"const": false}}, "required": []string{"exclusive"}}
			variant["then"] = object{"required": []string{"fileRevision"}}
		}
		variants = append(variants, variant)
	}
	add("list", object{"cursor": object{"type": "string", "maxLength": 8192}, "limit": object{"type": "integer", "minimum": 1, "maximum": 200, "default": 100}})
	add("stat", object{})
	add("readText", object{"offset": object{"type": "integer", "minimum": 0, "description": "解码成UTF-8后的字节偏移；续读使用nextOffset。"}, "maxBytes": object{"type": "integer", "minimum": 1, "maximum": 8192, "default": 8192}, "fileRevision": revision})
	add("readBinary", object{"fileRevision": revision})
	add("mkdir", object{})
	add("importMedia", object{"sourcePath": object{"type": "string", "minLength": 1, "maxLength": 4096, "description": "本机明确指定的已有媒体绝对路径；只复制≤100MiB可识别媒体，目标path排他新建，不上传远端。"}}, "sourcePath")
	add("remove", object{"recursive": object{"type": "boolean", "default": false}, "fileRevision": revision}, "fileRevision")
	add("rename", object{"target": path, "fileRevision": revision}, "target", "fileRevision")
	for _, action := range []string{"writeText", "writeBinary"} {
		field := "text"
		if action == "writeBinary" {
			field = "base64"
		}
		add(action, object{field: object{"type": "string", "maxLength": 28 * 1024 * 1024}, "exclusive": object{"type": "boolean", "default": true}, "fileRevision": revision}, field)
	}
	return object{"type": "object", "oneOf": variants}
}
func mcpFileAndOperationTools() []any {
	id := object{"type": "string", "format": "uuid"}
	return []any{
		object{"name": "readWorkspaceImage", "description": "真正读取授权工作区图片或插件已导出的关键帧，返回MCP image内容和fileRevision。默认thumbnail≤1024px，original≤4MiB；PNG/JPEG/GIF，源图≤20MiB/32MP。不得将base64文字当作看见图像。", "inputSchema": wrapSchema(object{"type": "object", "properties": object{"path": object{"type": "string", "minLength": 1, "maxLength": 4096}, "fileRevision": object{"type": "string", "pattern": "^[a-f0-9]{64}$"}, "mode": object{"type": "string", "enum": []string{"thumbnail", "original"}, "default": "thumbnail"}, "maxDimension": object{"type": "integer", "minimum": 64, "maximum": 2048, "default": 1024}}, "required": []string{"path"}, "additionalProperties": false})},
		object{"name": "getOperation", "description": "按原operationId查询冻结目标、状态、结果或错误。记录持久化且不自动重放；重启后未收尾为unknown。保留最多10000条，满时拒绝新写入。", "inputSchema": wrapSchema(object{"type": "object", "properties": object{"operationId": id}, "required": []string{"operationId"}, "additionalProperties": false})},
		object{"name": "cancelOperation", "description": "请求停止原operationId的等待与React控制调用。cancelRequested不等于执行停止，已派发后保留unknown；专业后台任务仍须调用节点公布的cancel并查询真实状态。", "inputSchema": wrapSchema(object{"type": "object", "properties": object{"operationId": id}, "required": []string{"operationId"}, "additionalProperties": false})},
	}
}
func (s *server) mcpFileRoot(target object) (string, error) {
	directory := str(target["directory"])
	s.controlMu.Lock()
	if id := str(target["connectionId"]); id != "" {
		c := s.connections[id]
		if c == nil {
			s.controlMu.Unlock()
			return "", fail(409, "目标页面已断开；读取离线文件须仅使用明确directory")
		}
		if directory != "" && directory != str(c.state["directory"]) {
			s.controlMu.Unlock()
			return "", stale("工作区已切换")
		}
		if canvas := str(target["canvasId"]); canvas != "" && canvas != str(c.state["canvasId"]) {
			s.controlMu.Unlock()
			return "", stale("画布已切换")
		}
		directory = str(c.state["directory"])
	} else if directory == "" {
		for _, c := range s.connections {
			if directory != "" {
				s.controlMu.Unlock()
				return "", fail(409, "多个工作台需要明确target")
			}
			directory = str(c.state["directory"])
		}
	}
	s.controlMu.Unlock()
	if !filepath.IsAbs(directory) {
		return "", fail(400, "请指定target.directory绝对工作目录")
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
		return "", fail(400, "工作区必须是目录")
	}
	if !s.local && !within(filepath.Join(s.dataDirectory, "workspaces"), root) {
		return "", fail(403, "只能访问服务器工作区")
	}
	return root, nil
}
func fileSnapshotRevision(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if info.Mode().IsRegular() {
		return hashFile(context.Background(), path)
	}
	if !info.IsDir() {
		return "", fail(403, "只支持普通文件或目录")
	}
	var snapshot strings.Builder
	count := 0
	err = filepath.WalkDir(path, func(child string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		count++
		if count > 100000 {
			return fail(413, "目录超过100000项，缩小操作范围")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fail(403, "不能操作包含符号链接的目录")
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		relative, _ := filepath.Rel(path, child)
		fmt.Fprintf(&snapshot, "%q:%d:%d:%d\n", relative, info.Size(), info.ModTime().UnixNano(), info.Mode())
		return nil
	})
	return hash([]byte(snapshot.String())), err
}
func requireFileRevision(path string, args object) (string, error) {
	actual, err := fileSnapshotRevision(path)
	if err != nil {
		return "", err
	}
	if str(args["fileRevision"]) == "" {
		return "", toolFailure("revisionRequired", "先读取目标fileRevision", "validation", "notDispatched", object{"path": args["path"]}, "readState")
	}
	if actual != str(args["fileRevision"]) {
		e := toolFailure("revisionConflict", "文件已变化，未执行操作", "target", "notDispatched", object{"path": args["path"]}, "readState").(*mcpCallError)
		e.details["actualRevision"], e.details["expectedRevision"] = actual, args["fileRevision"]
		return "", e
	}
	return actual, nil
}
func validateFileArgs(args object) error {
	action := str(args["action"])
	allowed := map[string]string{"list": "cursor limit", "stat": "", "readText": "fileRevision offset maxBytes", "readBinary": "fileRevision", "mkdir": "", "importMedia": "sourcePath", "remove": "recursive fileRevision", "rename": "target fileRevision", "writeText": "text exclusive fileRevision", "writeBinary": "base64 exclusive fileRevision"}
	extra, ok := allowed[action]
	if !ok {
		return fail(400, "未知文件action")
	}
	keys := " action path " + extra + " "
	for key := range args {
		if !strings.Contains(keys, " "+key+" ") {
			return fail(400, "文件action包含未知字段: "+key)
		}
	}
	if _, ok := args["path"].(string); !ok {
		return fail(400, "path必须是相对路径字符串")
	}
	for _, field := range []string{"recursive", "exclusive"} {
		if raw, exists := args[field]; exists {
			if _, ok := raw.(bool); !ok {
				return fail(400, field+"必须是boolean")
			}
		}
	}
	for _, field := range []string{"cursor", "fileRevision", "target", "text", "base64", "sourcePath"} {
		if raw, exists := args[field]; exists {
			if _, ok := raw.(string); !ok {
				return fail(400, field+"必须是string")
			}
		}
	}
	if action == "writeText" || action == "writeBinary" {
		field := "text"
		if action == "writeBinary" {
			field = "base64"
		}
		if _, exists := args[field]; !exists {
			return fail(400, field+"必填")
		}
	}
	return nil
}
func boundedInteger(args object, name string, fallback, low, high int) (int, error) {
	raw, exists := args[name]
	if !exists {
		return fallback, nil
	}
	n, ok := raw.(float64)
	if !ok || n != float64(int(n)) || n < float64(low) || n > float64(high) {
		return 0, fail(400, name+"超出整数范围")
	}
	return int(n), nil
}
func (s *server) mcpFiles(target, args object) (any, error) {
	if err := validateFileArgs(args); err != nil {
		return nil, err
	}
	root, err := s.mcpFileRoot(target)
	if err != nil {
		return nil, err
	}
	path, err := workspacePath(root, str(args["path"]), false)
	if err != nil {
		return nil, err
	}
	action := str(args["action"])
	if action == "list" {
		limit, err := boundedInteger(args, "limit", 100, 1, 200)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return nil, err
		}
		items := []any{}
		for _, entry := range entries {
			if !entry.IsDir() && !entry.Type().IsRegular() {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return nil, err
			}
			kind := "file"
			if entry.IsDir() {
				kind = "directory"
			}
			items = append(items, object{"name": entry.Name(), "path": filepath.ToSlash(filepath.Join(str(args["path"]), entry.Name())), "type": kind, "size": info.Size(), "modifiedAt": info.ModTime().UnixNano()})
		}
		data, _ := json.Marshal(items)
		queryRevision := hash(data)
		offset := 0
		if cursor := str(args["cursor"]); cursor != "" {
			data, e := base64.RawURLEncoding.DecodeString(cursor)
			var c object
			if e != nil || json.Unmarshal(data, &c) != nil || str(c["path"]) != str(args["path"]) || str(c["queryRevision"]) != queryRevision || str(c["directory"]) != root {
				return nil, stale("文件列表游标已失效，请从首页重新读取")
			}
			offset, err = boundedInteger(c, "offset", 0, 0, len(items))
			if err != nil {
				return nil, err
			}
		}
		page := []any{}
		next := offset
		for next < len(items) && len(page) < limit {
			candidate, _ := json.Marshal(append(page, items[next]))
			if len(candidate) > 60*1024 {
				break
			}
			page = append(page, items[next])
			next++
		}
		result := object{"directory": root, "path": args["path"], "entries": page, "total": len(items), "hasMore": next < len(items), "queryRevision": queryRevision}
		if next < len(items) {
			cursor, _ := json.Marshal(object{"directory": root, "path": args["path"], "offset": next, "queryRevision": queryRevision})
			result["nextCursor"] = base64.RawURLEncoding.EncodeToString(cursor)
		}
		return result, nil
	}
	if action == "stat" {
		revision, err := fileSnapshotRevision(path)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		return object{"directory": root, "path": args["path"], "size": info.Size(), "isDirectory": info.IsDir(), "fileRevision": revision}, nil
	}
	if action == "readBinary" || action == "readText" {
		data, err := readBoundedFile(path, 20*1024*1024)
		if err != nil {
			return nil, err
		}
		revision := hash(data)
		if expected := str(args["fileRevision"]); expected != "" && expected != revision {
			return nil, stale("文件已变化，请重新读取")
		}
		result := object{"directory": root, "path": args["path"], "fileRevision": revision, "size": len(data)}
		if action == "readBinary" {
			result["base64"] = base64.StdEncoding.EncodeToString(data)
			return result, nil
		}
		text, encoding, err := decodeText(data)
		if err != nil {
			return nil, err
		}
		offset, err := boundedInteger(args, "offset", 0, 0, len(text))
		if err != nil {
			return nil, err
		}
		limit, err := boundedInteger(args, "maxBytes", 8192, 1, 8192)
		if err != nil {
			return nil, err
		}
		if offset < len(text) && !utf8.RuneStart(text[offset]) {
			return nil, fail(400, "offset必须位于UTF-8字符边界")
		}
		end := min(offset+limit, len(text))
		for end > offset && end < len(text) && !utf8.RuneStart(text[end]) {
			end--
		}
		if end == offset && end < len(text) {
			_, width := utf8.DecodeRuneInString(text[offset:])
			end += width
		}
		result["text"], result["encoding"], result["offset"], result["hasMore"] = text[offset:end], encoding, offset, end < len(text)
		if end < len(text) {
			result["nextOffset"] = end
		}
		return result, nil
	}
	if path == root {
		return nil, fail(400, "不能修改工作区根目录")
	}
	s.controlMu.Lock()
	for _, c := range s.connections {
		if str(c.state["directory"]) == root && within(path, filepath.Join(root, str(c.state["canvasId"]))) {
			s.controlMu.Unlock()
			return nil, fail(409, "画布正在工作台打开，请使用画布命令修改")
		}
	}
	s.controlMu.Unlock()
	destination := ""
	if action == "rename" {
		if str(args["target"]) == "" {
			return nil, fail(400, "rename.target必填")
		}
		destination, err = workspacePath(root, str(args["target"]), false)
		if err != nil {
			return nil, err
		}
	}
	paths := []string{path}
	if destination != "" {
		paths = append(paths, destination)
	}
	release, err := s.lockFiles(paths...)
	if err != nil {
		return nil, err
	}
	defer release()
	if err = s.protectCollaboration(root, str(args["path"])); err != nil {
		return nil, err
	}
	if destination != "" {
		if err = s.protectCollaboration(root, str(args["target"])); err != nil {
			return nil, err
		}
	}
	if action == "remove" || action == "rename" || (action == "writeText" || action == "writeBinary") && args["exclusive"] == false {
		if _, err = requireFileRevision(path, args); err != nil {
			return nil, err
		}
	}
	if err = protectCanvasFile(path); err != nil {
		return nil, err
	}
	switch action {
	case "importMedia":
		if !s.local {
			return nil, fail(403, "本机路径导入仅支持本机实例")
		}
		source := str(args["sourcePath"])
		if !filepath.IsAbs(source) || len(source) > 4096 {
			return nil, fail(400, "sourcePath必须是本机媒体绝对路径")
		}
		source, err = filepath.EvalSymlinks(source)
		if err != nil {
			return nil, err
		}
		if source == path {
			return nil, fail(400, "来源和目标不能相同")
		}
		_, _, err = atomicImportMedia(source, path)
	case "mkdir":
		err = os.Mkdir(path, 0755)
	case "remove":
		if boolean(args["recursive"]) {
			err = os.RemoveAll(path)
		} else {
			err = os.Remove(path)
		}
	case "rename":
		if _, e := os.Lstat(destination); !os.IsNotExist(e) {
			return nil, fail(409, "目标已存在或无法读取")
		}
		err = os.Rename(path, destination)
	case "writeText", "writeBinary":
		data := []byte(str(args["text"]))
		if action == "writeBinary" {
			data, err = base64.StdEncoding.DecodeString(str(args["base64"]))
			if err != nil {
				return nil, fail(400, "base64编码无效")
			}
		}
		if len(data) > 20*1024*1024 {
			return nil, fail(413, "文件超过20MiB")
		}
		var document object
		if json.Unmarshal(data, &document) == nil && document["toonflowCanvas"] != nil {
			return nil, fail(403, "画布文档必须通过现有画布命令创建与修改")
		}
		err = atomicWrite(path, data, args["exclusive"] != false, 0600)
	}
	if err != nil {
		return nil, err
	}
	result := object{"success": true, "directory": root, "path": args["path"], "saved": true}
	if action != "remove" {
		if destination != "" {
			path = destination
			result["path"] = args["target"]
		}
		revision, e := fileSnapshotRevision(path)
		if e != nil {
			return nil, toolFailure("resultUnavailable", "文件操作已发生，但修订回读失败；读取实际目标后再决定下一步", "result", "unknown", object{"directory": root, "path": result["path"]}, "readState")
		}
		result["fileRevision"] = revision
	}
	return result, nil
}
func protectCanvasFile(path string) error {
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return filepath.WalkDir(path, func(child string, entry os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if entry.IsDir() {
				return nil
			}
			return protectCanvasFile(child)
		})
	}
	if !strings.EqualFold(filepath.Ext(path), ".json") {
		return nil
	}
	data, err := readBoundedFile(path, 20*1024*1024)
	if err != nil {
		return err
	}
	var document object
	if json.Unmarshal(data, &document) == nil && document["toonflowCanvas"] != nil {
		return fail(403, "禁止直接修改画布JSON，请使用画布命令")
	}
	return nil
}
func readBoundedFile(path string, limit int64) ([]byte, error) {
	data, _, err := readBoundedSnapshot(path, limit)
	return data, err
}
func readBoundedSnapshot(path string, limit int64) ([]byte, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, nil, fail(413, "文件类型或大小超出本操作上限")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if int64(len(data)) > limit {
		return nil, nil, fail(413, "文件超过上限")
	}
	if err != nil {
		return nil, nil, err
	}
	after, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if fileRangeRevision(path, info) != fileRangeRevision(path, after) {
		return nil, nil, stale("读取期间文件已变化，请重新观察源素材")
	}
	return data, info, nil
}
func (s *server) readWorkspaceImage(target, args object) (any, error) {
	for key := range args {
		if key != "path" && key != "fileRevision" && key != "mode" && key != "maxDimension" {
			return nil, fail(400, "未知图片参数")
		}
	}
	for _, key := range []string{"path", "mode", "fileRevision"} {
		if raw, exists := args[key]; exists {
			if _, ok := raw.(string); !ok {
				return nil, fail(400, key+"必须是string")
			}
		}
	}
	if str(args["path"]) == "" {
		return nil, fail(400, "path必填")
	}
	root, err := s.mcpFileRoot(target)
	if err != nil {
		return nil, err
	}
	path, err := workspacePath(root, str(args["path"]), false)
	if err != nil {
		return nil, err
	}
	data, sourceInfo, err := readBoundedSnapshot(path, 20*1024*1024)
	if err != nil {
		return nil, err
	}
	revision := hash(data)
	if expected := str(args["fileRevision"]); expected != "" && expected != revision {
		return nil, stale("图片源已变化，请重新读取并更新选区")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fail(415, "仅支持PNG/JPEG/GIF；其他格式先用媒体工具导出PNG")
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 16384 || config.Height > 16384 || int64(config.Width)*int64(config.Height) > 32*1024*1024 {
		return nil, fail(413, "源图超过32MP或16384像素边长")
	}
	mode := str(args["mode"])
	if mode == "" {
		mode = "thumbnail"
	}
	if mode != "thumbnail" && mode != "original" {
		return nil, fail(400, "mode必须是thumbnail或original")
	}
	width, height := config.Width, config.Height
	mimeType := "image/" + format
	if mode == "thumbnail" {
		maximum, e := boundedInteger(args, "maxDimension", 1024, 64, 2048)
		if e != nil {
			return nil, e
		}
		if max(width, height) > maximum {
			source, _, e := image.Decode(bytes.NewReader(data))
			if e != nil {
				return nil, e
			}
			scale := float64(maximum) / float64(max(width, height))
			width = max(1, int(float64(width)*scale))
			height = max(1, int(float64(height)*scale))
			thumbnail := image.NewNRGBA(image.Rect(0, 0, width, height))
			bounds := source.Bounds()
			for y := 0; y < height; y++ {
				for x := 0; x < width; x++ {
					thumbnail.SetNRGBA(x, y, color.NRGBAModel.Convert(source.At(bounds.Min.X+x*config.Width/width, bounds.Min.Y+y*config.Height/height)).(color.NRGBA))
				}
			}
			var encoded bytes.Buffer
			if err = png.Encode(&encoded, thumbnail); err != nil {
				return nil, err
			}
			data = encoded.Bytes()
			mimeType = "image/png"
		}
	}
	if len(data) > 4*1024*1024 {
		return nil, fail(413, "图像内容超过4MiB，请使用thumbnail并降低maxDimension")
	}
	metadata := object{"directory": root, "path": args["path"], "fileRevision": revision, "sourceRevision": fileRangeRevision(path, sourceInfo), "mode": mode, "mimeType": mimeType, "sourceWidth": config.Width, "sourceHeight": config.Height, "width": width, "height": height, "bytes": len(data), "coordinateSpace": "source image pixels; scale thumbnail coordinates by sourceWidth/width and sourceHeight/height"}
	text, _ := json.Marshal(metadata)
	return object{"content": []any{object{"type": "text", "text": string(text)}, object{"type": "image", "data": base64.StdEncoding.EncodeToString(data), "mimeType": mimeType}}, "structuredContent": object{"result": metadata}}, nil
}
