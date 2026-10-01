package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

type collaborationSession struct {
	Hash       string `json:"hash"`
	Role       string `json:"role"`
	ExpiresAt  int64  `json:"expiresAt"`
	Revoked    bool   `json:"revoked,omitempty"`
	Invitation bool   `json:"invitation,omitempty"`
	Joined     bool   `json:"joined,omitempty"`
	Parent     string `json:"parent,omitempty"`
}
type collaborationEdit struct {
	ID, Actor, Path, State string
	Before, After          object
	Keys                   []string
	PreviousWriters        map[string]string
}
type collaborationPending struct{ Path, Previous, Text string }
type collaborationRoom struct {
	ID        string                  `json:"id"`
	Directory string                  `json:"directory"`
	Closed    bool                    `json:"closed"`
	Sessions  []*collaborationSession `json:"sessions"`
	Receipts  map[string]string       `json:"receipts"`
	History   []*collaborationEdit    `json:"history"`
	Writers   map[string]string       `json:"writers"`
	Pending   *collaborationPending   `json:"pending,omitempty"`
}

func sessionToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func (s *server) saveRoom(room *collaborationRoom) error {
	directory := filepath.Join(s.dataDirectory, "collaboration")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	data, err := json.Marshal(room)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(directory, room.ID+".json"), data, false, 0600)
}
func (s *server) loadRooms() error {
	entries, err := os.ReadDir(filepath.Join(s.dataDirectory, "collaboration"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dataDirectory, "collaboration", entry.Name()))
		if err != nil {
			return err
		}
		var room collaborationRoom
		if err = json.Unmarshal(data, &room); err != nil {
			return fmt.Errorf("协作记录 %s 损坏，保留原记录: %w", entry.Name(), err)
		}
		if room.Receipts == nil {
			room.Receipts = map[string]string{}
		}
		if room.Writers == nil {
			room.Writers = map[string]string{}
		}
		s.rooms[room.ID] = &room
	}
	return nil
}
func (s *server) authorizeRoom(id, token string, write, owner bool) (*collaborationRoom, *collaborationSession, error) {
	room := s.rooms[id]
	if room == nil || room.Closed {
		return nil, nil, fail(404, "协作已结束或不存在")
	}
	digest := hash([]byte(token))
	now := time.Now().UnixMilli()
	var session *collaborationSession
	for _, candidate := range room.Sessions {
		if candidate.Hash == digest && !candidate.Revoked && candidate.ExpiresAt > now {
			session = candidate
			break
		}
	}
	if session == nil || session.Invitation {
		return nil, nil, fail(401, "协作会话已过期或撤销，草稿已保留")
	}
	if session.Parent != "" {
		found := false
		for _, p := range room.Sessions {
			if p.Hash == session.Parent && !p.Revoked && p.ExpiresAt > now {
				found = true
			}
		}
		if !found {
			return nil, nil, fail(401, "协作邀请已撤销")
		}
	}
	if write && session.Role == "viewer" || owner && session.Role != "owner" {
		return nil, nil, fail(403, "当前协作角色没有操作权限")
	}
	return room, session, nil
}
func newCollaborationSession(room *collaborationRoom, role string, invitation bool, parent string) (object, error) {
	now := time.Now().UnixMilli()
	active := []*collaborationSession{}
	for _, session := range room.Sessions {
		if !session.Revoked && session.ExpiresAt > now {
			active = append(active, session)
		}
	}
	if len(active) >= 100 {
		return nil, fail(429, "此协作最多100个会话")
	}
	token := sessionToken()
	session := &collaborationSession{Hash: hash([]byte(token)), Role: role, ExpiresAt: now + 8*3600000, Invitation: invitation, Parent: parent}
	room.Sessions = append(active, session)
	return object{"roomId": room.ID, "token": token, "role": role, "expiresAt": session.ExpiresAt, "directory": room.Directory}, nil
}
func collaborationFile(room *collaborationRoom, path string) (string, error) {
	if !strings.HasSuffix(strings.ToLower(path), ".json") || strings.HasPrefix(path, "assets/") {
		return "", fail(400, "协作仅支持工作区画布 JSON")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || strings.HasPrefix(part, ".") {
			return "", fail(400, "协作文件路径无效")
		}
	}
	return workspacePath(room.Directory, path, false)
}
func (s *server) recoverRoom(room *collaborationRoom) error {
	if room.Pending == nil {
		return nil
	}
	path, err := collaborationFile(room, room.Pending.Path)
	if err != nil {
		return err
	}
	current, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if hash(current) != hash([]byte(room.Pending.Text)) {
		if hash(current) != room.Pending.Previous {
			return stale("未完成的协作保存与磁盘冲突，两份内容已保留")
		}
		if err = atomicWrite(path, []byte(room.Pending.Text), false, 0600); err != nil {
			return err
		}
	}
	room.Pending = nil
	return s.saveRoom(room)
}
func validateCanvas(v object) error {
	if !boolean(v["toonflowCanvas"]) {
		return fail(400, "文件不是 OpenCinema 画布")
	}
	nodes := array(v["nodes"])
	edges := array(v["edges"])
	if len(nodes) > 10000 || len(edges) > 20000 {
		return fail(413, "画布元素数量过大")
	}
	encoded, _ := json.Marshal(v)
	if len(encoded) > 8*1024*1024 {
		return fail(413, "协作画布超过8MiB")
	}
	nodeIDs := map[string]bool{}
	for _, raw := range nodes {
		id := str(asObject(raw)["id"])
		if id == "" || len(id) > 200 || nodeIDs[id] || id == "__proto__" || id == "constructor" || id == "prototype" {
			return fail(400, "画布节点 ID 无效或重复")
		}
		nodeIDs[id] = true
	}
	edgeIDs := map[string]bool{}
	for _, raw := range edges {
		edge := asObject(raw)
		id := str(edge["id"])
		if id == "" || edgeIDs[id] || !nodeIDs[str(edge["source"])] || !nodeIDs[str(edge["target"])] {
			return fail(400, "画布连线无效或引用缺失")
		}
		edgeIDs[id] = true
	}
	for _, raw := range nodes {
		node := asObject(raw)
		parent := str(node["parentNode"])
		if parent != "" && !nodeIDs[parent] {
			return fail(400, "画布分组引用缺失")
		}
	}
	return nil
}

var presentationFields = map[string]bool{"selected": true, "initialized": true, "dimensions": true, "computedPosition": true, "handleBounds": true, "isParent": true, "resizing": true, "dragging": true, "events": true, "sourceNode": true, "targetNode": true, "sourceX": true, "sourceY": true, "targetX": true, "targetY": true}

func canvasContent(document object) object {
	content := object{}
	for _, key := range []string{"nodes", "edges"} {
		elements := object{}
		for _, raw := range array(document[key]) {
			element := asObject(raw)
			clean := object{}
			for k, v := range element {
				if !presentationFields[k] {
					clean[k] = clone(v)
				}
			}
			elements[str(element["id"])] = clean
		}
		content[key] = elements
	}
	return content
}
func collaborationRuntimeUpdates(raw any, incoming object) ([]object, error) {
	if raw == nil {
		return nil, nil
	}
	items, ok := raw.([]any)
	if !ok || len(items) > 10000 {
		return nil, fail(400, "运行状态更新必须为最多10000项的数组")
	}
	encoded, err := json.Marshal(items)
	if err != nil || len(encoded) > 1024*1024 {
		return nil, fail(413, "运行状态更新超过1MiB")
	}
	updates := make([]object, 0, len(items))
	seen := map[string]bool{}
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		id := str(item["id"])
		data, validData := item["data"].(map[string]any)
		if !ok || len(item) != 2 || id == "" || len(id) > 200 || seen[id] || !validData || id == "__proto__" || id == "constructor" || id == "prototype" {
			return nil, fail(400, "运行状态更新的节点或字段无效")
		}
		seen[id] = true
		node, exists := asObject(incoming["nodes"])[id]
		incomingData := asObject(asObject(node)["data"])
		for key, value := range data {
			if key == "" || len(key) > 200 || key == "__proto__" || key == "constructor" || key == "prototype" {
				return nil, fail(400, "运行状态字段名称无效")
			}
			if current, found := incomingData[key]; exists && (!found || !reflect.DeepEqual(current, value)) {
				return nil, fail(400, "运行状态更新与提交画布中的字段不一致")
			}
		}
		updates = append(updates, item)
	}
	return updates, nil
}
func applyCollaborationRuntime(content object, updates []object) {
	nodes := asObject(content["nodes"])
	for _, update := range updates {
		node, exists := nodes[str(update["id"])]
		if !exists {
			continue
		}
		data := asObject(asObject(node)["data"])
		for key, value := range asObject(update["data"]) {
			data[key] = clone(value)
		}
		asObject(node)["data"] = data
	}
}
func mergeCanvas(base, document, current object) (object, []string, error) {
	result := asObject(clone(current))
	keys := []string{}
	for _, collection := range []string{"nodes", "edges"} {
		before := asObject(base[collection])
		after := asObject(document[collection])
		latest := asObject(current[collection])
		ids := map[string]bool{}
		for id := range before {
			ids[id] = true
		}
		for id := range after {
			ids[id] = true
		}
		for id := range ids {
			old, oldExists := before[id]
			next, nextExists := after[id]
			now, nowExists := latest[id]
			if oldExists == nextExists && reflect.DeepEqual(old, next) {
				continue
			}
			if !(oldExists == nowExists && reflect.DeepEqual(old, now)) && !(nextExists == nowExists && reflect.DeepEqual(next, now)) {
				return nil, nil, &apiError{409, "协作内容冲突，当前草稿保留；不能覆盖其他会话的修改", "ECONFLICT"}
			}
			if nextExists {
				asObject(result[collection])[id] = clone(next)
			} else {
				delete(asObject(result[collection]), id)
			}
			keys = append(keys, collection+"/"+id)
		}
	}
	return result, keys, nil
}
func contentDocument(content, original object) object {
	document := asObject(clone(original))
	for _, key := range []string{"nodes", "edges"} {
		elements := []any{}
		seen := map[string]bool{}
		for _, raw := range array(original[key]) {
			id := str(asObject(raw)["id"])
			if item, ok := asObject(content[key])[id]; ok {
				elements = append(elements, item)
				seen[id] = true
			}
		}
		for id, item := range asObject(content[key]) {
			if !seen[id] {
				elements = append(elements, item)
			}
		}
		document[key] = elements
	}
	return document
}
func (s *server) collaborationSnapshot(room *collaborationRoom, session *collaborationSession, path string) (object, error) {
	file, err := collaborationFile(room, path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var document object
	if err = json.Unmarshal(data, &document); err != nil {
		return nil, err
	}
	if err = validateCanvas(document); err != nil {
		return nil, err
	}
	undo, redo := 0, 0
	for _, entry := range room.History {
		if entry.Actor == session.Hash && entry.Path == path {
			if entry.State == "applied" {
				undo++
			} else {
				redo++
			}
		}
	}
	return object{"document": document, "role": session.Role, "history": object{"undoCount": undo, "redoCount": redo}}, nil
}
func (s *server) collaborationRoute(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	operation := strings.TrimPrefix(r.URL.Path, "/api/collaboration/")
	var input object
	var err error
	if r.Method == "GET" {
		input = object{"roomId": r.URL.Query().Get("roomId"), "path": r.URL.Query().Get("path")}
	} else {
		input, err = decode(r)
		if err != nil {
			return err
		}
	}
	s.roomsMu.Lock()
	defer s.roomsMu.Unlock()
	if operation == "open" {
		if !s.localRequest(r) {
			return fail(403, "仅本机工作区所有者可以开启协作")
		}
		directory, err := s.workspace(r, str(input["directory"]))
		if err != nil {
			return err
		}
		release, err := s.lockFiles(directory)
		if err != nil {
			return err
		}
		defer release()
		var room *collaborationRoom
		activeRooms := 0
		for _, candidate := range s.rooms {
			if !candidate.Closed {
				activeRooms++
			}
			if candidate.Directory == directory && !candidate.Closed {
				room = candidate
			}
		}
		if room == nil {
			if activeRooms >= 100 {
				return fail(429, "协作房间数量已达上限")
			}
			room = &collaborationRoom{ID: randomID(), Directory: directory, Receipts: map[string]string{}, Writers: map[string]string{}}
			s.rooms[room.ID] = room
		}
		if err = s.recoverRoom(room); err != nil {
			return err
		}
		session, err := newCollaborationSession(room, "owner", false, "")
		if err != nil {
			return err
		}
		if err = s.saveRoom(room); err != nil {
			return err
		}
		success(w, session)
		return nil
	}
	if operation == "session" {
		room := s.rooms[str(input["roomId"])]
		if room == nil || room.Closed {
			return fail(404, "协作不存在")
		}
		digest := hash([]byte(str(input["token"])))
		var invitation *collaborationSession
		for _, session := range room.Sessions {
			if session.Hash == digest && !session.Revoked && session.ExpiresAt > time.Now().UnixMilli() {
				invitation = session
			}
		}
		if invitation == nil || invitation.Joined {
			return fail(401, "邀请已失效")
		}
		if !invitation.Invitation {
			_, session, err := s.authorizeRoom(room.ID, str(input["token"]), false, false)
			if err != nil {
				return err
			}
			success(w, object{"roomId": room.ID, "token": input["token"], "role": session.Role, "expiresAt": session.ExpiresAt, "directory": room.Directory})
			return nil
		}
		invitation.Joined = true
		session, err := newCollaborationSession(room, invitation.Role, false, invitation.Hash)
		if err != nil {
			return err
		}
		if err = s.saveRoom(room); err != nil {
			return err
		}
		success(w, session)
		return nil
	}
	owner := operation == "invite" || operation == "revoke" || operation == "close"
	room, session, err := s.authorizeRoom(str(input["roomId"]), r.Header.Get("X-Toonflow-Collaboration"), operation == "command", owner)
	if err != nil {
		return err
	}
	if err = s.recoverRoom(room); err != nil {
		return err
	}
	switch operation {
	case "invite":
		role := str(input["role"])
		if role != "editor" && role != "viewer" {
			return fail(400, "邀请角色无效")
		}
		invitation, err := newCollaborationSession(room, role, true, "")
		if err != nil {
			return err
		}
		if err = s.saveRoom(room); err != nil {
			return err
		}
		success(w, invitation)
	case "revoke":
		digest := hash([]byte(str(input["invitation"])))
		found := false
		for _, candidate := range room.Sessions {
			if candidate.Hash == digest && candidate.Role != "owner" {
				candidate.Revoked = true
				found = true
			}
		}
		if !found {
			return fail(400, "此邀请不存在")
		}
		if err = s.saveRoom(room); err != nil {
			return err
		}
		success(w, nil)
	case "close":
		room.Closed = true
		if err = s.saveRoom(room); err != nil {
			return err
		}
		success(w, nil)
	case "document":
		snapshot, err := s.collaborationSnapshot(room, session, str(input["path"]))
		if err != nil {
			return err
		}
		success(w, snapshot)
	case "command":
		return s.collaborationCommand(w, room, session, asObject(input["command"]))
	default:
		return fail(404, "协作接口不存在")
	}
	return nil
}
func (s *server) collaborationCommand(w http.ResponseWriter, room *collaborationRoom, session *collaborationSession, command object) error {
	id := str(command["commandId"])
	if len(id) != 36 {
		return fail(400, "协作命令 ID 无效")
	}
	path := str(command["path"])
	file, err := collaborationFile(room, path)
	if err != nil {
		return err
	}
	fingerprintBytes, _ := json.Marshal(object{"actor": session.Hash, "command": command})
	fingerprint := hash(fingerprintBytes)
	if receipt := room.Receipts[id]; receipt != "" {
		if receipt != fingerprint {
			return fail(409, "命令ID已用于不同操作")
		}
		snapshot, err := s.collaborationSnapshot(room, session, path)
		if err != nil {
			return err
		}
		success(w, snapshot)
		return nil
	}
	if len(room.Receipts) >= 10000 {
		return fail(429, "协作命令超过10000条，请结束后重新开启")
	}
	release, err := s.lockFiles(file)
	if err != nil {
		return err
	}
	defer release()
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var document object
	if err = json.Unmarshal(data, &document); err != nil {
		return err
	}
	if err = validateCanvas(document); err != nil {
		return err
	}
	before := canvasContent(document)
	var after object
	var keys []string
	encoded, _ := json.Marshal(room)
	var draft collaborationRoom
	_ = json.Unmarshal(encoded, &draft)
	switch str(command["type"]) {
	case "edit":
		base := asObject(command["base"])
		incoming := asObject(command["document"])
		if err = validateCanvas(base); err != nil {
			return err
		}
		if err = validateCanvas(incoming); err != nil {
			return err
		}
		baseContent, incomingContent := canvasContent(base), canvasContent(incoming)
		runtimeUpdates, err := collaborationRuntimeUpdates(command["runtimeUpdates"], incomingContent)
		if err != nil {
			return err
		}
		for _, update := range runtimeUpdates {
			id := str(update["id"])
			if _, exists := asObject(incomingContent["nodes"])[id]; !exists {
				continue
			}
			current, exists := asObject(before["nodes"])[id]
			if !exists {
				continue
			}
			currentData := asObject(asObject(current)["data"])
			baseData := asObject(asObject(asObject(baseContent["nodes"])[id])["data"])
			for key, value := range asObject(update["data"]) {
				old, oldExists := baseData[key]
				now, nowExists := currentData[key]
				if !(oldExists == nowExists && reflect.DeepEqual(old, now)) && !(nowExists && reflect.DeepEqual(value, now)) {
					return &apiError{409, "运行状态已有新回执，不能覆盖迟到结果；当前草稿已保留", "ECONFLICT"}
				}
			}
		}
		// 先验证原始三方合并，迟到的运行回执不能覆盖新任务或其他会话编辑。
		after, _, err = mergeCanvas(baseContent, incomingContent, before)
		if err != nil {
			return err
		}
		currentRuntimeUpdates := []object{}
		for _, update := range runtimeUpdates {
			if _, exists := asObject(incomingContent["nodes"])[str(update["id"])]; exists {
				currentRuntimeUpdates = append(currentRuntimeUpdates, update)
			}
		}
		applyCollaborationRuntime(before, currentRuntimeUpdates)
		applyCollaborationRuntime(after, currentRuntimeUpdates)
		_, keys, err = mergeCanvas(before, after, before)
		if err != nil {
			return err
		}
		for _, entry := range draft.History {
			if entry.Path == path {
				applyCollaborationRuntime(entry.Before, runtimeUpdates)
				applyCollaborationRuntime(entry.After, runtimeUpdates)
			}
		}
		if len(keys) > 0 {
			history := []*collaborationEdit{}
			for _, entry := range draft.History {
				if entry.Actor != session.Hash || entry.Path != path || entry.State != "undone" {
					history = append(history, entry)
				}
			}
			previous := map[string]string{}
			for _, key := range keys {
				full := path + ":" + key
				previous[full] = draft.Writers[full]
				draft.Writers[full] = id
			}
			history = append(history, &collaborationEdit{ID: id, Actor: session.Hash, Path: path, State: "applied", Before: before, After: after, Keys: keys, PreviousWriters: previous})
			draft.History = history
		}
	case "undo", "redo":
		direction := str(command["type"])
		var entry *collaborationEdit
		if direction == "undo" {
			for i := len(draft.History) - 1; i >= 0; i-- {
				e := draft.History[i]
				if e.Actor == session.Hash && e.Path == path && e.State == "applied" {
					entry = e
					break
				}
			}
		} else {
			for _, e := range draft.History {
				if e.Actor == session.Hash && e.Path == path && e.State == "undone" {
					entry = e
					break
				}
			}
		}
		if entry == nil {
			return fail(409, "此会话没有可撤销或重做的编辑")
		}
		for _, key := range entry.Keys {
			full := path + ":" + key
			expected := entry.ID
			if direction == "redo" {
				expected = entry.PreviousWriters[full]
			}
			if draft.Writers[full] != expected {
				return &apiError{409, "此节点已由其他会话更新，不能覆盖后续修改", "ECONFLICT"}
			}
		}
		if direction == "undo" {
			after, _, err = mergeCanvas(entry.After, entry.Before, before)
			entry.State = "undone"
		} else {
			after, _, err = mergeCanvas(entry.Before, entry.After, before)
			entry.State = "applied"
		}
		if err != nil {
			return err
		}
		for _, key := range entry.Keys {
			full := path + ":" + key
			if direction == "undo" {
				draft.Writers[full] = entry.PreviousWriters[full]
			} else {
				draft.Writers[full] = entry.ID
			}
		}
	default:
		return fail(400, "协作命令类型无效")
	}
	result := contentDocument(after, document)
	if err = validateCanvas(result); err != nil {
		return err
	}
	for _, raw := range array(result["nodes"]) {
		for _, output := range asObject(asObject(asObject(raw)["data"])["outputs"]) {
			reference := str(asObject(asObject(output)["value"])["url"])
			if strings.HasPrefix(reference, "blob:") || strings.HasPrefix(reference, "file:") {
				return fail(409, "临时本机素材不能共享，请先保存到工作区")
			}
			if reference != "" && !strings.Contains(reference, ":") {
				path, err := workspacePath(room.Directory, reference, false)
				if err != nil {
					return err
				}
				info, err := os.Stat(path)
				if err != nil || !info.Mode().IsRegular() {
					return fail(409, "素材尚未完整保存，未发布画布修改")
				}
			}
		}
	}
	draft.Receipts[id] = fingerprint
	for len(draft.History) > 100 {
		draft.History = draft.History[1:]
	}
	for {
		history, _ := json.Marshal(draft.History)
		if len(history) <= 8*1024*1024 || len(draft.History) == 0 {
			break
		}
		draft.History = draft.History[1:]
	}
	text, _ := json.MarshalIndent(result, "", "  ")
	text = append(text, '\n')
	draft.Pending = &collaborationPending{Path: path, Previous: hash(data), Text: string(text)}
	if err = s.saveRoom(&draft); err != nil {
		return err
	}
	s.rooms[draft.ID] = &draft
	if err = atomicWrite(file, text, false, 0600); err != nil {
		return err
	}
	draft.Pending = nil
	if err = s.saveRoom(&draft); err != nil {
		return err
	}
	snapshot, err := s.collaborationSnapshot(&draft, session, path)
	if err != nil {
		return err
	}
	success(w, snapshot)
	return nil
}
func (s *server) protectCollaboration(directory, path string) error {
	s.roomsMu.Lock()
	defer s.roomsMu.Unlock()
	for _, room := range s.rooms {
		if room.Directory == directory && !room.Closed && (strings.HasSuffix(strings.ToLower(path), ".json") || path == "") {
			return fail(409, "工作区正在协作，请通过协作文档命令保存，当前草稿已保留")
		}
	}
	return nil
}
