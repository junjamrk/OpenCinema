package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const widgetChunkSize = 256 * 1024

type widgetGrant struct {
	directory, canvasID string
	expires             time.Time
	connections         map[string]bool
	hostRequests        map[string]bool
	requests            map[string]context.CancelFunc
}
type widgetStreamRead struct {
	bytes []byte
	err   error
}
type widgetStream struct {
	mu       sync.Mutex
	session  string
	reader   io.ReadCloser
	cancel   context.CancelFunc
	expires  time.Time
	cursor   int
	previous object
	pending  chan widgetStreamRead
}
type widgetUpload struct {
	session  string
	file     *os.File
	size     int64
	cursor   int
	previous string
	expires  time.Time
}
type widgetRuntime struct {
	mu         sync.Mutex
	contents   []any
	tools      []any
	renderMeta object
	grants     map[string]*widgetGrant
	streams    map[string]*widgetStream
	uploads    map[string]*widgetUpload
}

func (s *server) loadWidget(path string) error {
	s.widget = &widgetRuntime{grants: map[string]*widgetGrant{}, streams: map[string]*widgetStream{}, uploads: map[string]*widgetUpload{}}
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, 64*1024*1024+1))
	if err != nil {
		return err
	}
	if len(bytes) > 64*1024*1024 {
		return fmt.Errorf("Widget 资源目录超过64MiB")
	}
	var catalog object
	if err = json.Unmarshal(bytes, &catalog); err != nil {
		return err
	}
	contents, tools := array(catalog["contents"]), array(catalog["tools"])
	if len(contents) == 0 || len(contents) > 16 || len(tools) > 300 {
		return fmt.Errorf("Widget 资源或工具目录无效")
	}
	seen := map[string]bool{}
	for _, raw := range contents {
		item := asObject(raw)
		uri := str(item["uri"])
		if !strings.HasPrefix(uri, "ui://") || seen[uri] || str(item["text"]) == "" || !strings.HasPrefix(str(item["mimeType"]), "text/html") {
			return fmt.Errorf("Widget HTML 资源无效")
		}
		seen[uri] = true
	}
	seen = map[string]bool{}
	for _, raw := range tools {
		tool := asObject(raw)
		name := str(tool["name"])
		if name == "" || len(name) > 128 || seen[name] || str(tool["description"]) == "" || asObject(tool["inputSchema"])["type"] != "object" {
			return fmt.Errorf("Widget 工具目录无效")
		}
		seen[name] = true
	}
	s.widget.contents, s.widget.tools = contents, tools
	s.widget.renderMeta = asObject(catalog["renderToolMeta"])
	return nil
}
func (s *server) widgetTools() []any {
	if s.widget == nil || len(s.widget.contents) == 0 {
		return nil
	}
	uri := str(asObject(s.widget.contents[0])["uri"])
	meta := object{"ui": object{"resourceUri": uri}, "ui/resourceUri": uri, "openai/outputTemplate": uri, "openai/widgetAccessible": true}
	for key, value := range s.widget.renderMeta {
		meta[key] = value
	}
	render := object{"name": "renderOpenCinema", "title": "打开 OpenCinema", "description": "在宿主内打开已有工程的原生 OpenCinema 创作工作台；目录必须为明确绝对路径，不新建或导入工程。", "inputSchema": object{"type": "object", "properties": object{"directory": object{"type": "string", "minLength": 1, "maxLength": 4096}, "canvasId": object{"type": "string", "minLength": 1, "maxLength": 256}}, "required": []string{"directory"}, "additionalProperties": false}, "_meta": meta, "annotations": object{"readOnlyHint": true, "openWorldHint": false}}
	transport := object{"name": "openCinemaTransport", "title": "OpenCinema 界面通信", "description": "仅供原生工作台访问其授权工程；响应仅交给界面。", "inputSchema": object{"type": "object", "properties": object{"session": object{"type": "string", "pattern": "^[A-Za-z0-9_-]{43}$"}, "action": object{"type": "string", "enum": []string{"request", "poll", "cancel", "close", "upload"}}, "request": object{"type": "object"}, "streamId": object{"type": "string"}, "uploadId": object{"type": "string"}, "chunkBase64": object{"type": "string", "maxLength": 349528}, "cursor": object{"type": "integer", "minimum": 0}}, "required": []string{"session", "action"}, "additionalProperties": false}, "_meta": object{"ui": object{"visibility": []string{"app"}}}, "annotations": object{"openWorldHint": false}}
	result := []any{render, transport}
	for _, raw := range s.widget.tools {
		tool := asObject(clone(raw))
		schema, _ := json.Marshal(tool["inputSchema"])
		// 根引用仍指向原始 args，不能指向外层 target 包装。
		schema = []byte(strings.ReplaceAll(string(schema), `"$ref":"#`, `"$ref":"#/properties/args`))
		var args any
		if json.Unmarshal(schema, &args) != nil {
			continue
		}
		tool["inputSchema"] = wrapSchema(args)
		result = append(result, tool)
	}
	return result
}
func (s *server) widgetResourceList() []any {
	result := []any{}
	if s.widget == nil {
		return result
	}
	for _, raw := range s.widget.contents {
		item := asObject(raw)
		resource := object{"uri": item["uri"], "name": "OpenCinema", "title": "OpenCinema 原生创作工作台", "mimeType": item["mimeType"]}
		if item["_meta"] != nil {
			resource["_meta"] = item["_meta"]
		}
		result = append(result, resource)
	}
	return result
}
func (s *server) readWidgetResource(uri string) (object, error) {
	if s.widget != nil {
		for _, raw := range s.widget.contents {
			if str(asObject(raw)["uri"]) == uri {
				return object{"contents": []any{raw}}, nil
			}
		}
	}
	return nil, fail(404, "原生工作台资源不存在")
}
func (s *server) renderWidget(input object) (object, error) {
	if s.widget == nil || len(s.widget.contents) == 0 {
		return nil, fail(424, "此发行包没有原生工作台资源")
	}
	for key := range input {
		if key != "directory" && key != "canvasId" {
			return nil, fail(400, "打开工作台包含未知字段")
		}
	}
	origin, err := url.Parse(s.appOrigin)
	if err != nil || !net.ParseIP(origin.Hostname()).IsLoopback() {
		return nil, fail(403, "原生工作台只能连接同一本机 Go 实例")
	}
	directory := str(input["directory"])
	if !filepath.IsAbs(directory) || len(directory) > 4096 {
		return nil, fail(400, "请提供已有工程的绝对目录")
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(directory)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || !s.local && !within(filepath.Join(s.dataDirectory, "workspaces"), directory) {
		return nil, fail(403, "此工程目录未获授权")
	}
	canvas := str(input["canvasId"])
	if raw, exists := input["canvasId"]; exists && (canvas == "" || len(canvas) > 256 || raw != canvas) {
		return nil, fail(400, "画布标识无效")
	}
	if canvas != "" {
		path, err := workspacePath(directory, canvas, false)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || !strings.HasSuffix(canvas, ".json") {
			return nil, fail(400, "目标画布不是 JSON 文件")
		}
	}
	s.cleanWidgetStreams()
	token := sessionToken()
	s.widget.mu.Lock()
	defer s.widget.mu.Unlock()
	if len(s.widget.grants) >= 128 {
		return nil, fail(429, "原生工作台打开请求过多")
	}
	s.widget.grants[hash([]byte(token))] = &widgetGrant{directory: directory, canvasID: canvas, expires: time.Now().Add(24 * time.Hour), connections: map[string]bool{}, hostRequests: map[string]bool{}, requests: map[string]context.CancelFunc{}}
	var canvasID any
	if canvas != "" {
		canvasID = canvas
	}
	return object{"content": []any{object{"type": "text", "text": "OpenCinema 原生工作台已准备；请在界面确认工程与连接状态。"}}, "structuredContent": object{"directory": directory, "canvasId": canvasID}, "_meta": object{"openCinema": object{"session": token, "directory": directory, "canvasId": canvasID}}}, nil
}
func (s *server) widgetGrant(session string) (*widgetGrant, string, error) {
	if len(session) != 43 {
		return nil, "", fail(401, "原生工作台授权无效")
	}
	key := hash([]byte(session))
	if s.widget == nil {
		return nil, "", fail(401, "原生工作台未启用")
	}
	s.widget.mu.Lock()
	defer s.widget.mu.Unlock()
	grant := s.widget.grants[key]
	if grant == nil || time.Now().After(grant.expires) || !boolean(asObject(s.settings()["mcp"])["enabled"]) {
		return nil, "", fail(401, "原生工作台会话已失效，请保留工程并重新打开")
	}
	return grant, key, nil
}
func (s *server) closeWidgetGrant(key string) {
	if s.widget == nil {
		return
	}
	s.widget.mu.Lock()
	defer s.widget.mu.Unlock()
	if grant := s.widget.grants[key]; grant != nil {
		for _, cancel := range grant.requests {
			cancel()
		}
		delete(s.widget.grants, key)
	}
	for id, stream := range s.widget.streams {
		if stream.session == key {
			stream.cancel()
			_ = stream.reader.Close()
			delete(s.widget.streams, id)
		}
	}
	for id, upload := range s.widget.uploads {
		if upload.session == key {
			_ = upload.file.Close()
			_ = os.Remove(upload.file.Name())
			delete(s.widget.uploads, id)
		}
	}
}
func (s *server) cleanWidgetStreams() {
	if s.widget == nil {
		return
	}
	now := time.Now()
	s.widget.mu.Lock()
	expired := []string{}
	for key, grant := range s.widget.grants {
		if !grant.expires.After(now) {
			expired = append(expired, key)
		}
	}
	for id, stream := range s.widget.streams {
		if !stream.expires.After(now) {
			stream.cancel()
			_ = stream.reader.Close()
			delete(s.widget.streams, id)
		}
	}
	for id, upload := range s.widget.uploads {
		if !upload.expires.After(now) {
			_ = upload.file.Close()
			_ = os.Remove(upload.file.Name())
			delete(s.widget.uploads, id)
		}
	}
	s.widget.mu.Unlock()
	for _, key := range expired {
		s.closeWidgetGrant(key)
	}
}
func (s *server) closeWidgets() {
	if s.widget == nil {
		return
	}
	s.widget.mu.Lock()
	keys := []string{}
	for key := range s.widget.grants {
		keys = append(keys, key)
	}
	s.widget.mu.Unlock()
	for _, key := range keys {
		s.closeWidgetGrant(key)
	}
}
