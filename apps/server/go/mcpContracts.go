package main

import (
	"errors"
	"os"
	"path/filepath"
)

type mcpCallError struct{ details object }

func (e *mcpCallError) Error() string { return str(e.details["message"]) }

func toolFailure(code, message, phase, state string, target object, action string) error {
	return &mcpCallError{details: object{"code": code, "message": message, "phase": phase, "target": clone(target), "executionState": state, "recovery": object{"action": action, "message": recoveryMessage(action)}}}
}
func recoveryMessage(action string) string {
	switch action {
	case "queryOperation":
		return "保留原 operationId，调用 getOperation；unknown 不表示副作用已停止，禁止新ID重试。"
	case "readState":
		return "重新读取同一目标及其实际修订，再决定下一步。"
	case "rediscoverTools":
		return "重新发现目标工具，使用新的 toolCatalogVersion 与 schema。"
	case "rediscoverWorkbenchTools":
		return "重新调用 getWorkbenchTools，使用新的 catalogRevision 与 parameters；原写入结果未知时先 getOperation。"
	case "correctInput":
		return "按已发现的 schema 修正参数后重试。"
	case "retry":
		return "仅在确认未产生副作用后重试。"
	default:
		return "读取实际状态；不自动重复执行。"
	}
}
func normalizeToolError(details object, message, phase, state string, target object) object {
	result := asObject(clone(details))
	if str(result["code"]) == "" {
		result["code"] = "executionFailed"
	}
	result["message"] = message
	if str(result["phase"]) == "" {
		result["phase"] = phase
	}
	if str(result["executionState"]) == "" {
		result["executionState"] = state
	}
	resolvedTarget := asObject(clone(asObject(result["target"])))
	for key, value := range target {
		resolvedTarget[key] = clone(value)
	}
	result["target"] = resolvedTarget
	if result["recovery"] == nil {
		result["recovery"] = object{"action": "readState", "message": recoveryMessage("readState")}
	}
	return result
}
func mcpErrorDetails(err error, target object) object {
	var call *mcpCallError
	if errors.As(err, &call) {
		return normalizeToolError(call.details, err.Error(), "execution", "unknown", target)
	}
	code, phase, action, state := "invalidInput", "validation", "correctInput", "notDispatched"
	var api *apiError
	if errors.As(err, &api) {
		if api.code != "" {
			code = api.code
		}
		switch api.status {
		case 401, 403:
			code, phase, action = "permissionDenied", "authorization", "readState"
		case 404:
			code, action = "notFound", "readState"
		case 409:
			code, phase, action = "conflict", "target", "readState"
		case 413:
			code = "sizeLimit"
		case 424:
			code, phase, action = "providerRequired", "target", "readState"
		case 429:
			code, action = "capacityExceeded", "retry"
		}
		if api.code == "ESTALE" {
			code = "revisionConflict"
		}
	} else if os.IsNotExist(err) {
		code, phase, action, state = "notFound", "execution", "readState", "unknown"
	} else if os.IsPermission(err) {
		code, phase, action, state = "permissionDenied", "authorization", "readState", "unknown"
	} else {
		code, phase, action, state = "executionFailed", "execution", "readState", "unknown"
	}
	return object{"code": code, "message": err.Error(), "phase": phase, "target": clone(target), "executionState": state, "recovery": object{"action": action, "message": recoveryMessage(action)}}
}
func parseMcpTarget(input object) (object, error) {
	target := asObject(input["target"])
	if raw, present := input["target"]; present {
		if _, ok := raw.(map[string]any); !ok {
			return nil, fail(400, "target必须为对象")
		}
	}
	for key, value := range target {
		if key != "connectionId" && key != "directory" && key != "canvasId" {
			return nil, fail(400, "未知target字段")
		}
		text, ok := value.(string)
		if !ok || text == "" || len(text) > 4096 {
			return nil, fail(400, "target字段必须为非空字符串")
		}
		if key == "connectionId" && !uuidValue.MatchString(text) {
			return nil, fail(400, "target.connectionId必须为UUID")
		}
		if key == "directory" && !filepath.IsAbs(text) {
			return nil, fail(400, "target.directory必须为绝对路径")
		}
	}
	return asObject(clone(target)), nil
}
func resultSchema(schema object) object {
	return object{"type": "object", "properties": object{"result": schema}, "required": []string{"result"}, "additionalProperties": false}
}
func hostSessionSchema() object {
	return object{"type": "object", "properties": object{"id": object{"type": "string"}, "name": object{"type": "string"}, "directory": object{"type": "string"}, "leaseSeconds": object{"type": "integer", "minimum": 60, "maximum": 900}, "expiresAt": object{"type": "integer"}, "capabilities": object{"type": "object"}}, "required": []string{"id", "name", "directory", "leaseSeconds", "expiresAt", "capabilities"}}
}
func completeToolMetadata(list []any) []any {
	readOnly := map[string]bool{"getAppState": true, "readWorkspaceImage": true, "getOperation": true, "getSettings": true, "getHostRequest": true}
	for _, raw := range list {
		tool := asObject(raw)
		name := str(tool["name"])
		if name == "changeCanvasHistory" {
			asObject(tool["inputSchema"])["required"] = []string{"args", "operationId"}
		}
		if tool["outputSchema"] == nil && name != "renderOpenCinema" && name != "openCinemaTransport" {
			schema := serverResultSchema(name)
			tool["outputSchema"] = resultSchema(schema)
		}
		if tool["annotations"] == nil {
			tool["annotations"] = object{"readOnlyHint": readOnly[name], "destructiveHint": name == "workspaceFiles" || name == "nodeTools" || name == "workspaceTools", "idempotentHint": readOnly[name] || name == "cancelOperation" || name == "saveWorkspace" || name == "pollHostRequests", "openWorldHint": name == "nodeTools" || name == "workspaceTools"}
		}
	}
	return list
}

func serverResultSchema(name string) object {
	text := object{"type": "string"}
	integer := object{"type": "integer", "minimum": 0}
	booleanSchema := object{"type": "boolean"}
	file := object{"directory": text, "path": text, "fileRevision": text}
	makeObject := func(properties object, required ...string) object {
		return object{"type": "object", "properties": properties, "required": required}
	}
	switch name {
	case "saveWorkspace":
		return makeObject(object{"canvasId": text, "documentRevision": integer, "dirty": booleanSchema, "saved": object{"const": true}}, "canvasId", "documentRevision", "dirty", "saved")
	case "getWorkbenchTools":
		tool := makeObject(object{"name": text, "description": text, "parameters": object{"type": "object"}, "outputSchema": object{"type": "object"}, "annotations": object{"type": "object"}}, "name", "description", "parameters", "outputSchema", "annotations")
		return makeObject(object{"tools": object{"type": "array", "items": tool}, "catalogRevision": text, "total": integer, "hasMore": booleanSchema, "nextOffset": integer}, "tools", "catalogRevision", "total", "hasMore", "nextOffset")
	case "getAppState":
		return makeObject(object{"connections": object{"type": "array", "items": makeObject(object{"id": text, "state": object{"type": "object"}}, "id", "state")}, "workspaceRoot": text, "runtime": object{"const": "go"}, "runtimeRevision": text, "providerRequired": booleanSchema, "protocolVersions": object{"type": "array", "items": text}, "availability": object{"type": "object"}}, "connections", "workspaceRoot", "runtime", "providerRequired", "availability")
	case "workspaceFiles":
		entry := makeObject(object{"name": text, "path": text, "type": object{"type": "string", "enum": []string{"file", "directory"}}, "size": integer, "modifiedAt": integer}, "name", "path", "type", "size", "modifiedAt")
		return object{"anyOf": []any{makeObject(object{"directory": text, "path": text, "entries": object{"type": "array", "items": entry}, "total": integer, "hasMore": booleanSchema, "nextCursor": text, "queryRevision": text}, "directory", "path", "entries", "total", "hasMore", "queryRevision"), makeObject(object{"directory": text, "path": text, "fileRevision": text, "size": integer, "isDirectory": booleanSchema}, "directory", "path", "fileRevision", "size", "isDirectory"), makeObject(object{"directory": text, "path": text, "fileRevision": text, "size": integer, "base64": text}, "directory", "path", "fileRevision", "size", "base64"), makeObject(object{"directory": text, "path": text, "fileRevision": text, "size": integer, "text": text, "encoding": text, "offset": integer, "hasMore": booleanSchema, "nextOffset": integer}, "directory", "path", "fileRevision", "size", "text", "encoding", "offset", "hasMore"), makeObject(object{"directory": text, "path": text, "fileRevision": text, "success": object{"const": true}, "saved": object{"const": true}}, "directory", "path", "success", "saved")}}
	case "readWorkspaceImage":
		for _, key := range []string{"mode", "mimeType", "coordinateSpace", "sourceRevision"} {
			file[key] = text
		}
		for _, key := range []string{"sourceWidth", "sourceHeight", "width", "height", "bytes"} {
			file[key] = integer
		}
		return makeObject(file, "directory", "path", "fileRevision", "sourceRevision", "mode", "mimeType", "coordinateSpace", "sourceWidth", "sourceHeight", "width", "height", "bytes")
	case "getOperation", "cancelOperation":
		return makeObject(object{"operationId": text, "scope": object{"const": "toolInvocation"}, "tool": text, "target": object{"type": "object"}, "status": object{"type": "string", "enum": []string{"accepted", "running", "completed", "failed", "cancelled", "unknown"}}, "cancelRequested": booleanSchema, "executionSettled": booleanSchema, "createdAt": integer, "updatedAt": integer, "result": object{}, "error": object{"type": []string{"object", "null"}}, "persistence": text}, "operationId", "scope", "tool", "target", "status", "cancelRequested", "executionSettled", "createdAt", "updatedAt", "result", "error", "persistence")
	case "registerHost":
		return hostSessionSchema()
	case "pollHostRequests":
		return makeObject(object{"session": hostSessionSchema(), "requests": object{"type": "array", "items": object{"type": "object"}}, "hasMore": booleanSchema, "nextCursor": text, "queryRevision": text}, "session", "requests", "hasMore", "queryRevision")
	case "getHostRequest":
		return makeObject(object{"session": object{"anyOf": []any{hostSessionSchema(), object{"type": "null"}}}, "leaseExpired": booleanSchema, "request": makeObject(object{"requestId": text, "status": text}, "requestId", "status"), "section": text, "encoding": object{"const": "jsonUtf8"}, "inputRevision": text, "contentRevision": text, "content": text, "offset": integer, "hasMore": booleanSchema, "nextOffset": integer, "totalBytes": integer}, "session", "leaseExpired", "request", "section", "encoding", "inputRevision", "contentRevision", "content", "offset", "hasMore", "totalBytes")
	case "completeHostRequest":
		return makeObject(object{"requestId": text, "status": object{"type": "string", "enum": []string{"running", "completed", "failed", "cancelled", "unknown", "cancelRequested"}}, "cancelRequested": booleanSchema}, "requestId", "status", "cancelRequested")
	}
	return object{}
}
