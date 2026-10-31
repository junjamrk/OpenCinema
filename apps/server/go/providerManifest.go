package main

import (
	"encoding/json"
	"net"
	"net/url"
	"strings"
)

func providerManifestHasSecret(value any) bool {
	empty := func(value any) bool {
		if value == nil {
			return true
		}
		text, valid := value.(string)
		return valid && text == ""
	}
	switch item := value.(type) {
	case map[string]any:
		if secretProviderRule(item) && !empty(item["value"]) {
			return true
		}
		for field, child := range item {
			if field == "showPassword" {
				if _, metadata := child.(bool); metadata {
					continue
				}
			}
			if secretField.MatchString(field) && !empty(child) || providerManifestHasSecret(child) {
				return true
			}
		}
	case []any:
		for _, child := range item {
			if providerManifestHasSecret(child) {
				return true
			}
		}
	}
	return false
}

func parseHTTPProvider(source string) (object, error) {
	if len(source) == 0 || len(source) > 2*1024*1024 {
		return nil, fail(400, "供应商清单为空或超过2MiB")
	}
	var provider object
	if json.Unmarshal([]byte(source), &provider) != nil || provider == nil {
		return nil, fail(400, "Go 媒体供应商使用 HTTP JSON manifest，不执行 TypeScript 脚本")
	}
	if providerManifestHasSecret(provider) {
		return nil, fail(403, "供应商清单不能包含凭据或非空秘密默认值；请在工作台连接配置中填写")
	}
	id := str(provider["id"])
	if !providerID.MatchString(id) || strings.TrimSpace(str(provider["label"])) == "" || len(str(provider["label"])) > 200 {
		return nil, fail(400, "供应商 ID 或名称无效")
	}
	if str(provider["transport"]) == "local" {
		if _, err := localMediaEndpoint(str(provider["apiUrl"])); err != nil {
			return nil, err
		}
	}
	for _, key := range []string{"apiUrl", "modelsUrl"} {
		value := str(provider[key])
		if value == "" && (key == "modelsUrl" || videoProtocol(provider) == "adapter") {
			continue
		}
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
			return nil, fail(400, "供应商地址须为不含凭据、查询和锚点的 HTTP URL")
		}
		if str(provider["transport"]) == "local" {
			if _, err := localMediaEndpoint(value); err != nil {
				return nil, err
			}
		} else if ip := net.ParseIP(u.Hostname()); ip != nil && (!ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || reservedIP(ip)) {
			return nil, fail(403, "供应商地址不能使用本机或内部网络")
		}
	}
	models, valid := provider["models"].([]any)
	// ComfyUI 的模型是用户随后导入的工作流，新建连接时可以为空。
	if !valid || len(models) == 0 && videoProtocol(provider) != "comfyui" || len(models) > 2000 {
		return nil, fail(400, "供应商须声明1至2000个媒体模型")
	}
	seen := map[string]bool{}
	endpoints := asObject(provider["endpoints"])
	for _, raw := range models {
		model := asObject(raw)
		id := str(model["id"])
		kind := str(model["type"])
		if strings.TrimSpace(str(model["label"])) == "" {
			model["label"] = id
		}
		if id == "" || len(id) > 256 || seen[id] || (kind != "image" && kind != "video" && kind != "audio") {
			return nil, fail(400, "供应商模型 ID 重复或类型无效")
		}
		if len(str(model["label"])) > 200 {
			return nil, fail(400, "供应商模型名称不能超过 200 字节")
		}
		seen[id] = true
		if videoProtocol(provider) != "" {
			continue
		}
		if str(provider["protocol"]) == "openai" && kind == "image" {
			continue
		}
		endpoint := str(endpoints[kind])
		u, err := url.Parse(endpoint)
		if err != nil || endpoint == "" || u.IsAbs() || u.Host != "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || strings.Contains(endpoint, "\\") {
			return nil, fail(400, "供应商须声明每种媒体的相对 HTTP 端点")
		}
		for _, part := range strings.Split(u.Path, "/") {
			if part == ".." || part == "." {
				return nil, fail(400, "供应商端点不能跨目录")
			}
		}
	}
	if err := validateVideoProvider(provider); err != nil {
		return nil, err
	}
	if rules, ok := provider["rules"]; ok {
		items, valid := rules.([]any)
		if !valid || len(items) > 100 {
			return nil, fail(400, "供应商 rules 必须为最多 100 项的数组")
		}
		fields := map[string]bool{}
		for _, raw := range items {
			rule, valid := raw.(map[string]any)
			field := str(rule["field"])
			if !valid || !providerID.MatchString(field) || fields[field] || len(str(rule["title"])) > 200 {
				return nil, fail(400, "供应商配置字段须为唯一的小驼峰 field 和可选名称")
			}
			fields[field] = true
			switch str(rule["type"]) {
			case "input", "inputNumber", "slider", "switch", "checkbox", "select":
			default:
				return nil, fail(400, "供应商配置仅支持 input、inputNumber、slider、switch、checkbox 或 select")
			}
		}
	}
	provider["fileName"] = id + ".json"
	bytes, _ := json.Marshal(provider)
	provider["revision"] = hash(bytes)
	provider["loadError"] = ""
	return provider, nil
}
