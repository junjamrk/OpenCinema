package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// httpTask 把任务式 HTTP 服务声明在清单里，提交、轮询、取消、恢复全部沿用 generateVideoProvider。
// ACT: 取值只支持点号路径，模板只支持 {字段} 替换，不是表达式语言；状态查询固定 GET，请求体固定 JSON。
// 需要请求签名、multipart、按值换算或带凭据下载产物的服务走 adapter 协议。

var httpTaskPlaceholder = regexp.MustCompile(`\{([a-zA-Z]+)\}`)
var httpTaskValuePath = regexp.MustCompile(`^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$`)
var httpTaskJobID = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.:/=-]{0,511}$`)
var httpHeaderName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]{0,63}$`)
var httpHeaderValue = regexp.MustCompile(`^[\x20-\x7e]{0,256}$`)
var httpAuthPrefix = regexp.MustCompile(`^[a-zA-Z]{0,32} ?$`)
var reservedHTTPHeader = regexp.MustCompile(`(?i)^(host|connection|content-length|content-type|transfer-encoding|cookie|proxy-.*)$`)

// ACT: 清单不含凭据靠名字判断，写在无关字段或请求头里的密钥识别不了；上限是用户自己写进清单的值，凭据应放连接配置。
var credentialName = regexp.MustCompile(`(?i)auth|key|token|secret|cookie|signature|session`)

func taskSpec(provider object, kind string) object {
	return asObject(asObject(provider["task"])[kind])
}

func onlyKeys(value object, name string, keys ...string) error {
	for key := range value {
		known := false
		for _, candidate := range keys {
			known = known || key == candidate
		}
		if !known {
			return fail(400, "未知字段 "+name+"."+key)
		}
	}
	return nil
}

func taskMethod(raw any) string {
	if method := str(raw); method != "" {
		return method
	}
	return http.MethodPost
}

func validateHttpTask(provider object) error {
	if provider["cancelMode"] == "request" {
		return fail(400, "httpTask 用 task.<类型>.cancel 声明取消，不使用 cancelMode")
	}
	if raw, exists := provider["auth"]; exists {
		auth, valid := raw.(map[string]any)
		if !valid {
			return fail(400, "auth 须为包含 header、prefix 的对象")
		}
		if err := onlyKeys(auth, "auth", "header", "prefix"); err != nil {
			return err
		}
		header := str(auth["header"])
		if !httpHeaderName.MatchString(header) || reservedHTTPHeader.MatchString(header) || !httpAuthPrefix.MatchString(str(auth["prefix"])) {
			return fail(400, "auth.header 须为普通请求头名，auth.prefix 只能是 Bearer 这类字母前缀")
		}
	}
	if raw, exists := provider["headers"]; exists {
		headers, valid := raw.(map[string]any)
		if !valid || len(headers) > 32 {
			return fail(400, "headers 须为最多 32 项的对象")
		}
		for name, value := range headers {
			text, valid := value.(string)
			if !valid || !httpHeaderName.MatchString(name) || !httpHeaderValue.MatchString(text) || reservedHTTPHeader.MatchString(name) {
				return fail(400, "额外请求头无效: "+name)
			}
			if credentialName.MatchString(name) {
				return fail(403, "额外请求头不能携带凭据: "+name+"；鉴权用 auth 声明，密钥写在连接配置里")
			}
		}
	}
	task, valid := provider["task"].(map[string]any)
	if !valid || len(task) == 0 {
		return fail(400, "httpTask 须声明 task")
	}
	for kind, raw := range task {
		if mediaInputFields[kind] == nil {
			return fail(400, "task 只能按 image、video、audio 声明")
		}
		if err := validateTaskSpec(kind, asObject(raw)); err != nil {
			return err
		}
	}
	return nil
}

func validateTaskSpec(kind string, spec object) error {
	name := "task." + kind
	if err := onlyKeys(spec, name, "submit", "idPath", "status", "outputPath", "cancel"); err != nil {
		return err
	}
	submit, status := asObject(spec["submit"]), asObject(spec["status"])
	if err := onlyKeys(submit, name+".submit", "method", "path", "body"); err != nil {
		return err
	}
	if err := onlyKeys(status, name+".status", "path", "statePath", "states", "progressPath"); err != nil {
		return err
	}
	if method := taskMethod(submit["method"]); method != http.MethodPost && method != http.MethodPut && method != http.MethodPatch {
		return fail(400, name+".submit.method 须为 POST、PUT 或 PATCH")
	}
	if err := validateTaskPath(str(submit["path"]), "model"); err != nil {
		return err
	}
	body, valid := submit["body"].(map[string]any)
	if !valid {
		return fail(400, name+".submit.body 须为 JSON 模板对象")
	}
	found := map[string]bool{}
	taskPlaceholders(body, found)
	if !found["prompt"] {
		return fail(400, name+".submit.body 须使用 {prompt}，提示词不能静默丢弃")
	}
	for field := range found {
		known := field == "model" || field == "image"
		for _, candidate := range mediaInputFields[kind] {
			known = known || field == candidate
		}
		if !known {
			return fail(400, name+".submit.body 含未知占位符 {"+field+"}")
		}
	}
	if err := validateTaskPath(str(status["path"]), "id", "model"); err != nil {
		return err
	}
	if !strings.Contains(str(status["path"]), "{id}") {
		return fail(400, name+".status.path 须包含 {id}")
	}
	for _, path := range []string{str(spec["idPath"]), str(status["statePath"]), str(spec["outputPath"])} {
		if !httpTaskValuePath.MatchString(path) || len(path) > 256 {
			return fail(400, name+" 的 idPath、status.statePath、outputPath 须为点号路径，例如 data.videos.0.url")
		}
	}
	if path := str(status["progressPath"]); path != "" && !httpTaskValuePath.MatchString(path) {
		return fail(400, name+".status.progressPath 须为点号路径")
	}
	states, _ := status["states"].(map[string]any)
	completed := false
	for _, raw := range states {
		state := str(raw)
		completed = completed || state == "completed"
		if state != "queued" && state != "running" && state != "completed" && state != "failed" && state != "cancelled" {
			return fail(400, name+".status.states 只能映射到 queued、running、completed、failed、cancelled")
		}
	}
	if !completed {
		return fail(400, name+".status.states 须声明映射到 completed 的状态值")
	}
	if raw, exists := spec["cancel"]; exists {
		cancel, valid := raw.(map[string]any)
		if !valid {
			return fail(400, name+".cancel 须为对象")
		}
		if err := onlyKeys(cancel, name+".cancel", "method", "path"); err != nil {
			return err
		}
		if method := taskMethod(cancel["method"]); method != http.MethodPost && method != http.MethodPut && method != http.MethodDelete {
			return fail(400, name+".cancel.method 须为 POST、PUT 或 DELETE")
		}
		if err := validateTaskPath(str(cancel["path"]), "id", "model"); err != nil {
			return err
		}
		if !strings.Contains(str(cancel["path"]), "{id}") {
			return fail(400, name+".cancel.path 须包含 {id}")
		}
	}
	return nil
}

// validateTaskPath 只放行相对路径和已知占位符；查询串里不能放凭据，密钥只走 auth 声明的请求头。
func validateTaskPath(template string, allowed ...string) error {
	if template == "" || len(template) > 1024 {
		return fail(400, "任务接口路径为空或过长")
	}
	values := map[string]string{}
	for _, match := range httpTaskPlaceholder.FindAllStringSubmatch(template, -1) {
		known := false
		for _, candidate := range allowed {
			known = known || match[1] == candidate
		}
		if !known {
			return fail(400, "任务接口路径含未知占位符 {"+match[1]+"}")
		}
		values[match[1]] = "x"
	}
	expanded := taskPath(template, values)
	path, query, _ := strings.Cut(expanded, "?")
	if strings.Contains(template, "://") || strings.HasPrefix(template, "//") {
		return fail(400, "任务接口须为相对路径，不能写完整地址")
	}
	if strings.ContainsAny(expanded, "{}") || credentialName.MatchString(query) {
		return fail(400, "任务接口路径无效，查询参数不能携带凭据")
	}
	_, err := videoEndpoint("http://provider.invalid", path)
	return err
}

// taskPath 展开路径模板。路径段里保留斜杠（Google 风格的任务 ID 自带），查询串整体转义。
// 结果固定以 / 开头，{id}:cancel 里的冒号才不会被解析成 URL 协议；跨目录和绝对地址由 videoEndpoint 挡住。
func taskPath(template string, values map[string]string) string {
	path, query, hasQuery := strings.Cut(template, "?")
	fill := func(text string, escape func(string) string) string {
		return httpTaskPlaceholder.ReplaceAllStringFunc(text, func(match string) string {
			return escape(values[match[1:len(match)-1]])
		})
	}
	result := "/" + strings.TrimLeft(fill(path, func(value string) string {
		return strings.ReplaceAll(url.PathEscape(value), "%2F", "/")
	}), "/")
	if hasQuery {
		result += "?" + fill(query, url.QueryEscape)
	}
	return result
}

func taskPlaceholders(value any, found map[string]bool) {
	switch item := value.(type) {
	case string:
		for _, match := range httpTaskPlaceholder.FindAllStringSubmatch(item, -1) {
			found[match[1]] = true
		}
	case []any:
		for _, child := range item {
			taskPlaceholders(child, found)
		}
	case map[string]any:
		for _, child := range item {
			taskPlaceholders(child, found)
		}
	}
}

// fillTaskTemplate 替换 JSON 模板。整串就是一个占位符时保留原类型；没有值的字段连同键一起去掉，
// 容器被清空时也一起去掉，服务端不会收到空字段。
func fillTaskTemplate(value any, fields object) (any, bool) {
	switch item := value.(type) {
	case string:
		if match := httpTaskPlaceholder.FindStringSubmatch(item); match != nil && match[0] == item {
			field := fields[match[1]]
			return field, field != nil
		}
		complete := true
		text := httpTaskPlaceholder.ReplaceAllStringFunc(item, func(match string) string {
			field := fields[match[1:len(match)-1]]
			complete = complete && field != nil
			return fmt.Sprint(field)
		})
		return text, complete
	case []any:
		result := []any{}
		for _, child := range item {
			if filled, keep := fillTaskTemplate(child, fields); keep {
				result = append(result, filled)
			}
		}
		return result, len(result) > 0 || len(item) == 0
	case map[string]any:
		result := object{}
		for key, child := range item {
			if filled, keep := fillTaskTemplate(child, fields); keep {
				result[key] = filled
			}
		}
		return result, len(result) > 0 || len(item) == 0
	}
	return value, true
}

// taskValue 按点号取值，数组用数字下标，例如 data.videos.0.url。键名含点的字段取不到，这种服务走 adapter。
func taskValue(value any, path string) any {
	for _, part := range strings.Split(path, ".") {
		switch item := value.(type) {
		case map[string]any:
			value = item[part]
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(item) {
				return nil
			}
			value = item[index]
		default:
			return nil
		}
	}
	return value
}

func taskFields(input, refs object) object {
	fields := object{"model": input["modelId"]}
	for _, field := range mediaInputFields[str(input["mediaType"])] {
		value := input[field]
		if field == "images" || field == "videos" || field == "audios" || field == "firstFrame" || field == "lastFrame" {
			value = refs[field]
		}
		if items, listed := value.([]any); listed && len(items) == 0 {
			continue
		}
		if value != nil {
			fields[field] = value
		}
	}
	if images := array(fields["images"]); len(images) == 1 {
		fields["image"] = images[0]
	}
	return fields
}

// submitHttpTask 只在 job 落盘后才发 POST：响应丢失时 job 里没有 ID，任务停在未确认，不会重新提交。
func submitHttpTask(ctx context.Context, provider, config, input, refs, job object) (object, object, error) {
	spec := taskSpec(provider, str(input["mediaType"]))
	submit, status := asObject(spec["submit"]), asObject(spec["status"])
	fields := taskFields(input, refs)
	used := map[string]bool{}
	taskPlaceholders(submit["body"], used)
	for _, field := range []string{"images", "videos", "audios", "firstFrame", "lastFrame"} {
		if fields[field] != nil && !used[field] && (field != "images" || !used["image"] || fields["image"] == nil) {
			return nil, nil, fail(400, "此模型未声明参数映射: "+field)
		}
	}
	body, _ := fillTaskTemplate(submit["body"], fields)
	values := map[string]string{"model": str(input["modelId"])}
	if err := beginVideoSubmission(ctx, job); err != nil {
		return nil, nil, err
	}
	response, err := videoJSON(ctx, provider, config, taskMethod(submit["method"]), taskPath(str(submit["path"]), values), body)
	if err != nil {
		return nil, nil, err
	}
	id, err := taskJobID(response, str(spec["idPath"]))
	if err != nil {
		return nil, nil, err
	}
	job["id"], values["id"] = id, id
	job["statusPath"] = taskPath(str(status["path"]), values)
	if cancel := asObject(spec["cancel"]); len(cancel) > 0 {
		job["cancelPath"], job["cancelMethod"] = taskPath(str(cancel["path"]), values), taskMethod(cancel["method"])
	}
	return job, nil, updateVideoJob(ctx, job)
}

func taskJobID(response object, path string) (string, error) {
	id := ""
	switch value := taskValue(response, path).(type) {
	case string:
		id = value
	case float64:
		if value == math.Trunc(value) && math.Abs(value) < 1<<53 {
			id = strconv.FormatFloat(value, 'f', -1, 64)
		}
	}
	valid := httpTaskJobID.MatchString(id)
	for _, part := range strings.Split(id, "/") {
		valid = valid && part != "." && part != ".."
	}
	if !valid {
		return "", fail(502, "供应商未返回有效媒体任务 ID；禁止自动重新提交")
	}
	return id, nil
}

func httpTaskState(spec, response object) string {
	status := asObject(spec["status"])
	raw := ""
	if value := taskValue(response, str(status["statePath"])); value != nil {
		raw = fmt.Sprint(value)
	}
	// 键写空串时表示状态字段缺失，例如 Google operations 运行中没有 done。
	for key, state := range asObject(status["states"]) {
		if strings.EqualFold(key, raw) {
			return str(state)
		}
	}
	return "unknown"
}
