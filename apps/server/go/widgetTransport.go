package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

var widgetRoutes = map[string]string{
	"GET":    "workspaces/check workspaces/browse workspaces/exportProject workspaces/files/list workspaces/files/stat workspaces/files/read workspaces/files/range settings/get settings/general nodes/capabilities nodes/files nodes/package nodes/get assets/list assets/read assets/stat ai/media/models ai/media/referenceBindings ai/media/balanceEvents providers/media/list providers/media/catalog providers/media/configuration ffmpeg/status ffmpeg/configuration ffmpeg/events ffmpeg/progress mcp/status mcp/control/events host/state collaboration/document media/referenceDepth/modelStatus media/localConnection/get",
	"POST":   "workspaces/clone workspaces/createFolder nodes/rollback workspaces/restoreProject workspaces/exportProject workspaces/files/copy workspaces/files/importImage workspaces/files/mkdir workspaces/files/rename assets/mkdir assets/rename nodes/install nodes/setEnabled ai/media/generate ai/media/referenceBindings ai/media/price ai/media/balance ai/media/tasks/status ai/media/tasks/cancel providers/media/add providers/media/validate providers/media/models ffmpeg/download ffmpeg/cancel ffmpeg/execute mcp/control/state mcp/control/result host/requests/create host/requests/status host/requests/cancel collaboration/open collaboration/session collaboration/invite collaboration/revoke collaboration/command collaboration/edit collaboration/undo collaboration/redo collaboration/close media/referenceDepth/prepareModel media/referenceDepth/cancelModelPreparation media/referenceDepth/start media/referenceDepth/status media/referenceDepth/cancel media/localConnection/inspect",
	"PUT":    "settings/save settings/general workspaces/files/write assets/save nodes/save nodes/setEnabled providers/media/save providers/media/configuration ffmpeg/configuration media/localConnection/save",
	"DELETE": "workspaces/files/remove assets/remove nodes/uninstall providers/media/delete",
	"HEAD":   "assets/read",
}
var widgetModulePath = regexp.MustCompile(`^/api/nodes/modules/[a-z][a-zA-Z0-9]*/[a-f0-9]{64}/[a-zA-Z0-9_./-]+$`)

func widgetRouteAllowed(method, path string) bool {
	if method == "GET" && widgetModulePath.MatchString(path) {
		for _, part := range strings.Split(path, "/") {
			if part == "." || part == ".." {
				return false
			}
		}
		return true
	}
	for _, item := range strings.Fields(widgetRoutes[method]) {
		if "/api/"+item == path {
			return true
		}
	}
	return false
}
func widgetBytes(encoded string, limit int) ([]byte, error) {
	if len(encoded) > (limit+2)/3*4 {
		return nil, fail(413, "界面分片超过大小限制")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) > limit {
		return nil, fail(400, "界面分片不是有效的 Base64 字节")
	}
	return data, nil
}
func (s *server) widgetTransport(ctx context.Context, input object) (object, error) {
	for key := range input {
		if key != "session" && key != "action" && key != "request" && key != "streamId" && key != "uploadId" && key != "chunkBase64" && key != "cursor" {
			return nil, fail(400, "界面通信包含未知字段")
		}
	}
	grant, key, err := s.widgetGrant(str(input["session"]))
	if err != nil {
		return nil, err
	}
	var result object
	switch str(input["action"]) {
	case "request":
		result, err = s.widgetRequest(ctx, grant, key, asObject(input["request"]))
	case "upload":
		result, err = s.widgetUpload(key, input)
	case "poll":
		result, err = s.pollWidget(ctx, key, input)
	case "cancel":
		result, err = s.cancelWidget(key, input)
	case "close":
		s.closeWidgetGrant(key)
		result = object{"done": true, "bodyBase64": "", "cursor": 0}
	default:
		err = fail(400, "界面通信 action 无效")
	}
	if err != nil {
		return nil, err
	}
	return object{"content": []any{object{"type": "text", "text": "OpenCinema 界面请求已处理。"}}, "_meta": object{"openCinemaResponse": result}}, nil
}
func (s *server) widgetUpload(session string, input object) (object, error) {
	cursor, ok := input["cursor"].(float64)
	if !ok || cursor < 0 || cursor != float64(int(cursor)) {
		return nil, fail(400, "上传游标无效")
	}
	encoded, ok := input["chunkBase64"].(string)
	if !ok {
		return nil, fail(400, "上传分片缺失")
	}
	data, err := widgetBytes(encoded, widgetChunkSize)
	if err != nil {
		return nil, err
	}
	s.cleanWidgetStreams()
	s.widget.mu.Lock()
	defer s.widget.mu.Unlock()
	id := str(input["uploadId"])
	upload := s.widget.uploads[id]
	if upload == nil {
		if id != "" || cursor != 0 || len(s.widget.uploads) >= 16 {
			return nil, fail(409, "上传会话不存在或数量过多")
		}
		file, err := os.CreateTemp(s.dataDirectory, ".widgetUpload")
		if err != nil {
			return nil, err
		}
		id = randomID()
		upload = &widgetUpload{session: session, file: file}
		s.widget.uploads[id] = upload
	}
	if upload.session != session {
		return nil, fail(403, "上传不属于当前工作台")
	}
	digest := hash(data)
	if int(cursor) == upload.cursor-1 && digest == upload.previous {
		return object{"uploadId": id, "cursor": upload.cursor, "bodyBase64": "", "done": false}, nil
	}
	if int(cursor) != upload.cursor {
		return nil, fail(409, "上传分片位置无效")
	}
	if upload.size+int64(len(data)) > 2*1024*1024*1024 {
		_ = upload.file.Close()
		_ = os.Remove(upload.file.Name())
		delete(s.widget.uploads, id)
		return nil, fail(413, "上传不能超过2GiB")
	}
	if _, err = upload.file.Write(data); err != nil {
		_ = upload.file.Close()
		_ = os.Remove(upload.file.Name())
		delete(s.widget.uploads, id)
		return nil, err
	}
	upload.size += int64(len(data))
	upload.cursor++
	upload.previous = digest
	upload.expires = time.Now().Add(90 * time.Second)
	return object{"uploadId": id, "cursor": upload.cursor, "bodyBase64": "", "done": false}, nil
}
func (s *server) cancelWidget(session string, input object) (object, error) {
	s.widget.mu.Lock()
	defer s.widget.mu.Unlock()
	if id := str(input["uploadId"]); id != "" {
		upload := s.widget.uploads[id]
		if upload == nil || upload.session != session {
			return nil, fail(404, "上传会话无效")
		}
		_ = upload.file.Close()
		_ = os.Remove(upload.file.Name())
		delete(s.widget.uploads, id)
	} else {
		id := str(input["streamId"])
		stream := s.widget.streams[id]
		if stream == nil || stream.session != session {
			return nil, fail(404, "界面数据流无效")
		}
		stream.cancel()
		_ = stream.reader.Close()
		delete(s.widget.streams, id)
	}
	return object{"bodyBase64": "", "done": true, "cursor": 0}, nil
}
func (s *server) pollWidget(ctx context.Context, session string, input object) (object, error) {
	id := str(input["streamId"])
	cursor, ok := input["cursor"].(float64)
	if !ok || cursor < 0 || cursor != float64(int(cursor)) {
		return nil, fail(400, "读取游标无效")
	}
	s.widget.mu.Lock()
	stream := s.widget.streams[id]
	if stream != nil && stream.session == session {
		stream.expires = time.Now().Add(90 * time.Second)
	}
	s.widget.mu.Unlock()
	if stream == nil || stream.session != session {
		return nil, fail(404, "界面数据流不存在或已结束")
	}
	if !stream.mu.TryLock() {
		return nil, fail(409, "界面数据流正在读取")
	}
	defer stream.mu.Unlock()
	if stream.previous != nil && int(cursor) == stream.cursor-1 {
		return stream.previous, nil
	}
	if int(cursor) != stream.cursor || stream.previous != nil && boolean(stream.previous["done"]) {
		return nil, fail(409, "数据流位置无效，请保留工程")
	}
	if stream.pending == nil {
		stream.pending = make(chan widgetStreamRead, 1)
		pending := stream.pending
		go func() {
			buffer := make([]byte, widgetChunkSize)
			n, err := stream.reader.Read(buffer)
			pending <- widgetStreamRead{buffer[:n], err}
		}()
	}
	timer := time.NewTimer(25 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		_, _ = s.cancelWidget(session, object{"streamId": id})
		return nil, ctx.Err()
	case <-timer.C:
		return object{"bodyBase64": "", "done": false, "cursor": stream.cursor}, nil
	case value := <-stream.pending:
		stream.pending = nil
		if value.err != nil && value.err != io.EOF {
			_, _ = s.cancelWidget(session, object{"streamId": id})
			return nil, fail(502, "本机响应读取中断，请保留工程；未自动重试")
		}
		done := value.err == io.EOF
		stream.cursor++
		stream.previous = object{"bodyBase64": base64.StdEncoding.EncodeToString(value.bytes), "done": done, "cursor": stream.cursor}
		if done {
			_ = stream.reader.Close()
			stream.cancel()
		}
		return stream.previous, nil
	}
}

func (s *server) bindWidgetHostRequest(grant *widgetGrant, path string, data object) error {
	if data == nil {
		return fail(400, "宿主请求必须是 JSON 对象")
	}
	id := str(data["requestId"])
	create := path == "/api/host/requests/create"
	if id != "" && !uuidValue.MatchString(id) || !create && id == "" {
		return fail(400, "宿主请求标识无效")
	}
	if create {
		context := asObject(data["context"])
		for _, field := range []string{"workspaceId", "directory"} {
			if value, exists := context[field]; exists && value != grant.directory {
				return fail(403, "宿主请求不属于此工程")
			}
		}
		context["workspaceId"] = grant.directory
		data["context"] = context
	}
	if id == "" {
		return nil
	}
	hostMu.Lock()
	defer hostMu.Unlock()
	s.widget.mu.Lock()
	defer s.widget.mu.Unlock()
	request, own := hostRequests[id], grant.hostRequests[id]
	if request != nil && request.directory != grant.directory {
		// ACT: 仅本页已发出、尚未登记的取消墓碑可以没有目录；own 不能覆盖已有跨工程归属。
		if request.directory != "" || !own || request.input != nil || request.status != "cancelled" {
			return fail(403, "宿主请求不属于此工作台")
		}
	}
	if create {
		if !own && len(grant.hostRequests) >= 1000 {
			return fail(429, "此工作台宿主请求过多")
		}
		grant.hostRequests[id] = true
	} else if request == nil && !own {
		return fail(403, "宿主请求不属于此工作台")
	}
	return nil
}

func (s *server) bindWidgetRequest(grant *widgetGrant, key string, u *url.URL, method string, data object, headers http.Header) error {
	query := u.Query()
	for _, directory := range query["directory"] {
		if directory != grant.directory {
			return fail(403, "界面不能访问其他工作区")
		}
	}
	if value, exists := data["directory"]; exists && value != grant.directory {
		return fail(403, "界面正文不属于授权工程")
	}
	path := u.Path
	workspace := strings.HasPrefix(path, "/api/workspaces/")
	needsDirectory := workspace || path == "/api/ffmpeg/execute" || path == "/api/ai/media/generate" || path == "/api/ai/media/referenceBindings" || path == "/api/ai/media/price" || strings.HasPrefix(path, "/api/ai/media/tasks/") || path == "/api/collaboration/open" || strings.HasPrefix(path, "/api/media/referenceDepth/") || path == "/api/host/state"
	if needsDirectory {
		queryDirectory := method == "GET" || method == "HEAD" || path == "/api/workspaces/files/write" || path == "/api/workspaces/restoreProject"
		if queryDirectory {
			query.Set("directory", grant.directory)
		} else {
			if data == nil {
				return fail(400, "此工作区请求必须使用 JSON 对象")
			}
			data["directory"] = grant.directory
		}
	}
	if strings.HasPrefix(path, "/api/collaboration/") && path != "/api/collaboration/open" {
		id := str(data["roomId"])
		if id == "" {
			id = query.Get("roomId")
		}
		s.roomsMu.Lock()
		room := s.rooms[id]
		belongs := room != nil && room.Directory == grant.directory
		s.roomsMu.Unlock()
		if !belongs {
			return fail(403, "协作房间不属于此工程")
		}
	}
	if strings.HasPrefix(path, "/api/host/requests/") {
		if err := s.bindWidgetHostRequest(grant, path, data); err != nil {
			return err
		}
	}
	if strings.HasPrefix(path, "/api/mcp/control/") {
		id := str(data["connectionId"])
		if id == "" {
			id = query.Get("connectionId")
		}
		if !uuidValue.MatchString(id) {
			return fail(400, "工作台连接标识无效")
		}
		s.widget.mu.Lock()
		if strings.HasSuffix(path, "/events") {
			s.controlMu.Lock()
			exists := s.connections[id] != nil
			s.controlMu.Unlock()
			if exists || grant.connections[id] {
				s.widget.mu.Unlock()
				return fail(409, "控制连接已存在")
			}
			grant.connections[id] = true
		} else if !grant.connections[id] {
			s.widget.mu.Unlock()
			return fail(403, "控制连接不属于此工作台")
		}
		s.widget.mu.Unlock()
		if state, exists := data["state"]; exists {
			value, ok := state.(map[string]any)
			if !ok {
				return fail(400, "控制状态不是对象")
			}
			if directory := value["directory"]; directory != nil && directory != grant.directory {
				return fail(403, "控制状态不属于此工程")
			}
			if canvas := value["canvasId"]; grant.canvasID != "" && canvas != nil && canvas != grant.canvasID {
				return fail(403, "控制状态不属于授权画布")
			}
		}
	}
	if path == "/api/settings/save" {
		settings, ok := data["settings"].(map[string]any)
		if !ok {
			return fail(400, "设置必须为 JSON 对象")
		}
		settings["mcp"] = s.settings()["mcp"]
	}
	u.RawQuery = query.Encode()
	return nil
}

func (s *server) widgetRequest(ctx context.Context, grant *widgetGrant, key string, input object) (object, error) {
	for field := range input {
		if field != "method" && field != "path" && field != "headers" && field != "bodyBase64" && field != "bodyId" {
			return nil, fail(400, "界面请求包含未知字段")
		}
	}
	method, path := str(input["method"]), str(input["path"])
	if len(path) > 16384 || !strings.HasPrefix(path, "/api/") || strings.ContainsAny(path, "\\#\r\n") {
		return nil, fail(400, "界面请求路径无效")
	}
	u, err := url.Parse(path)
	if err != nil || u.IsAbs() || u.Host != "" || u.RawPath != "" || !widgetRouteAllowed(method, u.Path) {
		return nil, fail(403, "界面没有此应用接口的授权")
	}
	headers := http.Header{}
	allowedHeaders := map[string]bool{"accept": true, "accept-language": true, "content-type": true, "range": true, "if-range": true, "last-event-id": true, "x-toonflow-collaboration": true}
	for field, raw := range asObject(input["headers"]) {
		value, ok := raw.(string)
		if !ok || len(field) > 128 || len(value) > 16384 || strings.ContainsAny(value, "\r\n") {
			return nil, fail(400, "界面请求头无效")
		}
		if allowedHeaders[strings.ToLower(field)] {
			headers.Set(field, value)
		}
	}
	headers.Set("Origin", s.appOrigin)
	headers.Set("Referer", s.appOrigin+"/")
	headers.Set("X-Toonflow-Workspace", "1")
	headers.Set("Authorization", "Bearer "+str(asObject(s.settings()["mcp"])["token"]))
	var body io.Reader
	var bodyLength int64
	var upload *widgetUpload
	if id := str(input["bodyId"]); id != "" {
		if input["bodyBase64"] != nil {
			return nil, fail(400, "请求正文不能重复提供")
		}
		s.widget.mu.Lock()
		upload = s.widget.uploads[id]
		if upload != nil && upload.session == key {
			delete(s.widget.uploads, id)
		}
		s.widget.mu.Unlock()
		if upload == nil || upload.session != key {
			return nil, fail(403, "上传正文不属于当前工作台")
		}
		defer func() { _ = upload.file.Close(); _ = os.Remove(upload.file.Name()) }()
		if _, err = upload.file.Seek(0, 0); err != nil {
			return nil, err
		}
		body, bodyLength = upload.file, upload.size
	} else if raw, exists := input["bodyBase64"]; exists {
		encoded, ok := raw.(string)
		if !ok {
			return nil, fail(400, "请求正文编码无效")
		}
		data, err := widgetBytes(encoded, widgetChunkSize)
		if err != nil {
			return nil, err
		}
		body, bodyLength = bytes.NewReader(data), int64(len(data))
	}
	if body != nil && (method == "GET" || method == "HEAD") {
		return nil, fail(400, "读取请求不能包含正文")
	}
	var data object
	if body != nil && strings.EqualFold(strings.TrimSpace(strings.Split(headers.Get("Content-Type"), ";")[0]), "application/json") {
		if bodyLength > 128*1024*1024 {
			return nil, fail(413, "JSON 界面正文超过128MiB")
		}
		decoder := json.NewDecoder(body)
		if err = decoder.Decode(&data); err != nil || data == nil {
			return nil, fail(400, "界面请求正文不是 JSON 对象")
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			return nil, fail(400, "界面 JSON 正文存在额外内容")
		}
	}
	if err = s.bindWidgetRequest(grant, key, u, method, data, headers); err != nil {
		return nil, err
	}
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			return nil, err
		}
		body, bodyLength = bytes.NewReader(encoded), int64(len(encoded))
	}
	s.cleanWidgetStreams()
	requestID := randomID()
	requestContext, cancel := context.WithCancel(context.Background())
	stop := context.AfterFunc(ctx, cancel)
	s.widget.mu.Lock()
	if s.widget.grants[key] != grant {
		s.widget.mu.Unlock()
		stop()
		cancel()
		return nil, fail(401, "原生工作台已关闭")
	}
	active := len(grant.requests)
	totalActive := len(s.widget.streams)
	for _, current := range s.widget.grants {
		totalActive += len(current.requests)
	}
	for _, stream := range s.widget.streams {
		if stream.session == key {
			active++
		}
	}
	if active >= 32 || totalActive >= 256 {
		s.widget.mu.Unlock()
		stop()
		cancel()
		return nil, fail(429, "界面数据流过多，请关闭未使用视图")
	}
	grant.requests[requestID] = cancel
	s.widget.mu.Unlock()
	keep := false
	defer func() {
		stop()
		s.widget.mu.Lock()
		delete(grant.requests, requestID)
		s.widget.mu.Unlock()
		if !keep {
			cancel()
		}
	}()
	request, err := http.NewRequestWithContext(requestContext, method, s.appOrigin+u.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header, request.ContentLength = headers, bodyLength
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("原生工作台禁止重定向") }, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true, DisableCompression: true, ResponseHeaderTimeout: 120 * time.Second}}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nil, fail(502, "本机请求失败，请保留工程；未自动重试")
	}
	if response.StatusCode >= 300 && response.StatusCode < 400 && response.StatusCode != 304 {
		_ = response.Body.Close()
		return nil, fail(403, "原生工作台不跟随重定向")
	}
	if ctx.Err() != nil {
		_ = response.Body.Close()
		return nil, ctx.Err()
	}
	allowedResponse := map[string]bool{"content-type": true, "content-length": true, "content-range": true, "content-disposition": true, "accept-ranges": true, "etag": true, "last-modified": true, "cache-control": true, "x-toonflow-file-revision": true}
	responseHeaders := object{}
	for field, values := range response.Header {
		if allowedResponse[strings.ToLower(field)] {
			responseHeaders[strings.ToLower(field)] = strings.Join(values, ", ")
		}
	}
	result := object{"status": response.StatusCode, "statusText": http.StatusText(response.StatusCode), "headers": responseHeaders, "bodyBase64": "", "done": false, "cursor": 0}
	filteredJSON := u.Path == "/api/settings/get" || u.Path == "/api/host/requests/create" || u.Path == "/api/mcp/status"
	if filteredJSON {
		defer response.Body.Close()
		bytes, err := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024+1))
		if err != nil || len(bytes) > 16*1024*1024 {
			return nil, fail(502, "界面设置响应超过大小限制")
		}
		var value object
		if err = json.Unmarshal(bytes, &value); err != nil {
			return nil, fail(502, "界面设置响应无效")
		}
		if u.Path == "/api/settings/get" {
			delete(asObject(value["data"]), "mcp")
		}
		if u.Path == "/api/mcp/status" {
			connections := []any{}
			s.widget.mu.Lock()
			for _, raw := range array(asObject(value["data"])["connections"]) {
				if grant.connections[str(asObject(raw)["id"])] {
					connections = append(connections, raw)
				}
			}
			s.widget.mu.Unlock()
			asObject(value["data"])["connections"] = connections
		}
		if u.Path == "/api/host/requests/create" {
			if id := str(asObject(value["data"])["requestId"]); id != "" {
				s.widget.mu.Lock()
				grant.hostRequests[id] = true
				s.widget.mu.Unlock()
			}
		}
		bytes, err = json.Marshal(value)
		if err != nil {
			return nil, err
		}
		delete(responseHeaders, "content-length")
		if len(bytes) <= widgetChunkSize {
			result["bodyBase64"], result["done"] = base64.StdEncoding.EncodeToString(bytes), true
			return result, nil
		}
		response.Body = io.NopCloser(strings.NewReader(string(bytes)))
	}
	if method == "HEAD" || response.StatusCode == 204 || response.StatusCode == 205 || response.StatusCode == 304 {
		_ = response.Body.Close()
		result["done"] = true
		return result, nil
	}
	if response.ContentLength >= 0 && response.ContentLength <= widgetChunkSize && !filteredJSON {
		defer response.Body.Close()
		bytes, err := io.ReadAll(io.LimitReader(response.Body, widgetChunkSize+1))
		if err != nil || len(bytes) > widgetChunkSize || int64(len(bytes)) != response.ContentLength {
			return nil, fail(502, "本机响应长度无效")
		}
		result["bodyBase64"], result["done"] = base64.StdEncoding.EncodeToString(bytes), true
		return result, nil
	}
	id := randomID()
	s.widget.mu.Lock()
	if s.widget.grants[key] != grant {
		s.widget.mu.Unlock()
		_ = response.Body.Close()
		return nil, fail(401, "原生工作台已关闭")
	}
	s.widget.streams[id] = &widgetStream{session: key, reader: response.Body, cancel: cancel, expires: time.Now().Add(90 * time.Second)}
	s.widget.mu.Unlock()
	keep = true
	result["streamId"] = id
	return result, nil
}
