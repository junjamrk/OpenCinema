package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf8"
)

func isCoreMcpTool(name string) bool {
	switch name {
	case "getAppState", "renderOpenCinema", "openCinemaTransport", "workspaceFiles", "readWorkspaceImage", "getOperation", "cancelOperation", "openProject", "saveWorkspace", "registerHost", "pollHostRequests", "getHostRequest", "completeHostRequest", "getCanvas", "getCanvasNodes", "getCanvasEdges", "findCanvasNodes", "getNodeTools", "nodeTools", "getWorkspaceTools", "workspaceTools", "selectNodes", "addNode", "moveNodes", "renameNodes", "deleteNodes", "connectNodes", "saveCanvas", "switchCanvas", "fitCanvas", "changeCanvasHistory":
		return true
	}
	return false
}

func (s *server) mcpTools() []any {
	// ACT: 当前桌面聊天只暴露按名排序的前40项；保持核心入口小于40，其余操作按需发现。
	list := []any{}
	for _, raw := range s.mcpToolCatalog() {
		if isCoreMcpTool(str(asObject(raw)["name"])) {
			list = append(list, raw)
		}
	}
	text := object{"type": "string", "minLength": 1, "maxLength": 128}
	revision := object{"type": "string", "pattern": "^[a-f0-9]{64}$"}
	list = append(list,
		object{"name": "getWorkbenchTools", "description": "分页发现分组、排列、画布管理、素材、模型和插件配置等扩展工作台操作的真实parameters、outputSchema及副作用声明。未知名称时用query按名称或描述子串搜索，忽略大小写；与names同时提供时取交集。后续分页保留筛选条件与catalogRevision。catalogRevision只绑定该静态目录，不代替documentRevision或动态插件toolCatalogVersion。", "inputSchema": object{"type": "object", "properties": object{"names": object{"type": "array", "minItems": 1, "maxItems": 20, "uniqueItems": true, "items": text}, "query": object{"type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\S"}, "offset": object{"type": "integer", "minimum": 0}, "limit": object{"type": "integer", "minimum": 1, "maximum": 20}, "catalogRevision": revision}, "additionalProperties": false}, "annotations": object{"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}},
		object{"name": "workbenchTools", "description": "执行getWorkbenchTools发现的扩展工作台操作。args.name/catalogRevision来自发现回执，args.arguments按该操作parameters填写；target及稳定operationId仍放外层。沿用原操作的修订、授权、保存和恢复边界，getOperation查询原ID。", "inputSchema": wrapSchema(object{"type": "object", "properties": object{"name": text, "catalogRevision": revision, "arguments": object{"type": "object"}}, "required": []string{"name", "catalogRevision", "arguments"}, "additionalProperties": false}), "annotations": object{"readOnlyHint": false, "destructiveHint": true, "openWorldHint": true}},
	)
	return completeToolMetadata(list)
}

func (s *server) extendedWorkbenchTools() ([]any, string) {
	tools := []any{}
	for _, raw := range s.mcpToolCatalog() {
		tool := asObject(raw)
		if !isCoreMcpTool(str(tool["name"])) {
			item := asObject(clone(tool))
			parameters, _ := json.Marshal(asObject(asObject(item["inputSchema"])["properties"])["args"])
			parameters = []byte(strings.ReplaceAll(string(parameters), `"$ref":"#/properties/args`, `"$ref":"#`))
			var schema any
			if json.Unmarshal(parameters, &schema) != nil {
				continue
			}
			item["parameters"] = schema
			delete(item, "inputSchema")
			tools = append(tools, item)
		}
	}
	sort.Slice(tools, func(i, j int) bool { return str(asObject(tools[i])["name"]) < str(asObject(tools[j])["name"]) })
	bytes, _ := json.Marshal(tools)
	return tools, hash(bytes)
}

func (s *server) getWorkbenchTools(input object) (any, error) {
	for key := range input {
		if key != "names" && key != "query" && key != "offset" && key != "limit" && key != "catalogRevision" {
			return nil, fail(400, "未知工作台发现字段: "+key)
		}
	}
	tools, revision := s.extendedWorkbenchTools()
	if raw, exists := input["catalogRevision"]; exists && raw != revision {
		return nil, toolFailure("workbenchCatalogChanged", "工作台工具目录已变化，请重新发现", "validation", "notDispatched", object{}, "rediscoverWorkbenchTools")
	}
	offset, err := boundedInteger(input, "offset", 0, 0, 10000)
	if err != nil {
		return nil, err
	}
	limit, err := boundedInteger(input, "limit", 10, 1, 20)
	if err != nil {
		return nil, err
	}
	if raw, exists := input["names"]; exists {
		names, ok := raw.([]any)
		if !ok || len(names) < 1 || len(names) > 20 {
			return nil, fail(400, "names必须是1至20个不重复的工具名称")
		}
		selected := map[string]bool{}
		for _, name := range names {
			value, ok := name.(string)
			if !ok || value == "" || len(value) > 128 || selected[value] {
				return nil, fail(400, "工具名称无效或重复")
			}
			selected[value] = true
		}
		filtered := []any{}
		for _, tool := range tools {
			if selected[str(asObject(tool)["name"])] {
				filtered = append(filtered, tool)
			}
		}
		if len(filtered) != len(selected) {
			return nil, fail(400, "名称不属于扩展工作台目录；核心操作直接调用同名工具")
		}
		tools = filtered
	}
	if raw, exists := input["query"]; exists {
		value, ok := raw.(string)
		if !ok || strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > 200 {
			return nil, fail(400, "query必须是1至200个字符的非空搜索词")
		}
		query := strings.ToLower(strings.TrimSpace(value))
		filtered := []any{}
		for _, raw := range tools {
			tool := asObject(raw)
			if strings.Contains(strings.ToLower(str(tool["name"])), query) || strings.Contains(strings.ToLower(str(tool["description"])), query) {
				filtered = append(filtered, raw)
			}
		}
		tools = filtered
	}
	if offset > 0 && input["catalogRevision"] == nil {
		return nil, fail(400, "后续分页必须提供catalogRevision")
	}
	if offset > len(tools) {
		return nil, fail(400, "offset超出目录范围")
	}
	end := min(offset+limit, len(tools))
	for next := offset + 1; next <= end; next++ {
		bytes, err := json.Marshal(tools[offset:next])
		if err != nil {
			return nil, err
		}
		if len(bytes) > 63*1024 {
			if next == offset+1 {
				return nil, fail(413, "单个工作台工具Schema超过目录分页预算")
			}
			end = next - 1
			break
		}
	}
	return object{"tools": tools[offset:end], "catalogRevision": revision, "total": len(tools), "hasMore": end < len(tools), "nextOffset": end}, nil
}

func (s *server) callWorkbenchTool(ctx context.Context, input object) (any, error) {
	for key := range input {
		if key != "args" && key != "target" && key != "operationId" {
			return nil, fail(400, "未知工作台调用字段: "+key)
		}
	}
	if _, err := parseMcpTarget(input); err != nil {
		return nil, err
	}
	args, ok := input["args"].(map[string]any)
	if !ok || len(args) != 3 {
		return nil, fail(400, "args必须包含name、catalogRevision和arguments")
	}
	parameters, ok := args["arguments"].(map[string]any)
	if !ok {
		return nil, fail(400, "arguments必须是原操作的参数对象")
	}
	tools, revision := s.extendedWorkbenchTools()
	if args["catalogRevision"] != revision {
		return nil, toolFailure("workbenchCatalogChanged", "工作台工具目录已变化，请重新发现", "validation", "notDispatched", asObject(input["target"]), "rediscoverWorkbenchTools")
	}
	for _, raw := range tools {
		if args["name"] == asObject(raw)["name"] {
			request := asObject(clone(input))
			request["args"] = parameters
			if !s.isObservedReadOnly(str(args["name"]), request) && str(input["operationId"]) == "" {
				return nil, toolFailure("operationIdRequired", "工作台扩展写操作必须提供外层operationId UUID", "validation", "notDispatched", asObject(input["target"]), "correctInput")
			}
			return s.executeMcpOperation(ctx, str(args["name"]), request)
		}
	}
	return nil, fail(400, "请先发现扩展工作台操作；核心操作直接调用同名工具")
}
