package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type hostSession struct {
	id, name, directory string
	requests            []string
	leaseSeconds        int
	expires             time.Time
}
type hostRequest struct {
	id, sessionID, directory, status string
	input                            object
	result                           object
	created, touched                 time.Time
	cancelRequested                  bool
	revision                         uint64
	inputRevision                    string
}

var hostMu sync.Mutex
var hostSessions = map[string]*hostSession{}
var hostRequests = map[string]*hostRequest{}

func hostToolSchema(name string) object {
	identifier := object{"type": "string", "format": "uuid"}
	switch name {
	case "registerHost":
		return object{"type": "object", "properties": object{"name": object{"type": "string", "minLength": 1, "maxLength": 200}, "requests": object{"type": "array", "minItems": 1, "maxItems": 30, "uniqueItems": true, "items": object{"type": "string", "minLength": 1, "maxLength": 100}}, "directory": object{"type": "string", "maxLength": 4096}, "sessionId": identifier, "leaseSeconds": object{"type": "integer", "minimum": 60, "maximum": 900, "default": 60, "description": "新会话默认60秒；交互审批建议300秒。省略时已有会话沿用原时长，仍须定期轮询续租。"}}, "required": []string{"name", "requests"}, "additionalProperties": false}
	case "pollHostRequests":
		return object{"type": "object", "properties": object{"sessionId": identifier, "max": object{"type": "integer", "minimum": 1, "maximum": 20, "default": 10}, "cursor": object{"type": "string", "maxLength": 8192}}, "required": []string{"sessionId"}, "additionalProperties": false}
	case "getHostRequest":
		return object{"type": "object", "properties": object{"sessionId": identifier, "requestId": identifier, "section": object{"type": "string", "enum": []string{"input", "prompt", "context", "metadata", "result"}, "default": "input"}, "offset": object{"type": "integer", "minimum": 0, "default": 0}, "maxBytes": object{"type": "integer", "minimum": 1, "maximum": 8192, "default": 8192}, "inputRevision": object{"type": "string", "pattern": "^[a-f0-9]{64}$"}, "contentRevision": object{"type": "string", "pattern": "^[a-f0-9]{64}$"}}, "required": []string{"sessionId", "requestId"}, "additionalProperties": false}
	default:
		return object{"type": "object", "properties": object{"sessionId": identifier, "requestId": identifier, "status": object{"type": "string", "enum": []string{"running", "completed", "failed", "cancelled"}}, "text": object{"type": "string", "maxLength": 10000000}, "result": object{}, "error": object{"type": "string", "maxLength": 20000}, "progress": object{}}, "required": []string{"sessionId", "requestId", "status"}, "additionalProperties": false}
	}
}

func hostSessionState(session *hostSession) object {
	requests := make([]string, len(session.requests))
	copy(requests, session.requests)
	return object{"id": session.id, "name": session.name, "directory": session.directory, "leaseSeconds": session.leaseSeconds, "expiresAt": session.expires.UnixMilli(), "capabilities": object{"requests": requests, "context": true, "tools": true, "cancellation": true, "progress": true}}
}
func (session *hostSession) renew() {
	session.expires = time.Now().Add(time.Duration(session.leaseSeconds) * time.Second)
}
func hostRequestState(request *hostRequest) object {
	result := object{"requestId": request.id, "status": request.status, "cancelRequested": request.cancelRequested}
	for k, v := range request.result {
		result[k] = clone(v)
	}
	return result
}
func hostRequestHeader(request *hostRequest) object {
	return object{"requestId": request.id, "status": request.status, "cancelRequested": request.cancelRequested, "kind": request.input["kind"], "directory": request.directory, "createdAt": request.created.UnixMilli(), "inputRevision": request.inputRevision, "requestRevision": request.revision}
}
func hostMcpRequestState(request *hostRequest) object {
	result := hostRequestState(request)
	for key, value := range hostRequestHeader(request) {
		result[key] = value
	}
	data, _ := json.Marshal(result)
	if len(data) <= 64*1024 {
		return result
	}
	result = hostRequestHeader(request)
	result["resultOmitted"], result["readTool"] = true, "getHostRequest"
	return result
}
func hostPollRequests(session *hostSession, args object) (object, error) {
	maximum, err := boundedInteger(args, "max", 10, 1, 20)
	if err != nil {
		return nil, err
	}
	requests := []*hostRequest{}
	for _, request := range hostRequests {
		if request.sessionID == session.id && (request.status == "queued" || request.status == "running" || request.status == "cancelRequested") {
			requests = append(requests, request)
		}
	}
	sort.Slice(requests, func(i, j int) bool {
		if requests[i].created.Equal(requests[j].created) {
			return requests[i].id < requests[j].id
		}
		return requests[i].created.Before(requests[j].created)
	})
	identities := []any{session.id}
	for _, request := range requests {
		identities = append(identities, object{"requestId": request.id, "revision": request.revision})
	}
	encoded, _ := json.Marshal(identities)
	revision := hash(encoded)
	offset := 0
	if raw, exists := args["cursor"]; exists {
		cursor, ok := raw.(string)
		if !ok || len(cursor) > 8192 {
			return nil, fail(400, "cursor必须是8192字节以内字符串")
		}
		data, decodeErr := base64.RawURLEncoding.DecodeString(cursor)
		var page object
		if decodeErr != nil || json.Unmarshal(data, &page) != nil || str(page["sessionId"]) != session.id || str(page["queryRevision"]) != revision || number(page["max"]) != float64(maximum) {
			return nil, stale("宿主请求队列或查询参数已变化，请从首页重新轮询")
		}
		offset, err = boundedInteger(page, "offset", 0, 0, len(requests))
		if err != nil {
			return nil, err
		}
	}
	items := []any{}
	response := func(next int) object {
		result := object{"session": hostSessionState(session), "requests": items, "queryRevision": revision, "hasMore": next < len(requests), "total": len(requests)}
		if next < len(requests) {
			data, _ := json.Marshal(object{"sessionId": session.id, "queryRevision": revision, "offset": next, "max": maximum})
			result["nextCursor"] = base64.RawURLEncoding.EncodeToString(data)
		}
		return result
	}
	next := offset
	for next < len(requests) && len(items) < maximum {
		request := requests[next]
		item := hostRequestState(request)
		for key, value := range hostRequestHeader(request) {
			item[key] = value
		}
		for _, key := range []string{"kind", "prompt", "context", "metadata"} {
			if value, ok := request.input[key]; ok {
				item[key] = clone(value)
			}
		}
		data, _ := json.Marshal(item)
		if len(data) > 48*1024 {
			item = hostRequestHeader(request)
			item["inputOmitted"], item["resultOmitted"], item["readTool"] = true, true, "getHostRequest"
		}
		items = append(items, item)
		data, _ = json.Marshal(response(next + 1))
		if len(data) > 64*1024 {
			items = items[:len(items)-1]
			if len(items) > 0 {
				break
			}
			item = hostRequestHeader(request)
			item["inputOmitted"], item["resultOmitted"], item["readTool"] = true, true, "getHostRequest"
			items = append(items, item)
			data, _ = json.Marshal(response(next + 1))
			if len(data) > 64*1024 {
				return nil, fail(413, "宿主会话摘要超过64KiB，请缩小会话字段")
			}
		}
		next++
	}
	return response(next), nil
}
func hostReadRequest(session *hostSession, args object) (object, error) {
	request := hostRequests[str(args["requestId"])]
	if request == nil || request.sessionID != str(args["sessionId"]) {
		return nil, fail(404, "请求不存在或不属于此宿主会话")
	}
	section := "input"
	if raw, exists := args["section"]; exists {
		value, ok := raw.(string)
		if !ok {
			return nil, fail(400, "section必须是字符串")
		}
		section = value
	}
	var value any
	switch section {
	case "input":
		value = request.input
	case "prompt", "context", "metadata":
		value = request.input[section]
	case "result":
		value = request.result
	default:
		return nil, fail(400, "未知请求正文section")
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	revision := hash(data)
	for key, actual := range map[string]string{"inputRevision": request.inputRevision, "contentRevision": revision} {
		if raw, exists := args[key]; exists {
			expected, ok := raw.(string)
			if !ok || !moduleRevision.MatchString(expected) {
				return nil, fail(400, key+"必须是64位SHA-256字符串")
			}
			if expected != actual {
				return nil, stale("请求正文已变化，请从首段重新读取")
			}
		}
	}
	offset, err := boundedInteger(args, "offset", 0, 0, len(data))
	if err != nil {
		return nil, err
	}
	if offset > 0 && str(args["contentRevision"]) == "" {
		return nil, toolFailure("revisionRequired", "正文续读须携带contentRevision", "validation", "notDispatched", object{}, "readState")
	}
	maximum, err := boundedInteger(args, "maxBytes", 8192, 1, 8192)
	if err != nil {
		return nil, err
	}
	if offset < len(data) && !utf8.RuneStart(data[offset]) {
		return nil, fail(400, "offset须使用回执nextOffset，位于UTF-8字符边界")
	}
	end := min(offset+maximum, len(data))
	for end > offset && end < len(data) && !utf8.RuneStart(data[end]) {
		end--
	}
	if end == offset && end < len(data) {
		_, width := utf8.DecodeRune(data[offset:])
		end += width
	}
	var sessionState any
	if session != nil {
		sessionState = hostSessionState(session)
	}
	result := object{"session": sessionState, "leaseExpired": session == nil, "request": hostRequestHeader(request), "section": section, "encoding": "jsonUtf8", "content": string(data[offset:end]), "inputRevision": request.inputRevision, "contentRevision": revision, "offset": offset, "totalBytes": len(data), "hasMore": end < len(data)}
	if end < len(data) {
		result["nextOffset"] = end
	}
	encoded, _ := json.Marshal(result)
	if len(encoded) > 64*1024 {
		return nil, fail(413, "宿主请求分段超过64KiB")
	}
	return result, nil
}
func cleanupHosts() {
	now := time.Now()
	for id, session := range hostSessions {
		if now.After(session.expires) {
			delete(hostSessions, id)
			for _, request := range hostRequests {
				if request.sessionID == id && (request.status == "queued" || request.status == "running" || request.status == "cancelRequested") {
					request.status = "unknown"
					request.result = object{"error": "宿主 Agent 租约过期，不能确认远端是否仍在执行；请保留请求ID。"}
					request.revision++
				}
			}
		}
	}
	for id, request := range hostRequests {
		if request.input == nil && now.Sub(request.created) > 10*time.Minute {
			delete(hostRequests, id)
			continue
		}
		if now.Sub(request.touched) > 30*time.Minute && (request.status == "completed" || request.status == "failed" || request.status == "cancelled") {
			delete(hostRequests, id)
		}
	}
}
func (s *server) hostRoute(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	operation := strings.TrimPrefix(r.URL.Path, "/api/host/")
	hostMu.Lock()
	defer hostMu.Unlock()
	cleanupHosts()
	if operation == "state" {
		sessions := []any{}
		var selected any
		directory := r.URL.Query().Get("directory")
		for _, session := range hostSessions {
			if session.directory != "" && directory != "" && session.directory != directory {
				continue
			}
			item := hostSessionState(session)
			sessions = append(sessions, item)
			if selected == nil {
				selected = item
			}
		}
		success(w, object{"session": selected, "sessions": sessions})
		return nil
	}
	if r.Method != "POST" {
		return fail(405, "HTTP 方法不支持")
	}
	input, err := decode(r)
	if err != nil {
		return err
	}
	switch operation {
	case "requests/create":
		requestID := str(input["requestId"])
		if requestID != "" && !uuidValue.MatchString(requestID) {
			return fail(400, "requestId 必须为 UUID")
		}
		if requestID != "" {
			if existing := hostRequests[requestID]; existing != nil {
				if existing.input == nil && existing.status == "cancelled" {
					success(w, hostRequestState(existing))
					return nil
				}
				if existing.sessionID == str(input["sessionId"]) && reflect.DeepEqual(existing.input, input) {
					success(w, hostRequestState(existing))
					return nil
				}
				return fail(409, "请求ID已用于不同宿主或不同冻结请求")
			}
		}
		if len(hostRequests) >= 1000 {
			return fail(429, "宿主请求过多")
		}
		kind := str(input["kind"])
		prompt := str(input["prompt"])
		if kind == "" || len(kind) > 100 || strings.TrimSpace(prompt) == "" || len(prompt) > 100000 {
			return fail(400, "宿主请求类型或提示词无效")
		}
		sessionID := str(input["sessionId"])
		if sessionID == "" {
			return fail(400, "创建请求必须明确选择宿主 sessionId，不能静默切换 Agent")
		}
		context := asObject(input["context"])
		directory := str(context["workspaceId"])
		if directory == "" {
			directory = str(context["directory"])
		}
		if directory != "" {
			directory, err = s.workspace(r, directory)
			if err != nil {
				return err
			}
		}
		var session *hostSession
		if sessionID != "" {
			session = hostSessions[sessionID]
		} else {
			for _, candidate := range hostSessions {
				if candidate.directory != "" && candidate.directory != directory {
					continue
				}
				supported := false
				for _, allowed := range candidate.requests {
					if allowed == kind {
						supported = true
					}
				}
				if !supported {
					continue
				}
				if session != nil {
					return fail(409, "多个宿主 Agent 可处理此请求，请明确 sessionId")
				}
				session = candidate
			}
		}
		if session == nil {
			return fail(409, "没有可用宿主 Agent，请先通过 MCP registerHost 注册并保持轮询")
		}
		if session.directory != "" && session.directory != directory {
			return fail(403, "宿主会话未绑定此工作区")
		}
		supported := false
		for _, allowed := range session.requests {
			if kind == allowed {
				supported = true
			}
		}
		if !supported {
			return fail(400, "宿主未声明此请求能力")
		}
		bytes, _ := json.Marshal(input)
		if len(bytes) > 2*1024*1024 {
			return fail(413, "宿主上下文超过2MiB")
		}
		if requestID == "" {
			requestID = randomID()
		}
		request := &hostRequest{id: requestID, sessionID: session.id, directory: directory, status: "queued", input: asObject(clone(input)), result: object{}, created: time.Now(), touched: time.Now(), revision: 1, inputRevision: hash(bytes)}
		hostRequests[request.id] = request
		success(w, hostRequestState(request))
		return nil
	case "requests/status", "requests/cancel":
		request := hostRequests[str(input["requestId"])]
		if request == nil && operation == "requests/cancel" {
			id := str(input["requestId"])
			if !uuidValue.MatchString(id) {
				return fail(400, "requestId 必须为 UUID")
			}
			if len(hostRequests) >= 1000 {
				return fail(429, "宿主请求取消记录过多")
			}
			request = &hostRequest{id: id, status: "cancelled", cancelRequested: true, result: object{}, created: time.Now(), touched: time.Now(), revision: 1}
			hostRequests[id] = request
		}
		if request == nil {
			return fail(404, "宿主请求不存在或已过期")
		}
		request.touched = time.Now()
		if operation == "requests/cancel" && (request.status == "queued" || request.status == "running" || request.status == "cancelRequested") {
			if !request.cancelRequested {
				request.revision++
			}
			request.cancelRequested = true
			if request.status == "queued" {
				request.status = "cancelled"
			} else {
				request.status = "cancelRequested"
			}
		}
		success(w, hostRequestState(request))
		return nil
	}
	return fail(404, "宿主接口不存在")
}
func (s *server) hostMcp(name string, args object) (any, error) {
	hostMu.Lock()
	defer hostMu.Unlock()
	cleanupHosts()
	allowed := map[string]string{"registerHost": "name requests directory sessionId leaseSeconds", "pollHostRequests": "sessionId max cursor", "getHostRequest": "sessionId requestId section offset maxBytes inputRevision contentRevision", "completeHostRequest": "sessionId requestId status text result error progress"}
	fields, ok := allowed[name]
	if !ok {
		return nil, fail(400, "未知宿主工具")
	}
	for key := range args {
		if !strings.Contains(" "+fields+" ", " "+key+" ") {
			return nil, fail(400, "宿主工具包含未知字段: "+key)
		}
	}
	if raw, exists := args["sessionId"]; exists {
		value, ok := raw.(string)
		if !ok || !uuidValue.MatchString(value) {
			return nil, fail(400, "sessionId必须是UUID字符串")
		}
	}
	if name == "getHostRequest" || name == "completeHostRequest" {
		if !uuidValue.MatchString(str(args["requestId"])) {
			return nil, fail(400, "requestId必须是UUID字符串")
		}
	}
	if name == "registerHost" {
		name := strings.TrimSpace(str(args["name"]))
		requests := []string{}
		for _, raw := range array(args["requests"]) {
			kind := str(raw)
			if kind == "" || len(kind) > 100 {
				return nil, fail(400, "请求能力名称无效")
			}
			requests = append(requests, kind)
		}
		if name == "" || len(name) > 200 || len(requests) < 1 || len(requests) > 30 {
			return nil, fail(400, "宿主需声明名称及1至30项请求能力")
		}
		directory := str(args["directory"])
		if directory != "" {
			if !filepath.IsAbs(directory) {
				return nil, fail(400, "宿主工作区必须为绝对路径")
			}
			actual, err := filepath.EvalSymlinks(directory)
			if err != nil {
				return nil, err
			}
			directory = actual
			if !s.local && !within(filepath.Join(s.dataDirectory, "workspaces"), directory) {
				return nil, fail(403, "宿主只能绑定服务器工作区")
			}
		}
		id := str(args["sessionId"])
		session := hostSessions[id]
		if id != "" && session == nil {
			return nil, fail(404, "宿主会话已过期，请重新注册")
		}
		leaseSeconds := 60
		if session != nil {
			leaseSeconds = session.leaseSeconds
		}
		leaseSeconds, err := boundedInteger(args, "leaseSeconds", leaseSeconds, 60, 900)
		if err != nil {
			return nil, err
		}
		if session == nil {
			id = randomID()
			session = &hostSession{id: id}
			hostSessions[id] = session
		}
		session.name = name
		session.directory = directory
		session.requests = requests
		session.leaseSeconds = leaseSeconds
		session.renew()
		return hostSessionState(session), nil
	}
	session := hostSessions[str(args["sessionId"])]
	if name == "getHostRequest" {
		if session != nil {
			session.renew()
		}
		return hostReadRequest(session, args)
	}
	if session == nil {
		return nil, fail(404, "宿主会话已过期，请先 registerHost")
	}
	session.renew()
	if name == "pollHostRequests" {
		return hostPollRequests(session, args)
	}
	request := hostRequests[str(args["requestId"])]
	if request == nil || request.sessionID != session.id {
		return nil, fail(404, "请求不存在或不属于此宿主会话")
	}
	status := str(args["status"])
	if status != "running" && status != "completed" && status != "failed" && status != "cancelled" {
		return nil, fail(400, "宿主只能报告真实 running/completed/failed/cancelled 状态")
	}
	if request.status == "completed" || request.status == "failed" || request.status == "cancelled" {
		repeated := object{}
		for _, key := range []string{"text", "result", "error", "progress"} {
			if value, ok := args[key]; ok {
				repeated[key] = value
			}
		}
		if request.status == status && reflect.DeepEqual(request.result, repeated) {
			return hostMcpRequestState(request), nil
		}
		return nil, fail(409, "请求已结束，不能改变终态")
	}
	if request.cancelRequested && status == "completed" {
		return nil, fail(409, "请求已取消，不能发布为完成")
	}
	if request.status == "unknown" {
		return nil, fail(409, "请求租约失效，不能发布旧会话结果")
	}
	result := object{}
	for _, key := range []string{"text", "result", "error", "progress"} {
		if value, ok := args[key]; ok {
			result[key] = clone(value)
		}
	}
	bytes, _ := json.Marshal(result)
	if len(bytes) > 20*1024*1024 {
		return nil, fail(413, "宿主结果超过20MiB，请将媒体通过工作区文件接口保存后返回相对路径")
	}
	if !reflect.DeepEqual(request.result, result) || request.status != status {
		request.revision++
	}
	request.status = status
	request.result = result
	request.touched = time.Now()
	return hostMcpRequestState(request), nil
}
