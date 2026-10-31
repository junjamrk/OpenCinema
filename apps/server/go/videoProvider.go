package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed videoProviderCatalog.json
var videoProviderCatalog []byte

type videoRequestRejected struct {
	status int
	code   string
	detail string
}

func (e *videoRequestRejected) Error() string {
	return providerFailureText(e.status, strings.TrimSpace(e.code+" "+e.detail))
}

func builtinMediaProviders() []any {
	var providers, videos []any
	_ = json.Unmarshal(providerCatalog, &providers)
	_ = json.Unmarshal(videoProviderCatalog, &videos)
	return append(providers, videos...)
}

// Video providers share the existing media task and asset lifecycle. Protocols
// only translate inputs and remote jobs; they never edit the canvas or history.
func videoProtocol(provider object) string { return str(provider["videoProtocol"]) }

func providerModel(provider object, id string) object {
	for _, raw := range array(provider["models"]) {
		if model := asObject(raw); str(model["id"]) == id {
			return model
		}
	}
	return object{}
}

func validateVideoProvider(provider object) error {
	protocol := videoProtocol(provider)
	transport := str(provider["transport"])
	if transport != "" && transport != "public" && transport != "local" {
		return fail(400, "transport 须为 public 或 local")
	}
	if protocol == "" {
		// ACT: 既有适配（TF-router、APIMart 等）的请求体是逐字段写死的，声明了也送不出去，所以直接拒绝。
		// 上限是这些供应商暂时不能暴露厂商参数；升级方式是给对应适配加合入逻辑后放开此处。
		for _, raw := range array(provider["models"]) {
			if asObject(raw)["parameters"] != nil {
				return fail(400, "parameters 只支持声明了 videoProtocol 的供应商")
			}
		}
		return nil
	}
	if protocol != "openaiVideo" && protocol != "fal" && protocol != "replicate" && protocol != "ark" && protocol != "comfyui" && protocol != "httpTask" && protocol != "adapter" {
		return fail(400, "不支持的视频执行协议")
	}
	if transport == "local" && !localProtocol(protocol) {
		return fail(400, "本地连接使用 openaiVideo、comfyui、httpTask 或同步 HTTP 协议；平台协议保留公网边界")
	}
	if protocol == "comfyui" && transport != "local" {
		return fail(400, "comfyui 协议须声明 transport: local")
	}
	if protocol == "ark" {
		if err := validateArkVideoBase(providerBase(provider, object{})); err != nil {
			return err
		}
		if provider["cancelMode"] == "request" {
			return fail(400, "火山方舟不声明远端取消：DELETE 可能删除已完成任务记录")
		}
	}
	cancelMode := str(provider["cancelMode"])
	if cancelMode != "" && cancelMode != "none" && cancelMode != "request" {
		return fail(400, "cancelMode 须为 none 或 request")
	}
	if protocol == "httpTask" {
		if err := validateHttpTask(provider); err != nil {
			return err
		}
	}
	if protocol == "adapter" {
		if err := validateAdapterProvider(provider); err != nil {
			return err
		}
	}
	if protocol == "openaiVideo" {
		endpoint := str(asObject(provider["endpoints"])["video"])
		if endpoint == "" {
			return fail(400, "openaiVideo 须声明相对 endpoints.video")
		}
		if _, err := videoEndpoint(providerBase(provider, object{}), endpoint); err != nil {
			return err
		}
	}
	for _, raw := range array(provider["models"]) {
		model := asObject(raw)
		// 须在下面的 continue 之前：ComfyUI 的图片和音频模型不走后续校验。
		if err := validateModelParameters(model); err != nil {
			return err
		}
		kind := str(model["type"])
		if protocol == "comfyui" {
			if err := validateComfyModel(model); err != nil {
				return err
			}
			if kind != "video" {
				continue
			}
		} else if kind != "video" && (!protocolCoversAllMedia(protocol) || (kind != "image" && kind != "audio")) {
			return fail(400, protocol+" 协议只能声明 video 模型；图片和音频须用 fal、replicate、httpTask 或 adapter")
		}
		if protocol == "httpTask" && len(taskSpec(provider, kind)) == 0 {
			return fail(400, "模型 "+str(model["id"])+" 没有对应的 task."+kind+" 声明")
		}
		if (protocol == "httpTask" || protocol == "adapter") && model["video"] != nil {
			return fail(400, protocol+" 自己映射字段，不使用 model.video")
		}
		if audio := model["audio"]; audio != nil && audio != "optional" {
			if _, ok := audio.(bool); !ok {
				return fail(400, "视频 audio 须为布尔或 optional")
			}
		}
		if raw := model["durationResolutionMap"]; raw != nil {
			items, ok := raw.([]any)
			if !ok || len(items) > 100 {
				return fail(400, "视频时长／分辨率须为有界数组")
			}
			for _, item := range items {
				entry := asObject(item)
				durations, valid := entry["duration"].([]any)
				if !valid || len(durations) == 0 || len(durations) > 600 {
					return fail(400, "视频 duration 声明无效")
				}
				for _, raw := range durations {
					value, ok := raw.(float64)
					if !ok || value <= 0 || value > 3600 {
						return fail(400, "视频 duration 声明无效")
					}
				}
				resolutions, valid := entry["resolution"].([]any)
				if !valid || len(resolutions) > 100 {
					return fail(400, "视频 resolution 声明无效")
				}
				for _, raw := range resolutions {
					value, ok := raw.(string)
					if !ok || value == "" || len(value) > 64 {
						return fail(400, "视频 resolution 声明无效")
					}
				}
			}
		}
		if raw := model["imageRatios"]; raw != nil {
			values, ok := raw.([]any)
			if !ok || len(values) == 0 || len(values) > 100 {
				return fail(400, "视频画幅声明无效")
			}
			for _, ratio := range values {
				if !regexp.MustCompile("^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$").MatchString(str(ratio)) {
					return fail(400, "视频画幅声明无效")
				}
			}
		}
		options := asObject(model["video"])
		if protocol == "ark" && (len(asObject(options["inputMap"])) > 0 || len(array(options["stringFields"])) > 0) {
			return fail(400, "火山方舟使用固定官方参数与素材角色，不支持自定义字段映射")
		}
		for _, key := range []string{"inputMap", "defaults"} {
			if raw := options[key]; raw != nil {
				if _, ok := raw.(map[string]any); !ok {
					return fail(400, "video."+key+" 须为对象")
				}
			}
		}
		if raw := options["stringFields"]; raw != nil {
			if _, ok := raw.([]any); !ok {
				return fail(400, "video.stringFields 须为数组")
			}
		}
		if raw := model["video"]; raw != nil {
			if _, ok := raw.(map[string]any); !ok {
				return fail(400, "video 须为适配对象")
			}
		}
		for key := range options {
			if key != "inputMap" && key != "defaults" && key != "stringFields" {
				return fail(400, "未知视频模型适配字段: "+key)
			}
		}
		for source, rawField := range asObject(options["inputMap"]) {
			if !videoInputField(source) || !regexp.MustCompile("^[a-zA-Z][a-zA-Z0-9_]{0,95}$").MatchString(str(rawField)) {
				return fail(400, "视频字段映射无效")
			}
		}
		// ComfyUI 的参数按 comfy.inputs.parameters 写进工作流，不进请求体，不存在字段冲突。
		if protocol != "comfyui" {
			reserved := map[string]bool{}
			for _, target := range videoFieldTargets(model, protocol) {
				reserved[target] = true
			}
			for _, target := range videoReservedFields[protocol] {
				reserved[target] = true
			}
			for name := range asObject(asObject(model["parameters"])["properties"]) {
				if reserved[name] {
					return fail(400, "模型参数与协议字段冲突: "+name)
				}
			}
		}
		for key, value := range asObject(options["defaults"]) {
			if !regexp.MustCompile("^[a-zA-Z][a-zA-Z0-9_]{0,95}$").MatchString(key) || key == "model" || key == "prompt" {
				return fail(400, "视频默认参数字段无效")
			}
			switch value.(type) {
			case string, bool, float64:
			default:
				return fail(400, "视频默认参数仅支持文本、布尔和数字")
			}
		}
		for _, field := range array(options["stringFields"]) {
			if !videoInputField(str(field)) {
				return fail(400, "视频 stringFields 无效")
			}
		}
		if kind != "video" {
			continue
		}
		for _, rawMode := range array(model["mode"]) {
			valid := false
			if mode, ok := rawMode.(string); ok {
				for _, allowed := range []string{"text", "singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"} {
					valid = valid || mode == allowed
				}
			} else if modes, ok := rawMode.([]any); ok && len(modes) > 0 && len(modes) <= 3 {
				valid = true
				for _, item := range modes {
					valid = valid && regexp.MustCompile("^(image|video|audio)Reference:([1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-6])$").MatchString(str(item))
				}
			}
			if !valid {
				return fail(400, "视频模型 mode 声明无效")
			}
		}
		if len(array(model["mode"])) == 0 {
			return fail(400, "视频模型须声明支持的 mode，不能猜测参考能力")
		}
	}
	return nil
}

// videoReservedFields 列出协议在请求体里固定写入、又不经 inputMap 的字段。
var videoReservedFields = map[string][]string{"ark": {"model", "content", "ratio", "execution_expires_after"}, "openaiVideo": {"model", "size"}}

// videoFieldTargets 给出输入字段写入请求体时使用的字段名，inputMap 优先于协议默认值。
func videoFieldTargets(model object, protocol string) map[string]string {
	targets := map[string]string{"prompt": "prompt", "duration": "seconds"}
	if protocol != "openaiVideo" {
		targets["duration"], targets["ratio"], targets["resolution"], targets["generateAudio"] = "duration", "aspect_ratio", "resolution", "generate_audio"
	}
	for field, target := range asObject(asObject(model["video"])["inputMap"]) {
		targets[field] = str(target)
	}
	return targets
}

// videoBaseBody 是请求体的起点：用户填的模型参数覆盖 defaults，与已映射字段重名时由调用方按冲突拒绝。
func videoBaseBody(model, input object) object {
	body := asObject(clone(asObject(model["video"])["defaults"]))
	for key, value := range asObject(input["parameters"]) {
		body[key] = value
	}
	return body
}

// 这些协议的任务接口与媒体类型无关；openaiVideo 和 ark 的合同只覆盖视频。
func protocolCoversAllMedia(protocol string) bool {
	return protocol == "fal" || protocol == "replicate" || protocol == "httpTask" || protocol == "adapter"
}

func localProtocol(protocol string) bool {
	return protocol == "openaiVideo" || protocol == "comfyui" || protocol == "httpTask"
}

func providerCancelMode(provider object, kind string) string {
	protocol := videoProtocol(provider)
	if protocol == "fal" || protocol == "replicate" || provider["cancelMode"] == "request" || len(asObject(taskSpec(provider, kind)["cancel"])) > 0 {
		return "request"
	}
	return "none"
}

var mediaInputFields = map[string][]string{
	"image": {"prompt", "ratio", "size", "images"},
	"video": {"prompt", "duration", "ratio", "resolution", "generateAudio", "images", "videos", "audios", "firstFrame", "lastFrame"},
	"audio": {"prompt", "voice", "speed", "volume", "pitch", "language", "format", "sampleRate", "images", "audios"},
}

func videoInputField(key string) bool {
	for _, fields := range mediaInputFields {
		for _, field := range fields {
			if key == field {
				return true
			}
		}
	}
	return false
}

// 节点总会带上 size、ratio、language 等默认值。图片和音频模型没声明这项能力时不发占位值；
// 声明了能力却没有映射，就和未映射的参考素材一样明确拒绝。
func undeclaredMediaDefault(model object, field string) bool {
	switch field {
	case "prompt", "images", "videos", "audios":
		return false
	case "ratio":
		return len(array(model["imageRatios"])) == 0
	case "size":
		return len(array(model["imageSizes"])) == 0
	case "voice":
		return len(array(model["voices"])) == 0
	}
	return true
}

func validateVideoInputs(model, input object) error {
	if raw := input["duration"]; raw != nil && len(array(model["durationResolutionMap"])) > 0 {
		matched := false
		for _, rawRange := range array(model["durationResolutionMap"]) {
			item := asObject(rawRange)
			for _, duration := range array(item["duration"]) {
				if number(duration) != number(raw) {
					continue
				}
				if input["resolution"] == nil {
					matched = true
				}
				for _, resolution := range array(item["resolution"]) {
					if resolution == input["resolution"] {
						matched = true
					}
				}
			}
		}
		if !matched {
			return fail(400, "模型不支持此时长与分辨率组合")
		}
	}
	if ratios := array(model["imageRatios"]); input["ratio"] != nil && len(ratios) > 0 {
		matched := false
		for _, ratio := range ratios {
			matched = matched || ratio == input["ratio"]
		}
		if !matched {
			return fail(400, "模型不支持所选画幅")
		}
	}
	if input["resolution"] != nil && input["duration"] == nil && len(array(model["durationResolutionMap"])) > 0 {
		matched := false
		for _, raw := range array(model["durationResolutionMap"]) {
			for _, resolution := range array(asObject(raw)["resolution"]) {
				matched = matched || resolution == input["resolution"]
			}
		}
		if !matched {
			return fail(400, "模型不支持所选分辨率")
		}
	}
	if raw, ok := input["generateAudio"].(bool); ok && model["audio"] != "optional" && raw != boolean(model["audio"]) {
		return fail(400, "模型不支持切换音轨")
	}
	images, videos, audios := len(array(input["images"])), len(array(input["videos"])), len(array(input["audios"]))
	first, last := input["firstFrame"] != nil, input["lastFrame"] != nil
	for _, rawMode := range array(model["mode"]) {
		if input["mode"] != nil {
			a, _ := json.Marshal(input["mode"])
			b, _ := json.Marshal(rawMode)
			if string(a) != string(b) {
				continue
			}
		}
		if mode, ok := rawMode.(string); ok {
			if videos != 0 || audios != 0 {
				continue
			}
			switch mode {
			case "text":
				if images == 0 && !first && !last {
					return nil
				}
			case "singleImage":
				if images == 1 && !first && !last {
					return nil
				}
			case "startEndRequired":
				if images == 0 && first && last {
					return nil
				}
			case "endFrameOptional":
				if images == 0 && first {
					return nil
				}
			case "startFrameOptional":
				if images == 0 && last {
					return nil
				}
			}
		} else if !first && !last && images+videos+audios > 0 {
			limits := map[string]int{}
			for _, raw := range array(rawMode) {
				pair := strings.Split(str(raw), ":")
				if len(pair) == 2 {
					limits[pair[0]], _ = strconv.Atoi(pair[1])
				}
			}
			if images <= limits["imageReference"] && videos <= limits["videoReference"] && audios <= limits["audioReference"] {
				return nil
			}
		}
	}
	if len(array(model["mode"])) == 0 {
		return nil
	} // Existing vendor catalogs without a mode keep their original contract.
	return fail(400, "参考素材或 mode 不符合当前模型能力；未提交生成")
}

func videoEndpoint(base, relative string) (*url.URL, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fail(400, "媒体供应商地址无效")
	}
	r, err := url.Parse(relative)
	if err != nil || r.IsAbs() || r.Host != "" || r.RawQuery != "" || r.Fragment != "" || strings.ContainsAny(relative, "\\\x00") {
		return nil, fail(400, "视频接口须为相对路径")
	}
	for _, part := range strings.Split(r.Path, "/") {
		if part == ".." || part == "." {
			return nil, fail(400, "视频接口不能跨目录")
		}
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/" + strings.TrimLeft(r.Path, "/")
	u.RawPath = ""
	return u, nil
}

func videoClient(provider, config object) (*http.Client, error) {
	if _, err := videoEndpoint(providerBase(provider, config), ""); err != nil {
		return nil, err
	}
	if videoProtocol(provider) == "ark" {
		if err := validateArkVideoBase(providerBase(provider, config)); err != nil {
			return nil, err
		}
	}
	if str(provider["transport"]) != "local" {
		return safeClient(), nil
	}
	endpoint, err := localMediaEndpoint(providerBase(provider, config))
	if err != nil {
		return nil, err
	}
	client := localComfyClient(endpoint)
	client.Timeout = 2 * time.Minute
	return client, nil
}

func validateArkVideoBase(base string) error {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host != "ark.cn-beijing.volces.com" || u.Path != "/api/v3" || u.RawPath != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fail(403, "火山方舟凭据仅允许发送至官方 https://ark.cn-beijing.volces.com/api/v3")
	}
	return nil
}

func videoRequest(ctx context.Context, provider, config object, method, relative string, body io.Reader, contentType string) (*http.Response, error) {
	base := providerBase(provider, config)
	if provider["transport"] == "local" {
		endpoint, err := localMediaEndpoint(base)
		if err != nil {
			return nil, err
		}
		base = endpoint.String()
	}
	path, query, _ := strings.Cut(relative, "?")
	u, err := videoEndpoint(base, path)
	if err != nil {
		return nil, err
	}
	u.RawQuery = query
	client, err := videoClient(provider, config)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(strings.TrimPrefix(str(config["apiKey"]), "Bearer "))
	if key == "" && str(provider["transport"]) != "local" {
		return nil, fail(400, "请先配置媒体供应商 API Key")
	}
	if videoProtocol(provider) == "httpTask" {
		for name, value := range asObject(provider["headers"]) {
			req.Header.Set(name, str(value))
		}
	}
	header, prefix := videoAuthHeader(provider)
	if key != "" {
		req.Header.Set(header, prefix+key)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if header != "Authorization" {
		// 标准库跨域重定向只剥离 Authorization，自定义鉴权头会被带走，这里一律不跟随跨来源重定向。
		follow := client.CheckRedirect
		strict := *client
		strict.CheckRedirect = func(r *http.Request, via []*http.Request) error {
			if r.URL.Host != via[0].URL.Host || r.URL.Scheme != via[0].URL.Scheme {
				return fail(403, "带凭据的供应商请求不能跨来源重定向")
			}
			return follow(r, via)
		}
		client = &strict
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, submissionError(method == "POST", fmt.Errorf("媒体供应商连接失败: %w", err))
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := ""
		if videoProtocol(provider) == "ark" {
			var result object
			if json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result) == nil {
				value := str(asObject(result["error"])["code"])
				if regexp.MustCompile("^[a-zA-Z][a-zA-Z0-9._-]{0,127}$").MatchString(value) {
					code = value
				}
			}
		}
		response.Body.Close()
		if providerRejected(response.StatusCode) {
			return nil, &videoRequestRejected{status: response.StatusCode, code: code}
		}
		return nil, fail(502, providerFailureText(response.StatusCode, ""))
	}
	return response, nil
}

func videoAuthHeader(provider object) (string, string) {
	switch videoProtocol(provider) {
	case "fal":
		return "Authorization", "Key "
	case "httpTask":
		if auth := asObject(provider["auth"]); str(auth["header"]) != "" {
			return str(auth["header"]), str(auth["prefix"])
		}
	}
	return "Authorization", "Bearer "
}

func videoJSON(ctx context.Context, provider, config object, method, relative string, body any) (object, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		if videoProtocol(provider) == "ark" && len(data) >= 64*1024*1024 {
			return nil, fail(413, "火山方舟视频请求须小于64MiB；未提交生成")
		}
		reader = bytes.NewReader(data)
	}
	response, err := videoRequest(ctx, provider, config, method, relative, reader, "application/json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == 204 {
		return object{}, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 2*1024*1024 {
		return nil, fail(502, "媒体任务响应超过2MiB")
	}
	var result object
	if json.Unmarshal(data, &result) != nil || result == nil {
		return nil, fail(502, "媒体任务响应须为 JSON 对象")
	}
	return result, nil
}

func videoBody(model, input, refs object, protocol string) (object, error) {
	if protocol == "ark" {
		return arkVideoBody(model, input, refs)
	}
	options := asObject(model["video"])
	body := videoBaseBody(model, input)
	mapping := asObject(options["inputMap"])
	targets := videoFieldTargets(model, protocol)
	kind := str(model["type"])
	for _, field := range mediaInputFields[kind] {
		value := input[field]
		if protocol == "openaiVideo" && field == "generateAudio" && mapping[field] == nil && model["audio"] != "optional" {
			continue
		}
		if kind != "video" && mapping[field] == nil && undeclaredMediaDefault(model, field) {
			continue
		}
		if field == "images" || field == "videos" || field == "audios" || field == "firstFrame" || field == "lastFrame" {
			value = refs[field]
		}
		if value == nil {
			continue
		}
		if items, ok := value.([]any); ok && len(items) == 0 {
			continue
		}
		target := targets[field]
		if target == "" {
			if field == "ratio" || field == "resolution" {
				continue
			} // Both are converted to literal size below for the OpenAI protocol.
			return nil, fail(400, "此模型未声明参数映射: "+field)
		}
		for _, raw := range array(options["stringFields"]) {
			if str(raw) == field {
				value = fmt.Sprint(value)
			}
		}
		if body[target] != nil {
			return nil, fail(400, "视频字段映射与默认参数冲突: "+target)
		}
		body[target] = value
	}
	if protocol == "openaiVideo" {
		body["model"] = model["id"]
		if input["ratio"] != nil || input["resolution"] != nil {
			if mapping["ratio"] == nil && mapping["resolution"] == nil {
				resolution := strings.TrimSuffix(str(input["resolution"]), "p")
				short, _ := strconv.Atoi(resolution)
				ratio := strings.Split(str(input["ratio"]), ":")
				if short <= 0 || len(ratio) != 2 {
					return nil, fail(400, "OpenAI 视频服务需要明确的画幅与分辨率")
				}
				a, _ := strconv.Atoi(ratio[0])
				b, _ := strconv.Atoi(ratio[1])
				if a <= 0 || b <= 0 {
					return nil, fail(400, "视频画幅无效")
				}
				width, height := short, short
				if a >= b {
					width = short * a / b
				} else {
					height = short * b / a
				}
				body["size"] = fmt.Sprintf("%dx%d", width, height)
			}
		}
	}
	return body, nil
}

func arkVideoBody(model, input, refs object) (object, error) {
	body := videoBaseBody(model, input)
	if refs["executionExpiresAfter"] != nil {
		if number(refs["executionExpiresAfter"]) != 3600 {
			return nil, fail(400, "临时参考仅支持已声明的1小时方舟任务预算")
		}
		if _, err := mediaReferenceExpiry(refs["referenceExpiresAt"]); err != nil {
			return nil, err
		}
		body["execution_expires_after"] = 3600
	}
	body["model"] = model["id"]
	content := []any{object{"type": "text", "text": input["prompt"]}}
	appendImage := func(value any, role string) error {
		data := str(value)
		parts := strings.SplitN(data, ",", 2)
		if len(parts) != 2 || !strings.HasPrefix(parts[0], "data:image/") || !strings.HasSuffix(parts[0], ";base64") || base64.StdEncoding.DecodedLen(len(parts[1])) >= 30*1024*1024 {
			return fail(400, "火山方舟参考图片须为小于30MiB的图片")
		}
		content = append(content, object{"type": "image_url", "image_url": object{"url": data}, "role": role})
		return nil
	}
	images := array(refs["images"])
	for _, image := range images {
		role := "first_frame"
		if len(images) > 1 || len(array(input["mode"])) > 0 || len(array(refs["videos"])) > 0 {
			role = "reference_image"
		}
		if err := appendImage(image, role); err != nil {
			return nil, err
		}
	}
	for _, pair := range [][2]string{{"firstFrame", "first_frame"}, {"lastFrame", "last_frame"}} {
		if refs[pair[0]] != nil {
			if err := appendImage(refs[pair[0]], pair[1]); err != nil {
				return nil, err
			}
		}
	}
	for _, raw := range array(refs["videos"]) {
		value, err := arkReferenceURL(str(raw))
		if err != nil {
			return nil, err
		}
		content = append(content, object{"type": "video_url", "video_url": object{"url": value}, "role": "reference_video"})
	}
	if len(array(refs["audios"])) > 0 {
		return nil, fail(400, "当前火山方舟连接未声明音频参考；未提交生成")
	}
	body["content"] = content
	for _, field := range []string{"duration", "ratio", "resolution"} {
		if input[field] != nil {
			body[field] = input[field]
		}
	}
	if input["generateAudio"] != nil {
		body["generate_audio"] = input["generateAudio"]
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	if len(data) >= 64*1024*1024 {
		return nil, fail(413, "火山方舟视频请求须小于64MiB；未提交生成")
	}
	return body, nil
}

func newRemoteJob(ctx context.Context, provider, config, input object) object {
	job := currentVideoJob(ctx)
	job["protocol"], job["providerId"], job["modelId"] = videoProtocol(provider), provider["id"], input["modelId"]
	job["providerRevision"], job["configRevision"], job["cancelMode"] = provider["revision"], videoConfigRevision(config), providerCancelMode(provider, str(input["mediaType"]))
	delete(job, "phase")
	return job
}

func submitVideo(ctx context.Context, provider, config, input, refs object) (object, object, error) {
	protocol := videoProtocol(provider)
	job := newRemoteJob(ctx, provider, config, input)
	if protocol == "httpTask" {
		return submitHttpTask(ctx, provider, config, input, refs, job)
	}
	model := providerModel(provider, str(input["modelId"]))
	body, err := videoBody(model, input, refs, protocol)
	if err != nil {
		return nil, nil, err
	}
	endpoint := str(asObject(provider["endpoints"])["video"])
	if protocol == "fal" {
		endpoint = str(model["id"])
	}
	if protocol == "ark" {
		endpoint = "contents/generations/tasks"
	}
	if protocol == "replicate" {
		parts := strings.Split(str(model["id"]), "/")
		if len(parts) != 2 {
			return nil, nil, fail(400, "Replicate 模型 ID 须为 owner/name")
		}
		endpoint = "models/" + parts[0] + "/" + parts[1] + "/predictions"
		body = object{"input": body}
	}
	var response object
	if protocol == "openaiVideo" {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		for field, value := range body {
			text, ok := value.(string)
			if ok && strings.HasPrefix(text, "data:") {
				parts := strings.SplitN(text, ",", 2)
				if len(parts) != 2 {
					return nil, nil, fail(400, "视频参考数据无效")
				}
				data, err := base64.StdEncoding.DecodeString(parts[1])
				if err != nil {
					return nil, nil, err
				}
				part, err := writer.CreateFormFile(field, "reference"+map[string]string{"data:image/png;base64": ".png", "data:image/jpeg;base64": ".jpg", "data:video/mp4;base64": ".mp4", "data:audio/wav;base64": ".wav"}[parts[0]])
				if err != nil {
					return nil, nil, err
				}
				if _, err = part.Write(data); err != nil {
					return nil, nil, err
				}
			} else {
				if !ok {
					data, err := json.Marshal(value)
					if err != nil {
						return nil, nil, err
					}
					text = string(data)
				}
				if err = writer.WriteField(field, text); err != nil {
					return nil, nil, err
				}
			}
		}
		if err = writer.Close(); err != nil {
			return nil, nil, err
		}
		if err = beginVideoSubmission(ctx, job); err != nil {
			return nil, nil, err
		}
		res, err := videoRequest(ctx, provider, config, http.MethodPost, endpoint, &buffer, writer.FormDataContentType())
		if err != nil {
			return nil, nil, err
		}
		defer res.Body.Close()
		if err = json.NewDecoder(io.LimitReader(res.Body, 2*1024*1024)).Decode(&response); err != nil {
			return nil, nil, fail(502, "视频提交响应无效")
		}
	} else {
		if err = beginVideoSubmission(ctx, job); err != nil {
			return nil, nil, err
		}
		response, err = videoJSON(ctx, provider, config, http.MethodPost, endpoint, body)
		if err != nil {
			return nil, nil, err
		}
	}
	id := str(response["id"])
	if protocol == "fal" {
		id = str(response["request_id"])
	}
	if !regexp.MustCompile("^[a-zA-Z0-9_-]{1,256}$").MatchString(id) {
		return nil, nil, fail(502, "供应商未返回有效媒体任务 ID；禁止自动重新提交")
	}
	job["id"] = id
	switch protocol {
	case "ark":
		job["statusPath"] = "contents/generations/tasks/" + id
	case "openaiVideo":
		job["statusPath"] = strings.TrimRight(endpoint, "/") + "/" + id
		job["resultPath"] = str(job["statusPath"]) + "/content"
		job["cancelPath"], job["cancelMethod"] = job["statusPath"], http.MethodDelete
	case "replicate":
		job["statusPath"] = "predictions/" + id
		job["cancelPath"], job["cancelMethod"] = "predictions/"+id+"/cancel", http.MethodPost
	case "fal":
		for field, remote := range map[string]string{"statusPath": "status_url", "resultPath": "response_url", "cancelPath": "cancel_url"} {
			value, err := videoResponsePath(providerBase(provider, config), str(response[remote]))
			if err != nil {
				return nil, nil, err
			}
			suffix := "/requests/" + id
			if field == "statusPath" {
				suffix += "/status"
			}
			if field == "cancelPath" {
				suffix += "/cancel"
			}
			if !strings.HasSuffix(value, suffix) {
				return nil, nil, fail(502, "fal 返回的任务地址未绑定本次 request_id")
			}
			job[field] = value
		}
		job["cancelMethod"] = http.MethodPut
	}
	if err = updateVideoJob(ctx, job); err != nil {
		return nil, nil, err
	}
	return job, response, nil
}

func videoResponsePath(base, value string) (string, error) {
	b, err := url.Parse(strings.TrimRight(base, "/") + "/")
	if err != nil {
		return "", err
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fail(502, "媒体任务地址无效")
	}
	u = b.ResolveReference(u)
	if u.Scheme != b.Scheme || u.Host != b.Host || !strings.HasPrefix(u.Path, b.Path) {
		return "", fail(502, "媒体任务地址不能改变供应商来源或路径边界")
	}
	return strings.TrimPrefix(u.Path, b.Path), nil
}

func videoOutputURLs(result, provider object, kind string) []string {
	protocol := videoProtocol(provider)
	values := []string{}
	var collect func(any)
	collect = func(raw any) {
		switch value := raw.(type) {
		case string:
			values = append(values, value)
		case []any:
			for _, item := range value {
				collect(item)
			}
		case map[string]any:
			if str(value["url"]) != "" {
				collect(value["url"])
			}
		}
	}
	if protocol == "httpTask" {
		collect(taskValue(result, str(taskSpec(provider, kind)["outputPath"])))
	} else if protocol == "adapter" {
		collect(result["outputs"])
	} else if protocol == "ark" {
		collect(asObject(result["content"])["video_url"])
	} else if protocol == "replicate" {
		collect(result["output"])
	} else {
		collect(result[kind])
		collect(result[kind+"s"])
	}
	return values
}

func remoteJobState(provider object, kind string, result object) string {
	if videoProtocol(provider) == "httpTask" {
		return httpTaskState(taskSpec(provider, kind), result)
	}
	return videoRemoteState(result)
}

func videoRemoteState(result object) string {
	status := strings.ToLower(str(result["status"]))
	switch status {
	case "queued", "in_queue", "starting":
		return "queued"
	case "in_progress", "processing", "running":
		return "running"
	case "completed", "succeeded":
		if result["error"] != nil {
			return "failed"
		}
		return "completed"
	case "failed", "expired":
		return "failed"
	case "cancelled", "canceled":
		return "cancelled"
	}
	return "unknown"
}
