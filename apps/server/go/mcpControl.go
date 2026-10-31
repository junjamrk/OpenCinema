package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

type controlResult struct {
	result  any
	err     string
	details object
}
type controlConnection struct {
	id           string
	state        object
	revision     float64
	events       chan any
	done         chan struct{}
	pending      map[string]chan controlResult
	operations   map[string]string
	toolPolicies map[string]bool
}

func (s *server) controlRoute(w http.ResponseWriter, r *http.Request) error {
	path := strings.TrimPrefix(r.URL.Path, "/api/mcp/")
	if path == "status" {
		if err := s.appRequest(r); err != nil {
			return err
		}
		success(w, object{"enabled": boolean(asObject(s.settings()["mcp"])["enabled"]), "transport": "streamable-http", "url": "/mcp", "connections": s.connectionList()})
		return nil
	}
	if !strings.HasPrefix(path, "control/") {
		return fail(404, "MCP 接口不存在")
	}
	if err := s.appRequest(r); err != nil {
		return err
	}
	if !s.authorizeMcp(r) {
		return fail(403, "MCP 未开启或访问凭证无效")
	}
	operation := strings.TrimPrefix(path, "control/")
	if operation == "events" {
		id := r.URL.Query().Get("connectionId")
		if len(id) != 36 {
			return fail(400, "connectionId 无效")
		}
		c := &controlConnection{id: id, state: object{"directory": nil, "canvasId": nil, "panel": "home", "projectList": []any{}, "tools": []any{}}, events: make(chan any, 16), done: make(chan struct{}), pending: map[string]chan controlResult{}, operations: map[string]string{}, toolPolicies: map[string]bool{}}
		s.controlMu.Lock()
		if _, exists := s.connections[id]; exists {
			s.controlMu.Unlock()
			return fail(409, "控制连接已存在")
		}
		s.connections[id] = c
		s.controlMu.Unlock()
		defer func() {
			s.controlMu.Lock()
			if s.connections[id] == c {
				delete(s.connections, id)
				close(c.done)
			}
			s.controlMu.Unlock()
		}()
		flusher, ok := w.(http.Flusher)
		if !ok {
			return fail(500, "当前 HTTP 服务不支持流式响应")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		send := func(event any) error {
			b, err := json.Marshal(event)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(w, "data: %s\n\n", b)
			flusher.Flush()
			return err
		}
		if err := send(object{"type": "ready"}); err != nil {
			return nil
		}
		heartbeat := time.NewTicker(20 * time.Second)
		defer heartbeat.Stop()
		for {
			select {
			case <-r.Context().Done():
				return nil
			case event := <-c.events:
				if send(event) != nil {
					return nil
				}
			case <-heartbeat.C:
				if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
					return nil
				}
				flusher.Flush()
			}
		}
	}
	v, err := decode(r)
	if err != nil {
		return err
	}
	id := str(v["connectionId"])
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	c := s.connections[id]
	if c == nil {
		return fail(404, "页面控制连接已断开")
	}
	switch operation {
	case "state":
		state, ok := v["state"].(map[string]any)
		if !ok || len(array(state["tools"])) > 10000 {
			return fail(400, "控制状态无效")
		}
		revision := number(v["revision"])
		if revision > c.revision {
			c.revision = revision
			c.state = state
		}
		success(w, nil)
	case "result":
		callID := str(v["callId"])
		pending := c.pending[callID]
		operationID := c.operations[callID]
		if pending == nil {
			if operationID == "" {
				return fail(404, "控制命令已取消或不存在")
			}
			delete(c.operations, callID)
			result := controlResult{result: v["result"], err: str(v["error"]), details: asObject(v["errorDetails"])}
			go func() {
				var err error
				if result.err != "" {
					err = &mcpCallError{details: normalizeToolError(result.details, result.err, "execution", "unknown", object{})}
				}
				s.finishMcpOperation(operationID, result.result, err)
			}()
			success(w, nil)
			return nil
		}
		delete(c.pending, callID)
		delete(c.operations, callID)
		pending <- controlResult{result: v["result"], err: str(v["error"]), details: asObject(v["errorDetails"])}
		success(w, nil)
	default:
		return fail(404, "控制接口不存在")
	}
	return nil
}
func (s *server) connectionList() []any {
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	list := []any{}
	for _, c := range s.connections {
		list = append(list, object{"id": c.id, "state": clone(c.state)})
	}
	return list
}
func (s *server) callControl(ctx context.Context, target object, name string, args object) (any, error) {
	if ctx.Err() != nil {
		return nil, toolFailure("operationCancelled", "控制命令派发前已取消", "execution", "cancelled", target, "none")
	}
	s.controlMu.Lock()
	id := str(target["connectionId"])
	var c *controlConnection
	if id != "" {
		c = s.connections[id]
	} else {
		for _, candidate := range s.connections {
			if directory := str(target["directory"]); directory != "" && str(candidate.state["directory"]) != directory {
				continue
			}
			if c != nil {
				s.controlMu.Unlock()
				return nil, fail(409, "存在多个工作台页面，请指定 target.connectionId")
			}
			c = candidate
		}
	}
	if c == nil {
		s.controlMu.Unlock()
		return nil, fail(409, "请先连接 OpenCinema 工作台，并调用 getAppState")
	}
	if directory := str(target["directory"]); directory != "" && str(c.state["directory"]) != directory {
		s.controlMu.Unlock()
		return nil, stale("工作区已切换")
	}
	if canvas := str(target["canvasId"]); canvas != "" && str(c.state["canvasId"]) != canvas {
		s.controlMu.Unlock()
		return nil, stale("画布已切换")
	}
	if len(c.pending) > 0 {
		s.controlMu.Unlock()
		return nil, fail(409, "页面正在执行另一条控制命令")
	}
	allowed := name == "openProject" || name == "saveWorkspace" || name == "sendPrompt" || name == "getSettings" || name == "refreshResources"
	for _, raw := range array(c.state["capabilities"]) {
		if str(asObject(raw)["name"]) == name {
			allowed = true
		}
	}
	for _, raw := range array(c.state["tools"]) {
		if str(asObject(raw)["name"]) == name {
			allowed = true
		}
	}
	if !allowed {
		s.controlMu.Unlock()
		return nil, fail(400, "工作台未发布此能力，请重新读取工具列表")
	}
	callID := randomID()
	pending := make(chan controlResult, 1)
	c.pending[callID] = pending
	if operationID, ok := ctx.Value(operationContextKey{}).(string); ok {
		c.operations[callID] = operationID
	}
	s.controlMu.Unlock()
	defer func() { s.controlMu.Lock(); delete(c.pending, callID); s.controlMu.Unlock() }()
	event := object{"type": "call", "callId": callID, "name": name, "args": args}
	if directory := str(target["directory"]); directory != "" {
		event["directory"] = directory
	}
	if canvasID := str(target["canvasId"]); canvasID != "" {
		event["canvasId"] = canvasID
	}
	select {
	case c.events <- event:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, fail(409, "工作台已断开")
	}
	timeout := time.NewTimer(120 * time.Second)
	defer timeout.Stop()
	select {
	case result := <-pending:
		if result.err != "" {
			return nil, &mcpCallError{details: normalizeToolError(result.details, result.err, "execution", "unknown", target)}
		}
		if name == "getNodeTools" || name == "getWorkspaceTools" {
			s.controlMu.Lock()
			s.rememberToolPolicies(c, name, asObject(result.result))
			s.controlMu.Unlock()
		}
		return result.result, nil
	case <-ctx.Done():
		select {
		case c.events <- object{"type": "cancel", "callId": callID}:
		default:
		}
		return nil, toolFailure("operationUnknown", "请求已派发，等待已取消；执行结果未知", "transport", "unknown", target, "queryOperation")
	case <-c.done:
		return nil, toolFailure("operationUnknown", "页面已断开；已派发操作可能仍在执行", "transport", "unknown", target, "queryOperation")
	case <-timeout.C:
		select {
		case c.events <- object{"type": "cancel", "callId": callID}:
		default:
		}
		return nil, toolFailure("operationUnknown", "控制命令等待超时；请查询原 operationId，不要重发", "transport", "unknown", target, "queryOperation")
	}
}
func (s *server) mcp(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeMcp(r) {
		failure(w, fail(401, "MCP 访问凭证无效"))
		return
	}
	if r.Method == "DELETE" {
		w.WriteHeader(200)
		return
	}
	if r.Method == "GET" {
		w.Header().Set("Allow", "POST, DELETE")
		w.WriteHeader(405)
		return
	}
	if r.Method != "POST" {
		failure(w, fail(405, "HTTP 方法不支持"))
		return
	}
	input, err := decode(r)
	if err != nil {
		failure(w, err)
		return
	}
	id, hasID := input["id"]
	method := str(input["method"])
	if !hasID {
		w.WriteHeader(202)
		return
	}
	var result any
	switch method {
	case "initialize":
		version := str(asObject(input["params"])["protocolVersion"])
		if version != "2025-03-26" && version != "2025-06-18" && version != "2025-11-25" {
			version = "2025-11-25"
		}
		result = object{"protocolVersion": version, "capabilities": object{"tools": object{"listChanged": false}, "resources": object{"listChanged": false}}, "serverInfo": object{"name": "openCinema", "version": hostVersion}, "instructions": "先调用 getAppState 固定工程和连接，同一connection串行调用画布及插件工具。renderOpenCinema 打开已有工程；画布与节点需要同一React provider。扩展操作用 getWorkbenchTools 的 query 或 names 按需发现，再通过 workbenchTools 调用并带回 catalogRevision；节点和工作区插件先 getNodeTools/getWorkspaceTools 发现真实Schema。发现时保存documentRevision和toolCatalogVersion，写入按schema提供修订及operationId；未知结果调用getOperation，不重复派发。工具completed不等于专业task产物或保存完成。本服务不声明MCP Tasks扩展。"}
	case "ping":
		result = object{}
	case "tools/list":
		result = object{"tools": s.mcpTools()}
	case "tools/call":
		params := asObject(input["params"])
		output, callErr := s.executeMcpOperation(r.Context(), str(params["name"]), asObject(params["arguments"]))
		if callErr != nil {
			details := mcpErrorDetails(callErr, asObject(asObject(params["arguments"])["target"]))
			if operationID := str(asObject(params["arguments"])["operationId"]); operationID != "" {
				details["operationId"] = operationID
			}
			errorText, _ := json.Marshal(object{"error": details})
			result = object{"isError": true, "content": []any{object{"type": "text", "text": string(errorText)}}, "structuredContent": object{"error": details}}
		} else if str(params["name"]) == "renderOpenCinema" || str(params["name"]) == "openCinemaTransport" || str(params["name"]) == "readWorkspaceImage" {
			result = output
		} else {
			bytes, _ := json.Marshal(output)
			result = object{"content": []any{object{"type": "text", "text": string(bytes)}}, "structuredContent": object{"result": output}}
		}
	case "resources/list":
		result = object{"resources": s.widgetResourceList()}
	case "resources/read":
		resource, readErr := s.readWidgetResource(str(asObject(input["params"])["uri"]))
		if readErr != nil {
			respond(w, 200, object{"jsonrpc": "2.0", "id": id, "error": object{"code": -32602, "message": readErr.Error()}})
			return
		}
		result = resource
	case "prompts/list":
		result = object{"prompts": []any{}}
	default:
		respond(w, 200, object{"jsonrpc": "2.0", "id": id, "error": object{"code": -32601, "message": "Method not found"}})
		return
	}
	respond(w, 200, object{"jsonrpc": "2.0", "id": id, "result": result})
}
func objectSchema() object { return object{"type": "object", "additionalProperties": true} }
func wrapSchema(schema any) object {
	return object{"type": "object", "properties": object{"target": object{"type": "object", "properties": object{"connectionId": object{"type": "string", "format": "uuid"}, "directory": object{"type": "string", "maxLength": 4096}, "canvasId": object{"type": "string", "maxLength": 4096}}, "additionalProperties": false}, "operationId": object{"type": "string", "format": "uuid", "description": "写入或创建操作的稳定UUID。同ID同参数重放原回执；结果未知时先getOperation。"}, "args": schema}, "required": []string{"args"}, "additionalProperties": false}
}
func (s *server) mcpToolCatalog() []any {
	list := []any{object{"name": "getAppState", "description": "读取已连接的 OpenCinema Web 工作台、文档修订与工具目录版本。无React provider时先renderOpenCinema或打开同一React Web；Go不离线执行节点。多个页面明确target.connectionId。", "inputSchema": object{"type": "object", "additionalProperties": false}}, object{"name": "workspaceFiles", "description": "有界分页读取和修改工作区文件。覆盖、改名与删除先读fileRevision；禁止直接修改画布JSON。写入默认exclusive且需要operationId。", "inputSchema": wrapSchema(workspaceFileSchema())}, object{"name": "openProject", "description": "打开已有工程目录，等待工作台完成保存与载入。", "inputSchema": wrapSchema(object{"type": "object", "properties": object{"directory": object{"type": "string"}}, "required": []string{"directory"}, "additionalProperties": false})}, object{"name": "saveWorkspace", "description": "等待当前画布和节点正文保存完成。", "inputSchema": wrapSchema(object{"type": "object", "additionalProperties": false})}}
	list = append(list, mcpFileAndOperationTools()...)
	for _, name := range []string{"registerHost", "pollHostRequests", "getHostRequest", "completeHostRequest"} {
		description := map[string]string{"registerHost": "注册任意宿主 Agent 的请求能力；租约默认60秒，可显式设置leaseSeconds为60至900秒整数，交互审批建议300秒。须按返回时长持续轮询续租。", "pollHostRequests": "按稳定顺序、64KiB预算分页轮询待处理与取消请求并按注册时长续租。保留cursor续读；inputOmitted时用getHostRequest读取固定正文。queued不是完成，执行前报告running。", "getHostRequest": "按原sessionId/requestId和inputRevision分段读取冻结请求正文；hasMore时使用nextOffset读取完整section，不能将截断内容当成完整请求。", "completeHostRequest": "回填真实运行进度或完成结果。媒体先保存到工作区并返回相对路径；不能把 accepted 当 completed。"}[name]
		list = append(list, object{"name": name, "description": description, "inputSchema": object{"type": "object", "properties": object{"args": hostToolSchema(name)}, "required": []string{"args"}, "additionalProperties": false}})
	}
	names := map[string]bool{}
	for _, raw := range list {
		names[str(asObject(raw)["name"])] = true
	}
	for _, raw := range s.widgetTools() {
		name := str(asObject(raw)["name"])
		if !names[name] {
			names[name] = true
			list = append(list, raw)
		}
	}
	if s.widget != nil && len(s.widget.contents) > 0 {
		return completeToolMetadata(list)
	}
	for _, raw := range s.connectionList() {
		state := asObject(asObject(raw)["state"])
		for _, cap := range append(array(state["capabilities"]), array(state["tools"])...) {
			item := asObject(cap)
			name := str(item["name"])
			if name == "" || names[name] {
				continue
			}
			names[name] = true
			schema := item["inputSchema"]
			if schema == nil {
				schema = item["parameters"]
			}
			if schema == nil {
				schema = objectSchema()
			}
			tool := object{"name": name, "description": str(item["description"]), "inputSchema": wrapSchema(schema)}
			for _, key := range []string{"outputSchema", "annotations", "requires", "availability"} {
				if item[key] != nil {
					tool[key] = item[key]
				}
			}
			list = append(list, tool)
		}
	}
	return completeToolMetadata(list)
}
func (s *server) executeMcp(ctx context.Context, name string, input object) (any, error) {
	if name == "renderOpenCinema" {
		return s.renderWidget(input)
	}
	if name == "openCinemaTransport" {
		return s.widgetTransport(ctx, input)
	}
	if name == "getAppState" {
		if len(input) > 0 {
			return nil, fail(400, "getAppState不接受参数")
		}
		connections := s.connectionList()
		for _, raw := range connections {
			state := asObject(asObject(raw)["state"])
			delete(state, "capabilities")
			delete(state, "tools")
		}
		state := object{"connections": connections, "workspaceRoot": filepath.Join(s.dataDirectory, "workspaces"), "runtime": "go", "providerRequired": true, "protocolVersions": []string{"2025-03-26", "2025-06-18", "2025-11-25"}, "availability": object{"canvas": "requires connected React runtime", "nodeTools": "discover with getNodeTools after opening existing canvas", "workspaceFiles": "available with explicit target.directory", "images": "readWorkspaceImage returns MCP image blocks", "recovery": "retain operationId and query getOperation after unknown; no automatic replay"}}
		if s.managed != nil && moduleRevision.MatchString(s.managed.owner.Revision) {
			state["runtimeRevision"] = s.managed.owner.Revision
		}
		return state, nil
	}
	args, validArgs := input["args"].(map[string]any)
	if !validArgs {
		return nil, fail(400, "工具参数必须在 args 对象中提供")
	}
	if name == "registerHost" || name == "pollHostRequests" || name == "getHostRequest" || name == "completeHostRequest" {
		if len(input) != 1 {
			return nil, fail(400, "宿主租约工具仅接受args，不接受target或operationId")
		}
		return s.hostMcp(name, args)
	}
	for key := range input {
		if key != "target" && key != "args" && key != "operationId" {
			return nil, fail(400, "未知工具顶层字段")
		}
	}
	target, err := parseMcpTarget(input)
	if err != nil {
		return nil, err
	}
	if directory := str(target["directory"]); directory != "" {
		actual, err := filepath.EvalSymlinks(directory)
		if err != nil {
			if name != "getOperation" && name != "cancelOperation" {
				return nil, err
			}
		} else {
			target["directory"] = actual
		}
	}
	if name == "workspaceFiles" {
		return s.mcpFiles(target, args)
	}
	if name == "readWorkspaceImage" {
		return s.readWorkspaceImage(target, args)
	}
	if name == "getOperation" || name == "cancelOperation" {
		return s.operationTool(name, target, args)
	}
	result, err := s.callControl(ctx, target, name, args)
	if name == "getSettings" || name == "updateSettings" {
		result = redactSecrets(result)
	}
	return result, err
}
