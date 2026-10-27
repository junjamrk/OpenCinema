package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

var canvasColor = regexp.MustCompile(`^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$`)
var canvasKey = regexp.MustCompile(`^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$`)

func generalConfigurationState(settings object) object {
	general := object{}
	for key, value := range asObject(settings["general"]) {
		if allowedGeneralField(key) {
			general[key] = clone(value)
		}
	}
	bytes, _ := json.Marshal(general)
	return object{"general": general, "configRevision": hash(bytes)}
}

func allowedGeneralField(field string) bool {
	return field == "nodeMenu" || field == "canvasShortcuts" || field == "canvasEdgeAnimationEnabled" || field == "canvasEdgeColorMode" || field == "canvasEdgeColor"
}

func validateNodeMenu(value any) error {
	count := 0
	ids := map[string]bool{}
	var visit func(any, int) error
	visit = func(value any, depth int) error {
		items, ok := value.([]any)
		if !ok || len(items) > 512 || depth > 3 {
			return fail(400, "nodeMenu 必须为最多三级的菜单数组")
		}
		for _, raw := range items {
			count++
			if count > 512 {
				return fail(413, "节点菜单不能超过 512 项")
			}
			item, ok := raw.(map[string]any)
			if text, valid := raw.(string); valid {
				item, ok = object{"type": text}, true
			}
			if !ok {
				return fail(400, "菜单项必须为节点类型或菜单对象")
			}
			if hidden, exists := item["hidden"]; exists {
				if _, valid := hidden.(bool); !valid {
					return fail(400, "菜单 hidden 必须为 boolean")
				}
			}
			id := ""
			if nodeType, exists := item["type"]; exists {
				text, valid := nodeType.(string)
				if !valid || strings.TrimSpace(text) == "" || len(text) > 200 || text != strings.TrimSpace(text) {
					return fail(400, "节点菜单 type 无效")
				}
				id = "node:" + text
				for field := range item {
					if field != "type" && field != "alias" && field != "hidden" {
						return fail(400, "节点菜单只支持 type、alias、hidden")
					}
				}
				if alias, exists := item["alias"]; exists {
					if text, valid := alias.(string); !valid || len(text) > 200 {
						return fail(400, "节点菜单 alias 必须为最多 200 字节的文本")
					}
				}
			} else {
				id = str(item["id"])
				label := strings.TrimSpace(str(item["label"]))
				if !strings.HasPrefix(id, "group:") || len(id) <= 6 || len(id) > 200 || label == "" || len(label) > 200 || depth >= 3 {
					return fail(400, "菜单分组须有 group: 开头的 id、名称且子项不超过三级")
				}
				for field := range item {
					if field != "id" && field != "label" && field != "children" && field != "hidden" {
						return fail(400, "菜单分组包含未知字段")
					}
				}
				if err := visit(item["children"], depth+1); err != nil {
					return err
				}
			}
			if ids[id] {
				return fail(400, "节点菜单类型或分组 id 重复")
			}
			ids[id] = true
		}
		return nil
	}
	return visit(value, 1)
}

func normalizeCanvasShortcut(action, value string) (string, error) {
	fields := map[string]bool{"group": false, "mergeGroup": false, "ungroup": false, "addNode": false, "copyOnDrag": true, "duplicateOnDrag": true, "pan": true, "zoom": true, "selection": true, "multiSelection": true, "moveTool": false, "handTool": false, "arrange": false, "search": false, "delete": false, "copy": false, "paste": false, "undo": false, "redo": false, "zoomIn": false, "zoomOut": false, "fitView": false}
	_, exists := fields[action]
	if !exists || len(value) > 512 {
		return "", fail(400, "画布快捷键名称无效或值过长")
	}
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	modifiers := []string{"Ctrl", "Alt", "Shift", "Meta"}
	keys := strings.Fields("Space Escape Enter Tab Backspace Delete ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown Insert Minus Equal BracketLeft BracketRight Backslash Semicolon Quote Comma Period Slash Backquote CapsLock NumLock ScrollLock Pause PrintScreen NumpadAdd NumpadSubtract NumpadMultiply NumpadDivide NumpadDecimal NumpadEnter NumpadEqual")
	bindings := []string{}
	seen := map[string]bool{}
	for _, binding := range strings.Split(value, "/") {
		binding = strings.TrimSpace(binding)
		if binding == "None" {
			if action != "pan" && action != "zoom" && action != "selection" {
				return "", fail(400, "此画布快捷键不支持 None")
			}
		} else {
			parts := map[string]bool{}
			key := ""
			for _, part := range strings.Split(binding, "+") {
				part = strings.TrimSpace(part)
				if parts[part] || part == "" {
					return "", fail(400, "快捷键包含空白或重复按键")
				}
				parts[part] = true
				modifier := false
				for _, candidate := range modifiers {
					modifier = modifier || part == candidate
				}
				if modifier {
					continue
				}
				valid := canvasKey.MatchString(part)
				for _, candidate := range keys {
					valid = valid || part == candidate
				}
				if !valid || key != "" {
					return "", fail(400, "快捷键最多包含一个已知按键")
				}
				key = part
			}
			gesture := action == "copyOnDrag" || action == "duplicateOnDrag" || action == "multiSelection"
			if gesture && key != "" || !fields[action] && key == "" {
				return "", fail(400, "快捷键与该操作的按键方式不匹配")
			}
			ordered := []string{}
			for _, modifier := range modifiers {
				if parts[modifier] {
					ordered = append(ordered, modifier)
				}
			}
			if key != "" {
				ordered = append(ordered, key)
			}
			binding = strings.Join(ordered, "+")
		}
		if !seen[binding] {
			bindings = append(bindings, binding)
			seen[binding] = true
		}
	}
	return strings.Join(bindings, " / "), nil
}

func (s *server) generalConfiguration(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	if !s.localRequest(r) {
		return fail(403, "画布设置仅支持本机工作台")
	}
	if r.Method != "GET" && r.Method != "PUT" {
		return fail(405, "画布设置只支持 GET 或 PUT")
	}
	input := object{}
	if r.Method == "PUT" {
		var err error
		input, err = decode(r)
		if err != nil {
			return err
		}
		for field := range input {
			if field != "changes" && field != "expectedRevision" {
				return fail(400, "画布设置请求包含未知字段")
			}
		}
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	settings := asObject(s.config["settings"])
	state := generalConfigurationState(settings)
	if r.Method == "GET" {
		success(w, state)
		return nil
	}
	if str(input["expectedRevision"]) == "" {
		return toolFailure("revisionRequired", "画布设置须携带 configRevision", "validation", "notDispatched", object{}, "readState")
	}
	if input["expectedRevision"] != state["configRevision"] {
		return stale("画布设置已变化，请重新读取 configRevision；未执行保存")
	}
	changes, ok := input["changes"].(map[string]any)
	if !ok || len(changes) == 0 || len(changes) > 5 {
		return fail(400, "changes 须包含 1 至 5 项画布设置")
	}
	next := asObject(clone(settings["general"]))
	for field, value := range changes {
		switch field {
		case "nodeMenu":
			if err := validateNodeMenu(value); err != nil {
				return err
			}
		case "canvasShortcuts":
			shortcuts, valid := value.(map[string]any)
			if !valid || len(shortcuts) > 22 {
				return fail(400, "canvasShortcuts 必须为已知操作与按键组合的对象")
			}
			merged := asObject(clone(next[field]))
			for action, raw := range shortcuts {
				text, valid := raw.(string)
				if !valid {
					return fail(400, "画布快捷键必须为文本")
				}
				normalized, err := normalizeCanvasShortcut(action, text)
				if err != nil {
					return err
				}
				merged[action] = normalized
			}
			value = merged
		case "canvasEdgeAnimationEnabled":
			if _, valid := value.(bool); !valid {
				return fail(400, "canvasEdgeAnimationEnabled 必须为 boolean")
			}
		case "canvasEdgeColorMode":
			if value != "none" && value != "theme" && value != "custom" {
				return fail(400, "连线颜色模式须为 none、theme 或 custom")
			}
		case "canvasEdgeColor":
			if !canvasColor.MatchString(str(value)) {
				return fail(400, "连线颜色须为 3、4、6 或 8 位十六进制颜色")
			}
		default:
			return fail(403, "只能修改白名单内的画布设置")
		}
		next[field] = value
	}
	previous := settings["general"]
	settings["general"] = next
	s.config["settings"] = settings
	if err := s.persistConfig(); err != nil {
		if previous == nil {
			delete(settings, "general")
		} else {
			settings["general"] = previous
		}
		return err
	}
	success(w, generalConfigurationState(settings))
	return nil
}
