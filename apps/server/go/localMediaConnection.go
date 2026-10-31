package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type localComfyReadError struct {
	message string
	reached bool
}

func (e *localComfyReadError) Error() string { return e.message }

func localMediaConnectionState(settings object) object {
	saved := asObject(settings["localMediaConnection"])
	endpoint := str(saved["endpoint"])
	if endpoint == "" {
		endpoint = "http://127.0.0.1:8188"
	}
	config := object{"enabled": boolean(saved["enabled"]), "endpoint": endpoint, "backend": "comfyui"}
	encoded, _ := json.Marshal(config)
	return object{"connectionId": "localComfy", "config": config, "configRevision": hash(encoded), "scope": "localRuntime", "executionSupported": true}
}

func localMediaEndpoint(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || len(value) > 2048 || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || strings.ContainsAny(value, "\\\x00\r\n\t") {
		return nil, fail(400, "本地连接须为不含凭据、查询、锚点和转义路径的 HTTP 地址")
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil || (!ip.IsLoopback() && !ip.IsPrivate()) || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
		return nil, fail(403, "本地连接仅允许 localhost、环回 IP 或明确的局域网私有 IP；不解析域名或访问公网")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, fail(400, "本地连接须显式指定 1 至 65535 的端口")
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return nil, fail(400, "本地连接路径不能包含相对目录")
		}
		for _, ch := range part {
			if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-' || ch == '.') {
				return nil, fail(400, "本地连接路径仅支持字母、数字和 _-. 分段")
			}
		}
	}
	u.Host = net.JoinHostPort(ip.String(), strconv.Itoa(port))
	u.Path = strings.TrimRight(u.Path, "/")
	return u, nil
}

func (s *server) localMediaConnectionRoute(w http.ResponseWriter, r *http.Request) error {
	if !s.localRequest(r) {
		return fail(403, "本地媒体连接仅支持本机工作台或其授权 Agent")
	}
	switch r.URL.Path {
	case "/api/media/localConnection/get":
		if r.Method != "GET" {
			return fail(405, "读取本地连接仅支持 GET")
		}
		if len(r.URL.Query()) != 0 {
			return fail(400, "读取本地连接不接受查询参数")
		}
		success(w, localMediaConnectionState(s.settings()))
		return nil
	case "/api/media/localConnection/save":
		if r.Method != "PUT" {
			return fail(405, "保存本地连接仅支持 PUT")
		}
	case "/api/media/localConnection/inspect":
		if r.Method != "POST" {
			return fail(405, "检查本地连接仅支持 POST")
		}
	default:
		return fail(404, "本地媒体连接接口不存在")
	}
	if r.ContentLength > 16*1024 {
		return fail(413, "本地连接参数超过 16KiB")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	input, err := decode(r)
	if err != nil {
		return err
	}
	if strings.HasSuffix(r.URL.Path, "/inspect") {
		return s.inspectLocalMediaConnection(w, r, input)
	}
	for key := range input {
		if key != "changes" && key != "expectedRevision" {
			return fail(400, "未知本地连接字段；不接受认证信息或工作流代码")
		}
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	settings := asObject(s.config["settings"])
	state := localMediaConnectionState(settings)
	if err = requireLocalMediaRevision(input, state); err != nil {
		return err
	}
	changes, ok := input["changes"].(map[string]any)
	if !ok || len(changes) < 1 || len(changes) > 2 {
		return fail(400, "changes 须包含 enabled 或 endpoint")
	}
	next := asObject(clone(state["config"]))
	for field, raw := range changes {
		switch field {
		case "enabled":
			value, ok := raw.(bool)
			if !ok {
				return fail(400, "enabled 必须为 boolean")
			}
			next[field] = value
		case "endpoint":
			value, ok := raw.(string)
			if !ok {
				return fail(400, "endpoint 必须为 string")
			}
			endpoint, err := localMediaEndpoint(value)
			if err != nil {
				return err
			}
			next[field] = endpoint.String()
		default:
			return fail(400, "仅支持 enabled 和 endpoint；不接受认证信息或任意工作流")
		}
	}
	endpoint, err := localMediaEndpoint(str(next["endpoint"]))
	if err != nil {
		return err
	}
	next["endpoint"] = endpoint.String()
	previous := settings["localMediaConnection"]
	settings["localMediaConnection"] = next
	s.config["settings"] = settings
	if err = s.persistConfig(); err != nil {
		if previous == nil {
			delete(settings, "localMediaConnection")
		} else {
			settings["localMediaConnection"] = previous
		}
		return err
	}
	success(w, localMediaConnectionState(settings))
	return nil
}

func requireLocalMediaRevision(input, state object) error {
	revision, valid := input["expectedRevision"].(string)
	if !valid || revision == "" {
		return toolFailure("revisionRequired", "本地连接操作须携带 configRevision", "validation", "notDispatched", object{"connectionId": "localComfy"}, "readState")
	}
	if revision != state["configRevision"] {
		err := toolFailure("revisionConflict", "本地连接配置已变化，未执行操作", "target", "notDispatched", object{"connectionId": "localComfy"}, "readState").(*mcpCallError)
		err.details["actualRevision"] = state["configRevision"]
		return err
	}
	return nil
}

func localComfyClient(endpoint *url.URL) *http.Client {
	// ACT: 单个已登记的 IP、端口和路径前缀，只访问 ComfyUI 固定接口，不提供通用私网代理。
	return &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		return fail(403, "本地执行连接不接受重定向")
	}, Transport: &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != endpoint.Host {
			return nil, fail(403, "本地执行连接不能改变目标 IP 或端口")
		}
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, endpoint.Host)
	}, DisableKeepAlives: true, MaxResponseHeaderBytes: 64 * 1024}}
}

// localProviderClient 只给声明 transport:"local" 且地址通过 localMediaEndpoint 的 Provider 换固定拨号客户端；
// 公网 Provider 返回 nil，继续由 safeClient 封锁私网。返回的 base 是规范化后的地址，固定拨号按它比对目标。
func localProviderClient(provider object, base string) (*http.Client, string, error) {
	if str(provider["transport"]) != "local" {
		return nil, base, nil
	}
	endpoint, err := localMediaEndpoint(base)
	if err != nil {
		return nil, "", err
	}
	client := localComfyClient(endpoint)
	// 同步接口跑完模型才返回；任务上下文的上限也是 30 分钟。
	client.Timeout = 30 * time.Minute
	return client, endpoint.String(), nil
}

// resultClient 选产物下载的客户端：本地服务同 IP、同端口的产物走固定拨号客户端，其余一律按公网规则下载。
func resultClient(provider, config object, result string) (*http.Client, string, error) {
	client, base, err := localProviderClient(provider, providerBase(provider, config))
	if err != nil {
		return nil, "", err
	}
	if client == nil {
		return safeClient(), result, nil
	}
	target, err := url.Parse(result)
	if err != nil {
		return nil, "", fail(502, "本地服务返回的产物地址无效")
	}
	endpoint, err := url.Parse(base)
	if err != nil {
		return nil, "", err
	}
	host := target.Hostname()
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	}
	if target.Scheme != endpoint.Scheme || net.JoinHostPort(host, target.Port()) != endpoint.Host {
		return safeClient(), result, nil
	}
	target.Host = endpoint.Host
	return client, target.String(), nil
}

func localComfyJSON(ctx context.Context, client *http.Client, endpoint *url.URL, path string, maxBytes int64) (object, error) {
	if path != "/system_stats" && path != "/object_info" && path != "/queue" && !strings.HasPrefix(path, "/history/") {
		return nil, fail(403, "本地连接仅允许读取 ComfyUI 状态端点")
	}
	target := *endpoint
	target.Path += path
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, &localComfyReadError{message: fmt.Sprintf("无法读取 ComfyUI %s；服务可能未启动、地址不通或返回重定向", path), reached: response != nil}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, &localComfyReadError{message: fmt.Sprintf("ComfyUI %s 返回 HTTP %d；未读取错误正文或认证信息", path, response.StatusCode), reached: true}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, &localComfyReadError{message: fmt.Sprintf("ComfyUI %s 响应读取失败", path), reached: true}
	}
	if int64(len(data)) > maxBytes {
		return nil, &localComfyReadError{message: fmt.Sprintf("ComfyUI %s 响应超过大小限制", path), reached: true}
	}
	var result object
	if json.Unmarshal(data, &result) != nil || result == nil {
		return nil, &localComfyReadError{message: fmt.Sprintf("ComfyUI %s 未返回 JSON 对象", path), reached: true}
	}
	return result, nil
}
