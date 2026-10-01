package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type mcpOperation struct {
	ID               string `json:"operationId"`
	Name             string `json:"tool"`
	Target           object `json:"target"`
	Fingerprint      string `json:"fingerprint"`
	Status           string `json:"status"`
	CancelRequested  bool   `json:"cancelRequested"`
	ExecutionSettled bool   `json:"executionSettled"`
	Created          int64  `json:"createdAt"`
	Updated          int64  `json:"updatedAt"`
	Result           any    `json:"result,omitempty"`
	Error            object `json:"error,omitempty"`
	cancel           context.CancelFunc
	done             chan struct{}
	once             sync.Once
}
type operationContextKey struct{}

func policyKey(c *controlConnection, version any, nodeID, pluginID, name string) string {
	data, _ := json.Marshal([]any{c.state["directory"], c.state["canvasId"], version, nodeID, pluginID, name})
	return string(data)
}
func (s *server) rememberToolPolicies(c *controlConnection, name string, result object) {
	version := result["toolCatalogVersion"]
	items := array(result["nodeTools"])
	if name == "getWorkspaceTools" {
		items = array(result["tools"])
	}
	if len(c.toolPolicies) > 20000 {
		c.toolPolicies = map[string]bool{}
	}
	for _, raw := range items {
		tool := asObject(raw)
		c.toolPolicies[policyKey(c, version, str(tool["nodeId"]), str(tool["pluginId"]), str(tool["name"]))] = boolean(asObject(tool["annotations"])["readOnlyHint"])
	}
}
func (s *server) isObservedReadOnly(name string, input object) bool {
	if name != "nodeTools" && name != "workspaceTools" {
		for _, raw := range s.mcpToolCatalog() {
			tool := asObject(raw)
			if str(tool["name"]) == name {
				return boolean(asObject(tool["annotations"])["readOnlyHint"])
			}
		}
		return false
	}
	args, target := asObject(input["args"]), asObject(input["target"])
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	var selected *controlConnection
	for _, c := range s.connections {
		if id := str(target["connectionId"]); id != "" && c.id != id {
			continue
		}
		if directory := str(target["directory"]); directory != "" && directory != str(c.state["directory"]) {
			continue
		}
		if canvas := str(target["canvasId"]); canvas != "" && canvas != str(c.state["canvasId"]) {
			continue
		}
		if selected != nil {
			return false
		}
		selected = c
	}
	if selected == nil {
		return false
	}
	return selected.toolPolicies[policyKey(selected, args["toolCatalogVersion"], str(args["nodeId"]), str(args["pluginId"]), str(args["name"]))]
}

func (s *server) loadMcpOperations() error {
	s.operations = map[string]*mcpOperation{}
	path := filepath.Join(s.dataDirectory, "mcpOperations")
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := readBoundedFile(filepath.Join(path, entry.Name()), 32*1024*1024)
		if err != nil {
			return err
		}
		var operation mcpOperation
		if err = json.Unmarshal(data, &operation); err != nil {
			return err
		}
		if !uuidValue.MatchString(operation.ID) || entry.Name() != operation.ID+".json" {
			return fail(500, "操作记录身份无效，保留原记录")
		}
		operation.done = make(chan struct{})
		if !operation.ExecutionSettled {
			operation.Status = "unknown"
			operation.Error = mcpErrorDetails(toolFailure("operationUnknown", "服务重启，不能确认原副作用是否完成", "transport", "unknown", operation.Target, "queryOperation"), operation.Target)
			if err = s.persistMcpOperation(&operation); err != nil {
				return err
			}
		}
		operation.once.Do(func() { close(operation.done) })
		s.operations[operation.ID] = &operation
	}
	return nil
}
func (s *server) persistMcpOperation(operation *mcpOperation) error {
	data, err := json.Marshal(operation)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.dataDirectory, "mcpOperations", operation.ID+".json"), data, false, 0600)
}
func operationState(operation *mcpOperation) object {
	return object{"operationId": operation.ID, "scope": "toolInvocation", "tool": operation.Name, "target": clone(operation.Target), "status": operation.Status, "cancelRequested": operation.CancelRequested, "executionSettled": operation.ExecutionSettled, "createdAt": operation.Created, "updatedAt": operation.Updated, "result": clone(operation.Result), "error": clone(operation.Error), "persistence": "local data directory; no automatic replay or expiry"}
}
func requiresOperationID(name string, args object) bool {
	switch name {
	case "addNode", "addCanvas", "duplicateNodes", "changeCanvasHistory", "nodeTools", "workspaceTools", "exportProject", "manageAssetLibrary", "prepareDepthModel", "installPluginPackage", "uninstallPluginPackage", "importWorkspaceMedia":
		return true
	case "manageCanvas":
		return args["kind"] == "copy" || args["kind"] == "createFolder" || args["kind"] == "createCanvas"
	case "workspaceFiles":
		return args["action"] != "list" && args["action"] != "stat" && args["action"] != "readText" && args["action"] != "readBinary"
	}
	return false
}
func (s *server) freezeOperationTarget(name string, input object) (object, error) {
	target := asObject(clone(asObject(input["target"])))
	if directory := str(target["directory"]); directory != "" {
		actual, err := filepath.EvalSymlinks(directory)
		if err != nil {
			return nil, err
		}
		target["directory"] = actual
	}
	if name == "workspaceFiles" || name == "readWorkspaceImage" {
		root, err := s.mcpFileRoot(target)
		if err != nil {
			return nil, err
		}
		target["directory"] = root
		return target, nil
	}
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	var selected *controlConnection
	for _, c := range s.connections {
		if id := str(target["connectionId"]); id != "" && c.id != id {
			continue
		}
		if directory := str(target["directory"]); directory != "" && directory != str(c.state["directory"]) {
			continue
		}
		if selected != nil {
			return nil, fail(409, "多个工作台需要明确target.connectionId")
		}
		selected = c
	}
	if selected == nil {
		return nil, toolFailure("providerRequired", "请先连接同一React工作台并调用getAppState", "target", "notDispatched", target, "readState")
	}
	if canvas := str(target["canvasId"]); canvas != "" && canvas != str(selected.state["canvasId"]) {
		return nil, stale("目标画布已切换")
	}
	target["connectionId"] = selected.id
	if str(selected.state["directory"]) != "" {
		target["directory"] = selected.state["directory"]
	}
	if str(selected.state["canvasId"]) != "" && (asObject(input["args"])["canvasId"] != nil || name == "nodeTools" || name == "workspaceTools" || name == "addNode" || name == "addCanvas" || name == "duplicateNodes") {
		target["canvasId"] = selected.state["canvasId"]
	}
	return target, nil
}
func (s *server) executeMcpOperation(ctx context.Context, name string, input object) (any, error) {
	if name == "getWorkbenchTools" {
		return s.getWorkbenchTools(input)
	}
	if name == "workbenchTools" {
		return s.callWorkbenchTool(ctx, input)
	}
	if name == "getOperation" || name == "cancelOperation" || name == "getAppState" || name == "renderOpenCinema" || name == "openCinemaTransport" || name == "registerHost" || name == "pollHostRequests" || name == "getHostRequest" || name == "completeHostRequest" {
		return s.executeMcp(ctx, name, input)
	}
	operationID := str(input["operationId"])
	if _, err := parseMcpTarget(input); err != nil {
		return nil, err
	}
	if raw, exists := input["operationId"]; exists {
		if _, ok := raw.(string); !ok || !uuidValue.MatchString(operationID) {
			return nil, fail(400, "operationId必须是UUID字符串")
		}
	}
	if s.isObservedReadOnly(name, input) {
		return s.executeMcp(ctx, name, input)
	}
	if operationID == "" {
		if requiresOperationID(name, asObject(input["args"])) {
			return nil, toolFailure("operationIdRequired", "此操作必须提供外层operationId UUID；重试保持相同ID", "validation", "notDispatched", asObject(input["target"]), "correctInput")
		}
		return s.executeMcp(ctx, name, input)
	}
	if !uuidValue.MatchString(operationID) {
		return nil, fail(400, "operationId必须是UUID")
	}
	// ACT: 指纹保留调用者的原始目标，重放不重新选择当前页面；冻结执行目标独立持久化。
	fingerprintBytes, err := json.Marshal(object{"tool": name, "input": input})
	if err != nil {
		return nil, err
	}
	fingerprint := hash(fingerprintBytes)
	s.operationMu.Lock()
	if existing := s.operations[operationID]; existing != nil {
		if existing.Fingerprint != fingerprint {
			s.operationMu.Unlock()
			return nil, toolFailure("operationConflict", "同operationId已用于不同工具、目标或参数", "validation", "notDispatched", asObject(input["target"]), "queryOperation")
		}
		state, result, details := existing.Status, clone(existing.Result), asObject(clone(existing.Error))
		s.operationMu.Unlock()
		if state == "completed" {
			return result, nil
		}
		if len(details) > 0 {
			return nil, &mcpCallError{details: details}
		}
		return nil, toolFailure("operationPending", "原操作已受理；请查询同operationId", "execution", state, existing.Target, "queryOperation")
	}
	if len(s.operations) >= 10000 {
		s.operationMu.Unlock()
		return nil, fail(429, "持久化操作记录达到10000条；保留记录并拒绝新增副作用")
	}
	target, err := s.freezeOperationTarget(name, input)
	if err != nil {
		s.operationMu.Unlock()
		return nil, err
	}
	operationContext, cancel := context.WithCancel(context.WithValue(context.Background(), operationContextKey{}, operationID))
	operation := &mcpOperation{ID: operationID, Name: name, Target: target, Fingerprint: fingerprint, Status: "accepted", Created: time.Now().UnixMilli(), Updated: time.Now().UnixMilli(), cancel: cancel, done: make(chan struct{})}
	if err = s.persistMcpOperation(operation); err != nil {
		s.operationMu.Unlock()
		cancel()
		return nil, err
	}
	s.operations[operationID] = operation
	s.operationMu.Unlock()
	frozenInput := asObject(clone(input))
	frozenInput["target"] = target
	go func() {
		s.operationMu.Lock()
		operation.Status = "running"
		operation.Updated = time.Now().UnixMilli()
		persistErr := s.persistMcpOperation(operation)
		s.operationMu.Unlock()
		var output any
		var callErr error
		if operationContext.Err() != nil {
			callErr = toolFailure("operationCancelled", "派发前已取消", "execution", "cancelled", target, "none")
		} else if persistErr != nil {
			callErr = persistErr
		} else {
			output, callErr = s.executeMcp(operationContext, name, frozenInput)
		}
		s.finishMcpOperation(operationID, output, callErr)
		cancel()
	}()
	select {
	case <-operation.done:
		s.operationMu.Lock()
		defer s.operationMu.Unlock()
		if len(operation.Error) > 0 {
			return nil, &mcpCallError{details: asObject(clone(operation.Error))}
		}
		return clone(operation.Result), nil
	case <-ctx.Done():
		return nil, toolFailure("operationUnknown", "等待已中断；原操作继续，使用getOperation查询原ID", "transport", "unknown", target, "queryOperation")
	}
}
func (s *server) finishMcpOperation(id string, result any, err error) {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	operation := s.operations[id]
	if operation == nil {
		return
	}
	if operation.ExecutionSettled {
		return
	}
	operation.cancel = nil
	operation.Updated = time.Now().UnixMilli()
	operation.Result = redactSecrets(result)
	operation.Error = nil
	operation.Status = "completed"
	operation.ExecutionSettled = true
	if err != nil {
		operation.Error = mcpErrorDetails(err, operation.Target)
		operation.Error["operationId"] = id
		state := str(operation.Error["executionState"])
		operation.Status = "failed"
		if state == "unknown" || state == "running" {
			operation.Status = "unknown"
			operation.ExecutionSettled = false
		}
		if state == "cancelled" {
			operation.Status = "cancelled"
		}
	}
	if persistErr := s.persistMcpOperation(operation); persistErr != nil {
		operation.Status = "unknown"
		operation.ExecutionSettled = false
		operation.Error = mcpErrorDetails(toolFailure("persistenceFailed", "执行可能已完成，但操作回执未持久化；请读取实际目标", "result", "unknown", operation.Target, "readState"), operation.Target)
	}
	operation.once.Do(func() { close(operation.done) })
}
func (s *server) cancelMcpOperations() {
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	for _, operation := range s.operations {
		if operation.cancel != nil {
			operation.cancel()
		}
	}
}
func (s *server) operationTool(name string, target, args object) (any, error) {
	for key := range args {
		if key != "operationId" {
			return nil, fail(400, "未知操作查询字段")
		}
	}
	id := str(args["operationId"])
	if !uuidValue.MatchString(id) {
		return nil, fail(400, "operationId必须是UUID")
	}
	s.operationMu.Lock()
	defer s.operationMu.Unlock()
	operation := s.operations[id]
	if operation == nil {
		return nil, fail(404, "原operationId无记录；不能推定从未执行")
	}
	if directory := str(operation.Target["directory"]); str(target["directory"]) != directory {
		return nil, fail(403, "须匹配原操作target.directory；全局操作不接受无关工程目录")
	}
	for _, key := range []string{"connectionId", "canvasId"} {
		if value := str(target[key]); value != "" && value != str(operation.Target[key]) {
			return nil, stale("操作查询目标与冻结身份不一致")
		}
	}
	if name == "cancelOperation" && !operation.ExecutionSettled {
		operation.CancelRequested = true
		operation.Updated = time.Now().UnixMilli()
		if err := s.persistMcpOperation(operation); err != nil {
			return nil, err
		}
		if operation.cancel != nil {
			operation.cancel()
		}
	}
	return operationState(operation), nil
}
