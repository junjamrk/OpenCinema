package main

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var pluginName = regexp.MustCompile(`^[a-z][a-zA-Z0-9]{0,95}$`)

func builtinNodes() []any {
	nodes := []any{}
	for _, item := range [][2]string{{"textNode", "文本"}, {"imageNode", "图片"}, {"videoNode", "视频"}, {"audioNode", "音频"}, {"imageGenerationNode", "图片生成"}, {"videoGenerationNode", "视频生成"}, {"audioGenerationNode", "音频生成"}, {"frameAnalysisNode", "视频分析"}, {"mediaInfoNode", "媒体信息"}, {"blockoutNode", "Blockout"}, {"director3dNode", "3D 导演"}, {"motionAnalysisNode", "Motion"}, {"videoDepthNode", "视频深度白模"}, {"collaborationExtension", "协作"}} {
		scope := "node"
		if item[0] == "collaborationExtension" {
			scope = "workspace"
		}
		nodes = append(nodes, object{"name": item[0], "displayName": item[1], "id": item[0], "scope": scope, "version": "2.0.0", "apiVersion": 1, "renderer": "react", "builtin": true, "enabled": true, "config": object{}, "configRules": []any{}, "canConfigure": true, "loadError": ""})
	}
	return nodes
}
func (s *server) nodeList() ([]any, error) {
	nodes := builtinNodes()
	directory := filepath.Join(s.dataDirectory, "nodes")
	entries, err := os.ReadDir(directory)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	s.configMu.Lock()
	configs := asObject(clone(s.config["nodeConfigs"]))
	s.configMu.Unlock()
	for _, raw := range nodes {
		node := asObject(raw)
		name := str(node["name"])
		if _, err = os.Stat(filepath.Join(directory, name+".disabled")); err == nil {
			node["enabled"] = false
		}
		if configs[name] != nil {
			node["config"] = configs[name]
		}
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".json")
		if !pluginName.MatchString(name) {
			continue
		}
		bytes, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, err
		}
		var manifest object
		if err = json.Unmarshal(bytes, &manifest); err != nil {
			manifest = object{"loadError": "插件 manifest JSON 无效"}
		}
		manifest["name"] = name
		builtinIndex := -1
		for i, existing := range nodes {
			if str(asObject(existing)["id"]) == name && boolean(asObject(existing)["builtin"]) {
				builtinIndex = i
				break
			}
		}
		manifest["builtin"] = builtinIndex >= 0
		manifest["installed"] = true
		manifest["enabled"] = true
		if _, err = os.Stat(filepath.Join(directory, name+".disabled")); err == nil {
			manifest["enabled"] = false
		}
		scriptPath := filepath.Join(directory, name+".js")
		if revision := str(manifest["revision"]); moduleRevision.MatchString(revision) {
			scriptPath = filepath.Join(directory, name, revision, "index.js")
			manifest["url"] = "/api/nodes/modules/" + name + "/" + revision + "/index.js"
		}
		script, scriptErr := os.ReadFile(scriptPath)
		if scriptErr != nil {
			manifest["loadError"] = "插件 ESM 文件无法读取"
		} else if !moduleRevision.MatchString(str(manifest["revision"])) {
			manifest["revision"] = hash(script)
		}
		if !strings.Contains(str(manifest["url"]), "/modules/") {
			manifest["url"] = "/api/nodes/files?name=" + name + "&revision=" + str(manifest["revision"])
		}
		manifest["config"] = configs[name]
		manifest["canConfigure"] = true
		if builtinIndex >= 0 {
			nodes[builtinIndex] = manifest
		} else {
			nodes = append(nodes, manifest)
		}
	}
	for _, raw := range nodes {
		node := asObject(raw)
		node["configRevision"] = nodeConfigRevision(node["config"])
	}
	return nodes, nil
}
func nodeConfigRevision(config any) string {
	data, _ := json.Marshal(asObject(config))
	return hash(data)
}
func (s *server) nodesRoute(w http.ResponseWriter, r *http.Request) error {
	operation := strings.TrimPrefix(r.URL.Path, "/api/nodes/")
	if strings.HasPrefix(operation, "modules/") {
		return s.serveNodeModule(w, r)
	}
	if operation == "package" {
		return s.nodePackage(w, r)
	}
	if operation == "capabilities" {
		success(w, object{"workspaceReadRange": 1, "collaboration": 1, "pluginApiVersion": 1, "renderer": "react", "runtime": "go"})
		return nil
	}
	if operation == "get" {
		nodes, err := s.nodeList()
		if err != nil {
			return err
		}
		if !s.localRequest(r) {
			for _, raw := range nodes {
				node := asObject(raw)
				node["config"] = object{}
				node["canConfigure"] = false
			}
		}
		success(w, nodes)
		return nil
	}
	if operation == "files" {
		name := r.URL.Query().Get("name")
		if !pluginName.MatchString(name) {
			return fail(400, "插件名称无效")
		}
		directory := filepath.Join(s.dataDirectory, "nodes")
		if _, err := os.Stat(filepath.Join(directory, name+".disabled")); err == nil {
			return fail(404, "插件已禁用")
		}
		path := filepath.Join(directory, name+".js")
		if data, err := os.ReadFile(filepath.Join(directory, name+".json")); err == nil {
			var manifest object
			if json.Unmarshal(data, &manifest) == nil && moduleRevision.MatchString(str(manifest["revision"])) {
				path = filepath.Join(directory, name, str(manifest["revision"]), "index.js")
			}
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fail(403, "插件必须是普通文件")
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, path)
		return nil
	}
	if !s.localRequest(r) {
		return fail(403, "仅本机工作台可以管理插件")
	}
	v, err := decode(r)
	if err != nil {
		return err
	}
	name := str(v["name"])
	directory := filepath.Join(s.dataDirectory, "nodes")
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if operation == "install" {
		name = str(v["fileName"])
		name = strings.TrimSuffix(strings.TrimSuffix(name, ".js"), ".json")
		if name == "" {
			name = str(asObject(v["manifest"])["id"])
		}
		if !pluginName.MatchString(name) {
			return fail(400, "插件文件名无效，使用小驼峰 .js")
		}
		for _, builtin := range builtinNodes() {
			if str(asObject(builtin)["id"]) == name {
				if !boolean(v["force"]) || !boolean(v["replaceBuiltin"]) {
					return fail(403, "更新内置插件需本机明确 force:true 和 replaceBuiltin:true")
				}
			}
		}
		source := str(v["source"])
		if sourceURL := str(v["url"]); sourceURL != "" {
			request, err := http.NewRequestWithContext(r.Context(), "GET", sourceURL, nil)
			if err != nil {
				return err
			}
			response, err := safeClient().Do(request)
			if err != nil {
				return err
			}
			data, err := io.ReadAll(io.LimitReader(response.Body, 20*1024*1024+1))
			_ = response.Body.Close()
			if err != nil {
				return err
			}
			if response.StatusCode != 200 {
				return fail(502, "插件下载失败")
			}
			source = string(data)
		}
		if len(source) == 0 || len(source) > 20*1024*1024 {
			return fail(400, "插件源码为空或超过20MiB")
		}
		manifest := asObject(v["manifest"])
		if str(manifest["id"]) != name {
			return fail(400, "manifest.id 必须与插件文件名一致")
		}
		if number(manifest["apiVersion"]) != 1 || str(manifest["renderer"]) != "react" {
			return fail(400, "插件需声明 apiVersion:1 与 renderer:react 的 ESM manifest")
		}
		if manifest["scope"] == nil {
			manifest["scope"] = "node"
		}
		if scope := str(manifest["scope"]); scope != "node" && scope != "workspace" {
			return fail(400, "插件 scope 只能为 node 或 workspace")
		}
		for _, builtin := range builtinNodes() {
			if item := asObject(builtin); str(item["id"]) == name && item["scope"] != manifest["scope"] {
				return fail(400, "内置插件更新不能改变原有 scope")
			}
		}
		if !strings.Contains(source, "export") {
			return fail(400, "插件必须是 ESM 模块")
		}
		installed, err := s.installNodeModule(name, source, manifest, v)
		if err != nil {
			return err
		}
		success(w, installed)
		return nil
	}
	if !pluginName.MatchString(name) {
		return fail(400, "插件名称无效")
	}
	switch operation {
	case "setEnabled":
		if _, ok := v["enabled"].(bool); !ok {
			return fail(400, "enabled 必须为布尔值")
		}
		marker := filepath.Join(directory, name+".disabled")
		if boolean(v["enabled"]) {
			if err = os.Remove(marker); err != nil && !os.IsNotExist(err) {
				return err
			}
		} else {
			if err = atomicWrite(marker, []byte{}, false, 0600); err != nil {
				return err
			}
		}
		success(w, object{"name": name, "enabled": v["enabled"]})
	case "save":
		config, ok := v["config"].(map[string]any)
		if !ok {
			return fail(400, "节点配置必须是对象")
		}
		s.configMu.Lock()
		configs := asObject(s.config["nodeConfigs"])
		if str(v["expectedRevision"]) == "" {
			s.configMu.Unlock()
			return fail(400, "节点配置保存须提供读取到的expectedRevision")
		}
		if nodeConfigRevision(configs[name]) != str(v["expectedRevision"]) {
			s.configMu.Unlock()
			return stale("节点配置已变化，请重新读取configRevision；未覆盖配置")
		}
		previous := clone(configs[name])
		configs[name] = config
		s.config["nodeConfigs"] = configs
		err = s.persistConfig()
		if err != nil {
			configs[name] = previous
		}
		s.configMu.Unlock()
		if err != nil {
			return err
		}
		success(w, object{"config": config, "configRevision": nodeConfigRevision(config)})
	case "uninstall":
		release, err := s.lockFiles(filepath.Join(directory, name+".json"), filepath.Join(directory, name))
		if err != nil {
			return err
		}
		defer release()
		for _, builtin := range builtinNodes() {
			if str(asObject(builtin)["id"]) == name {
				if !boolean(v["restoreBuiltin"]) {
					return fail(403, "恢复内置版本需明确 restoreBuiltin:true，不能删除内置能力")
				}
			}
		}
		for _, suffix := range []string{".js", ".json", ".disabled"} {
			if err = os.Remove(filepath.Join(directory, name+suffix)); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err = os.RemoveAll(filepath.Join(directory, name)); err != nil {
			return err
		}
		success(w, nil)
	default:
		return fail(404, "节点插件接口不存在")
	}
	return nil
}
func (s *server) assetsRoute(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	operation := strings.TrimPrefix(r.URL.Path, "/api/assets/")
	method := map[string]string{"stat": "GET", "read": "GET", "list": "GET", "save": "PUT", "mkdir": "POST", "remove": "DELETE", "rename": "POST"}[operation]
	if method == "" {
		return fail(404, "素材库接口不存在")
	}
	if r.Method != method && !(operation == "read" && r.Method == "HEAD") {
		allow := method
		if operation == "read" {
			allow = "GET, HEAD"
		}
		w.Header().Set("Allow", allow)
		return fail(405, "HTTP 方法不支持")
	}
	directory := filepath.Join(s.dataDirectory, "assets")
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	var input object
	var err error
	if r.Method == "GET" || r.Method == "HEAD" || r.Method == "PUT" {
		input = object{"path": r.URL.Query().Get("path")}
	} else {
		input, err = decode(r)
		if err != nil {
			return err
		}
	}
	if operation == "list" && str(input["path"]) == "" {
		input["path"] = "."
	}
	if len(str(input["path"])) == 0 {
		return fail(400, "请提供素材路径")
	}
	path, err := workspacePath(directory, str(input["path"]), false)
	if err != nil {
		return err
	}
	if path == directory && operation != "list" {
		return fail(400, "只能操作素材库内的文件或文件夹")
	}
	switch operation {
	case "stat":
		release, err := s.lockFiles(path)
		if err != nil {
			return err
		}
		defer release()
		revision, err := fileSnapshotRevision(path)
		if err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		kind := "file"
		if info.IsDir() {
			kind = "directory"
		}
		success(w, object{"path": input["path"], "type": kind, "size": info.Size(), "fileRevision": revision, "revisionScope": map[bool]string{true: "directory subtree metadata", false: "file content sha256"}[info.IsDir()]})
	case "read":
		release, err := s.lockFiles(path)
		if err != nil {
			return err
		}
		defer release()
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fail(400, "只能读取普通素材文件")
		}
		if info.Size() > 100*1024*1024 {
			return fail(413, "素材超过100MiB")
		}
		revision, err := fileSnapshotRevision(path)
		if err != nil {
			return err
		}
		if expected := r.URL.Query().Get("revision"); expected != "" && expected != revision {
			return stale("素材源已变化，请重新读取fileRevision")
		}
		w.Header().Set("X-Toonflow-File-Revision", revision)
		http.ServeFile(w, r, path)
	case "save":
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/octet-stream" {
			return fail(400, "请发送文件原始内容")
		}
		content, err := io.ReadAll(io.LimitReader(r.Body, 100*1024*1024+1))
		if err != nil {
			return err
		}
		if len(content) > 100*1024*1024 {
			return fail(413, "素材超过100MiB")
		}
		release, err := s.lockFiles(path)
		if err != nil {
			return err
		}
		defer release()
		// ACT: 与旧素材保存入口一致，只新建；避免旧插件未传 exclusive 时覆盖同名素材。
		if err = atomicWrite(path, content, true, 0600); err != nil {
			return err
		}
		success(w, nil)
	case "mkdir":
		release, err := s.lockFiles(path)
		if err != nil {
			return err
		}
		defer release()
		if err = os.Mkdir(path, 0755); err != nil {
			return err
		}
		success(w, nil)
	case "remove":
		if boolean(input["recursive"]) {
			return fail(400, "素材库只允许删除普通文件或空文件夹")
		}
		release, err := s.lockFiles(path)
		if err != nil {
			return err
		}
		defer release()
		if _, err = requireFileRevision(path, object{"path": input["path"], "fileRevision": input["expectedRevision"]}); err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return fail(400, "只能删除普通素材文件或空文件夹")
		}
		err = os.Remove(path)
		if err != nil {
			return err
		}
		success(w, nil)
	case "rename":
		if len(str(input["target"])) == 0 {
			return fail(400, "请提供目标素材路径")
		}
		target, err := workspacePath(directory, str(input["target"]), false)
		if err != nil {
			return err
		}
		if target == directory {
			return fail(400, "不能覆盖素材库根目录")
		}
		release, err := s.lockFiles(path, target)
		if err != nil {
			return err
		}
		defer release()
		if _, err = requireFileRevision(path, object{"path": input["path"], "fileRevision": input["expectedRevision"]}); err != nil {
			return err
		}
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return fail(400, "只能移动普通素材文件或文件夹")
		}
		if info.IsDir() && path != target && within(path, target) {
			return fail(400, "不能把素材文件夹移动到自身子目录")
		}
		if _, err = os.Lstat(target); !os.IsNotExist(err) {
			if err == nil {
				return &apiError{409, "目标已存在", "EEXIST"}
			}
			return err
		}
		if err = os.Rename(path, target); err != nil {
			return err
		}
		success(w, nil)
	case "list":
		release, err := s.lockFiles(path)
		if err != nil {
			return err
		}
		defer release()
		recursive := r.URL.Query().Get("recursive") != "false"
		var visit func(string) ([]any, error)
		visit = func(current string) ([]any, error) {
			entries := []any{}
			items, err := os.ReadDir(current)
			if err != nil {
				return nil, err
			}
			for _, entry := range items {
				if !entry.IsDir() && !entry.Type().IsRegular() {
					continue
				}
				relative, _ := filepath.Rel(directory, filepath.Join(current, entry.Name()))
				kind := "file"
				if entry.IsDir() {
					kind = "directory"
				}
				item := object{"name": entry.Name(), "path": filepath.ToSlash(relative), "type": kind}
				if recursive && entry.IsDir() {
					children, err := visit(filepath.Join(current, entry.Name()))
					if err != nil {
						return nil, err
					}
					item["children"] = children
				}
				entries = append(entries, item)
			}
			return entries, nil
		}
		entries, err := visit(path)
		if err != nil {
			return err
		}
		success(w, object{"entries": entries})
	default:
		return fail(404, "素材库接口不存在")
	}
	return nil
}
