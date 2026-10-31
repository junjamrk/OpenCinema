package main

import (
	"encoding/json"
	"net/http"
)

// catalogFields 只由内置目录决定：清单不能声明，旧版保存的内置供应商副本没有它们时也以目录为准。
var catalogFields = []string{"generator", "regionUrls", "supportsPrice", "supportsBalance"}

func savedBuiltinProvider(saved, builtin object) object {
	provider := asObject(clone(saved))
	for _, field := range catalogFields {
		if value, declared := builtin[field]; declared {
			provider[field] = value
		}
	}
	if provider["apiUrl"] == nil && builtin["apiUrl"] != nil {
		provider["apiUrl"] = builtin["apiUrl"]
	}
	return provider
}

func configuredProvider(settings object, id string) (object, error) {
	var builtin object
	for _, raw := range builtinMediaProviders() {
		if provider := asObject(raw); str(provider["id"]) == id {
			builtin = provider
		}
	}
	if raw, exists := asObject(settings["mediaProviders"])[id]; exists {
		if raw == nil {
			return nil, fail(404, "供应商已移除")
		}
		return savedBuiltinProvider(asObject(raw), builtin), nil
	}
	if builtin != nil {
		return builtin, nil
	}
	return nil, fail(404, "供应商不存在")
}
func secretProviderRule(rule object) bool {
	return secretField.MatchString(str(rule["field"])) || asObject(rule["props"])["type"] == "password"
}
func providerConfigurationState(provider, config object) object {
	values := object{}
	rules := []any{}
	credentials := object{}
	for _, raw := range array(provider["rules"]) {
		rule := asObject(clone(raw))
		field := str(rule["field"])
		value := config[field]
		if value == nil {
			value = rule["value"]
		}
		if secretProviderRule(rule) {
			credentials[field] = value != nil && str(value) != ""
			rule = object{"field": field, "title": rule["title"], "type": rule["type"], "secret": true, "configured": credentials[field]}
		} else {
			values[field] = value
		}
		rules = append(rules, rule)
	}
	bytes, _ := json.Marshal(object{"provider": provider, "config": config})
	return object{"providerId": provider["id"], "rules": rules, "config": values, "credentialConfigured": credentials, "configRevision": hash(bytes), "scope": "nonsecret declared provider fields; no authentication or paid generation performed"}
}
func (s *server) providerConfiguration(w http.ResponseWriter, r *http.Request) error {
	if !s.localRequest(r) {
		return fail(403, "供应商配置仅支持本机工作台")
	}
	if r.Method != "GET" && r.Method != "PUT" {
		return fail(405, "供应商配置只支持GET或PUT")
	}
	input := object{"providerId": r.URL.Query().Get("providerId")}
	var err error
	if r.Method == "PUT" {
		input, err = decode(r)
		if err != nil {
			return err
		}
	}
	for key := range input {
		if key != "providerId" && key != "changes" && key != "expectedRevision" {
			return fail(400, "未知供应商配置字段")
		}
	}
	id := str(input["providerId"])
	if !providerID.MatchString(id) {
		return fail(400, "providerId无效")
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	settings := asObject(s.config["settings"])
	provider, err := s.configurableProvider(settings, id)
	if err != nil {
		return err
	}
	configs := asObject(settings["mediaProviderConfigs"])
	current := asObject(configs[id])
	state := providerConfigurationState(provider, current)
	if r.Method == "GET" {
		success(w, state)
		return nil
	}
	if str(input["expectedRevision"]) == "" {
		return toolFailure("revisionRequired", "供应商配置写入须携带configRevision", "validation", "notDispatched", object{}, "readState")
	}
	if input["expectedRevision"] != state["configRevision"] {
		e := toolFailure("revisionConflict", "供应商配置或声明已变化，未执行写入", "target", "notDispatched", object{}, "readState").(*mcpCallError)
		e.details["actualRevision"] = state["configRevision"]
		return e
	}
	changes, ok := input["changes"].(map[string]any)
	if !ok || len(changes) == 0 || len(changes) > 100 {
		return fail(400, "changes必须包含1到100个配置字段")
	}
	allowed := map[string]object{}
	for _, raw := range array(provider["rules"]) {
		rule := asObject(raw)
		if !secretProviderRule(rule) {
			allowed[str(rule["field"])] = rule
		}
	}
	next := asObject(clone(current))
	for field, value := range changes {
		rule, exists := allowed[field]
		if !exists {
			return fail(403, "只能修改已声明的非秘密供应商字段")
		}
		switch value.(type) {
		case string:
			if len(str(value)) > 16384 {
				return fail(413, "配置文本超过16384字节")
			}
		case bool, float64:
		default:
			return fail(400, "供应商参数必须为string/boolean/number")
		}
		switch str(rule["type"]) {
		case "switch", "checkbox":
			if _, ok := value.(bool); !ok {
				return fail(400, "此字段须为boolean")
			}
		case "inputNumber", "slider":
			if _, ok := value.(float64); !ok {
				return fail(400, "此字段须为number")
			}
		}
		next[field] = value
	}
	previous := configs[id]
	configs[id] = next
	settings["mediaProviderConfigs"] = configs
	s.config["settings"] = settings
	if err = s.persistConfig(); err != nil {
		if previous == nil {
			delete(configs, id)
		} else {
			configs[id] = previous
		}
		return err
	}
	success(w, providerConfigurationState(provider, next))
	return nil
}
