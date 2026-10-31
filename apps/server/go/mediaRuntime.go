package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed providerCatalog.json
var providerCatalog []byte

type mediaTask struct {
	directory        string
	inputHash        string
	done             chan struct{}
	submitted        atomic.Bool
	cancelRequested  bool
	unknown          bool
	cancel           context.CancelFunc
	touched, settled time.Time
	result           object
	request          object
	job              object
	cost             object
	remoteSettled    bool
}

type mediaSubmissionKey struct{}

func markMediaSubmitted(ctx context.Context) {
	if submitted, ok := ctx.Value(mediaSubmissionKey{}).(*atomic.Bool); ok {
		submitted.Store(true)
	}
}
func mediaTaskState(id string, task *mediaTask) object {
	settled := !task.settled.IsZero()
	status := "running"
	if task.cancelRequested && !settled {
		status = "cancelRequested"
	}
	if settled {
		status = "failed"
		if number(task.result["code"]) == 200 {
			status = "completed"
		} else if number(task.result["code"]) == 499 {
			status = "cancelled"
		}
	}
	if task.unknown {
		status = "unknown"
	}
	sideEffectMayContinue := task.submitted.Load() && !task.remoteSettled && settled && status != "completed"
	item := object{"taskId": id, "status": status, "executionSettled": settled, "sideEffectMayContinue": sideEffectMayContinue, "cost": object{"estimate": task.cost["estimate"], "actual": task.cost["actual"]}}
	if len(task.job) > 0 {
		for destination, source := range map[string]string{"providerId": "providerId", "modelId": "modelId", "protocol": "protocol", "providerJobId": "id", "phase": "status", "cancelMode": "cancelMode"} {
			if value := str(task.job[source]); value != "" {
				item[destination] = value
			}
		}
		if task.job["progress"] != nil {
			item["progress"] = task.job["progress"]
		}
	}
	if task.result != nil {
		item["result"] = task.result
	}
	return item
}

func safeClient() *http.Client { return outboundHTTPClient }

var outboundHTTPClient = &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
	if len(via) > 5 {
		return fmt.Errorf("重定向过多")
	}
	if len(via) > 0 && via[0].Header.Get("Authorization") != "" && (r.URL.Host != via[0].URL.Host || r.URL.Scheme != via[0].URL.Scheme) {
		return fail(403, "带凭据的供应商请求不能跨来源重定向")
	}
	return nil
}, Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if !ip.IP.IsGlobalUnicast() || ip.IP.IsLoopback() || ip.IP.IsPrivate() || ip.IP.IsLinkLocalUnicast() || ip.IP.IsUnspecified() || reservedIP(ip.IP) {
			return nil, fail(403, "远程素材不能访问本机或内部网络")
		}
	}
	sort.SliceStable(ips, func(i, j int) bool { return ips[i].IP.To4() != nil && ips[j].IP.To4() == nil })
	dialer := net.Dialer{Timeout: 20 * time.Second}
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return conn, nil
		}
	}
	return nil, fmt.Errorf("无法连接远程服务")
}, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 32, MaxIdleConnsPerHost: 4}}

func reservedIP(ip net.IP) bool {
	for _, cidr := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		_, subnet, _ := net.ParseCIDR(cidr)
		if subnet.Contains(ip) {
			return true
		}
	}
	return false
}
func (s *server) providers() []any {
	builtin := builtinMediaProviders()
	result := []any{}
	saved := asObject(s.settings()["mediaProviders"])
	for _, raw := range builtin {
		provider := asObject(raw)
		id := str(provider["id"])
		if value, ok := saved[id]; ok {
			if value == nil {
				continue
			}
			provider = asObject(value)
		}
		result = append(result, providerSnapshot(provider))
	}
	for id, raw := range saved {
		found := false
		for _, b := range builtin {
			if str(asObject(b)["id"]) == id {
				found = true
			}
		}
		if !found && raw != nil {
			provider := asObject(raw)
			result = append(result, providerSnapshot(provider))
		}
	}
	return s.withPluginProviders(result)
}
func providerSnapshot(value object) object {
	provider := asObject(clone(value))
	delete(provider, "revision")
	delete(provider, "credentialConfigured")
	provider["fileName"] = str(provider["id"]) + ".json"
	provider["supportsPrice"] = str(provider["id"]) == "tfRouter"
	for _, raw := range array(provider["models"]) {
		model := asObject(raw)
		if strings.TrimSpace(str(model["label"])) == "" {
			model["label"] = str(model["id"])
		}
	}
	data, _ := json.Marshal(provider)
	provider["revision"] = hash(data)
	return provider
}
func (s *server) mediaModels() []any {
	models := []any{}
	for _, raw := range s.providers() {
		p := asObject(raw)
		if videoProtocol(p) == "comfyui" && !s.comfyEnabled(p) {
			continue
		}
		for _, rawModel := range array(p["models"]) {
			model := asObject(clone(rawModel))
			delete(model, "comfy")
			model["providerId"] = p["id"]
			model["providerLabel"] = p["label"]
			model["modelId"] = model["id"]
			model["supportsPrice"] = p["supportsPrice"]
			if model["type"] == "video" {
				protocol, location := videoProtocol(p), "platform"
				if protocol == "" {
					protocol = "builtin"
				}
				if protocol == "openaiVideo" || protocol == "httpTask" {
					location = "remote"
				}
				if p["transport"] == "local" {
					location = "local"
				}
				model["execution"] = object{"protocol": protocol, "location": location, "cancelMode": providerCancelMode(p, "video")}
			}
			models = append(models, model)
		}
	}
	return models
}
func (s *server) provider(id string) (object, object, error) {
	for _, raw := range s.providers() {
		p := asObject(raw)
		if str(p["id"]) == id {
			config := object{}
			for _, r := range array(p["rules"]) {
				rule := asObject(r)
				config[str(rule["field"])] = rule["value"]
			}
			for k, v := range asObject(asObject(s.settings()["mediaProviderConfigs"])[id]) {
				config[k] = v
			}
			if str(p["id"]) == "comfyui" {
				config["apiUrl"] = asObject(localMediaConnectionState(s.settings())["config"])["endpoint"]
			}
			return p, config, nil
		}
	}
	return nil, nil, fail(404, "媒体供应商不存在")
}
func (s *server) mediaRoute(w http.ResponseWriter, r *http.Request) error {
	p := r.URL.Path
	if p == "/api/ai/media/referenceBindings" {
		return s.mediaReferenceBindingsRoute(w, r)
	}
	if p == "/api/providers/media/configuration" {
		if err := s.appRequest(r); err != nil {
			return err
		}
		return s.providerConfiguration(w, r)
	}
	if p == "/api/ai/media/models" {
		models := s.mediaModels()
		if !s.localRequest(r) {
			success(w, redactSecrets(models))
			return nil
		}
		success(w, models)
		return nil
	}
	if p == "/api/providers/media/list" {
		providers := s.providers()
		configs := asObject(s.settings()["mediaProviderConfigs"])
		for _, raw := range providers {
			provider := asObject(raw)
			config := asObject(configs[str(provider["id"])])
			configured, hasCredentials := true, false
			for _, rawRule := range array(provider["rules"]) {
				rule := asObject(rawRule)
				field := str(rule["field"])
				if secretField.MatchString(field) || asObject(rule["props"])["type"] == "password" {
					hasCredentials = true
					value := config[field]
					if value == nil {
						value = rule["value"]
					}
					if str(value) == "" && rule["optional"] != true {
						configured = false
					}
				}
			}
			provider["credentialConfigured"] = configured && hasCredentials
		}
		if !s.localRequest(r) {
			success(w, redactSecrets(providers))
			return nil
		}
		success(w, providers)
		return nil
	}
	if p == "/api/providers/media/catalog" {
		if r.Method != "GET" {
			return fail(405, "供应商目录只支持 GET")
		}
		builtin := builtinMediaProviders()
		result := []any{}
		for _, raw := range builtin {
			result = append(result, providerSnapshot(asObject(raw)))
		}
		success(w, result)
		return nil
	}
	if p == "/api/ai/media/balanceEvents" {
		return s.balanceEvents(w, r)
	}
	if err := s.appRequest(r); err != nil {
		return err
	}
	v, err := decode(r)
	if err != nil {
		return err
	}
	if strings.HasPrefix(p, "/api/providers/media/") {
		if !s.localRequest(r) {
			return fail(403, "媒体供应商管理仅允许本机工作台访问")
		}
		return s.providerRoute(w, r, v)
	}
	if p == "/api/ai/media/tasks/status" || p == "/api/ai/media/tasks/cancel" {
		directory, err := s.workspace(r, str(v["directory"]))
		if err != nil {
			return err
		}
		ids := array(v["taskIds"])
		if len(ids) < 1 || len(ids) > 100 {
			return fail(400, "taskIds 数量须在1至100之间")
		}
		s.tasksMu.Lock()
		now := time.Now()
		for id, task := range s.tasks {
			if !task.settled.IsZero() && now.Sub(task.settled) > 5*time.Minute {
				delete(s.tasks, id)
			} else if task.settled.IsZero() && now.Sub(task.touched) > 2*time.Minute && str(task.request["mediaType"]) != "video" {
				task.cancelRequested = true
				task.cancel()
			}
		}
		waiting := []chan struct{}{}
		for _, raw := range ids {
			if err := s.loadMediaTask(str(raw)); err != nil {
				s.tasksMu.Unlock()
				return err
			}
			if s.tasks[str(raw)] == nil && strings.HasSuffix(p, "cancel") {
				if len(s.tasks) >= 1000 {
					s.tasksMu.Unlock()
					return fail(429, "生成取消记录过多")
				}
				task := &mediaTask{directory: directory, inputHash: "cancelledBeforeRegistration", done: make(chan struct{}), cancel: func() {}, unknown: true, touched: now, settled: now, cancelRequested: true, result: object{"code": 409, "data": nil, "message": "取消时任务尚未登记或不可确认，已阻止此ID后续提交；请保留原ID"}}
				task.submitted.Store(true)
				if err := s.saveMediaTask(str(raw), task, true); err != nil {
					s.tasksMu.Unlock()
					return err
				}
				close(task.done)
				s.tasks[str(raw)] = task
			}
			if task := s.tasks[str(raw)]; task != nil && task.directory == directory {
				task.touched = now
				cancelling := strings.HasSuffix(p, "cancel")
				resumingRemote := task.unknown && task.job["cancelMode"] == "request"
				if cancelling && resumingRemote {
					task.cancelRequested = true
				}
				if err := s.resumeVideoTask(str(raw), task); err != nil {
					s.tasksMu.Unlock()
					return err
				}
				if cancelling && task.settled.IsZero() {
					task.cancelRequested = true
					if err := s.saveMediaTask(str(raw), task, false); err != nil {
						s.tasksMu.Unlock()
						return err
					}
					// 恢复的任务由查询循环发出取消；这里取消上下文，它连不上远端就退出了。
					if !resumingRemote {
						task.cancel()
					}
					waiting = append(waiting, task.done)
				}
			}
		}
		s.tasksMu.Unlock()
		for _, done := range waiting {
			select {
			case <-done:
			case <-r.Context().Done():
				return r.Context().Err()
			}
		}
		s.tasksMu.Lock()
		result := []any{}
		for _, raw := range ids {
			id := str(raw)
			task := s.tasks[id]
			if task == nil || task.directory != directory {
				result = append(result, object{"taskId": id, "status": "unknown", "executionSettled": false, "sideEffectMayContinue": true, "result": object{"code": 404, "data": nil, "message": "生成任务不存在或已过期，不能确认执行状态"}})
				continue
			}
			result = append(result, mediaTaskState(id, task))
		}
		s.tasksMu.Unlock()
		if strings.HasSuffix(p, "cancel") {
			success(w, object{"tasks": result})
		} else {
			success(w, result)
		}
		return nil
	}
	directory := ""
	if raw := str(v["directory"]); raw != "" {
		directory, err = s.workspace(r, raw)
		if err != nil {
			return err
		}
	}
	if p == "/api/ai/media/price" {
		if err = s.validateMedia(v, true); err != nil {
			return err
		}
		provider, config, err := s.provider(str(v["providerId"]))
		if err != nil {
			return err
		}
		price, err := s.mediaPrice(r.Context(), directory, provider, config, v)
		if err != nil {
			return err
		}
		success(w, price)
		return nil
	}
	if p == "/api/ai/media/balance" {
		id := str(v["providerId"])
		if id == "" {
			id = "tfRouter"
		}
		provider, config, err := s.provider(id)
		if err != nil {
			return err
		}
		if key, ok := v["apiKey"].(string); ok {
			config["apiKey"] = key
		}
		result, err := s.refreshBalance(r.Context(), provider, config)
		if err != nil {
			return err
		}
		success(w, result)
		return nil
	}
	if p != "/api/ai/media/generate" {
		return fail(404, "媒体接口不存在")
	}
	if operationID, exists := v["operationId"]; exists && v["mediaType"] == "video" {
		if !uuidValue.MatchString(str(operationID)) || (v["taskId"] != nil && v["taskId"] != operationID) {
			return fail(400, "operationId 须为 UUID 且与 taskId 一致")
		}
		v["taskId"] = operationID
		delete(v, "operationId")
	}
	if directory == "" {
		return fail(400, "生成需要工作目录")
	}
	if err = s.validateMedia(v, false); err != nil {
		return err
	}
	taskID := str(v["taskId"])
	if taskID != "" {
		if !uuidValue.MatchString(taskID) {
			return fail(400, "taskId 无效")
		}
		encoded, _ := json.Marshal(v)
		inputHash := hash(encoded)
		s.tasksMu.Lock()
		if err := s.loadMediaTask(taskID); err != nil {
			s.tasksMu.Unlock()
			return err
		}
		if task := s.tasks[taskID]; task != nil {
			if task.directory == directory && task.inputHash == "cancelledBeforeRegistration" {
				state := mediaTaskState(taskID, task)
				s.tasksMu.Unlock()
				success(w, state)
				return nil
			}
			if task.directory != directory || task.inputHash != inputHash {
				s.tasksMu.Unlock()
				return fail(409, "生成任务ID已用于不同请求，不能重复生成")
			}
			task.touched = time.Now()
			state := mediaTaskState(taskID, task)
			s.tasksMu.Unlock()
			success(w, state)
			return nil
		}
		if len(s.tasks) >= 1000 {
			s.tasksMu.Unlock()
			return fail(429, "生成任务过多")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		task := &mediaTask{directory: directory, inputHash: inputHash, request: asObject(clone(v)), done: make(chan struct{}), cancel: cancel, touched: time.Now()}
		if err := s.saveMediaTask(taskID, task, true); err != nil {
			cancel()
			s.tasksMu.Unlock()
			return err
		}
		s.tasks[taskID] = task
		s.tasksMu.Unlock()
		go s.runMediaTask(ctx, taskID, task)
		success(w, object{"taskId": taskID})
		return nil
	}
	files, err := s.generateMedia(r.Context(), directory, v)
	if err != nil {
		return err
	}
	success(w, files)
	return nil
}
func (s *server) mediaPrice(ctx context.Context, directory string, provider, config, input object) (any, error) {
	if str(provider["id"]) != "tfRouter" {
		return nil, nil
	}
	body, err := s.priceRequest(ctx, directory, input)
	if err != nil {
		return nil, err
	}
	body["type"] = input["mediaType"]
	body["model"] = input["modelId"]
	result, err := providerJSON(ctx, providerBase(provider, config), "price", config, body)
	if err != nil {
		return nil, err
	}
	price := result["data"]
	if item, ok := price.(map[string]any); ok {
		if item["price"] == nil && item["amount"] != nil {
			price = object{"price": fmt.Sprint(item["amount"]) + " " + str(item["unit"]), "tips": "以实际扣费为准"}
		}
	}
	return price, nil
}
func (s *server) priceRequest(ctx context.Context, directory string, input object) (object, error) {
	body := object{}
	for _, key := range []string{"prompt", "ratio", "size", "resolution", "duration", "generateAudio", "mode", "voice", "speed", "volume", "pitch", "language", "format", "sampleRate"} {
		if value, ok := input[key]; ok {
			body[key] = value
		}
	}
	body["type"] = input["mediaType"]
	body["model"] = input["modelId"]
	if str(input["mediaType"]) == "audio" {
		body["text"] = body["prompt"]
		delete(body, "prompt")
	}
	for _, pair := range [][2]string{{"images", "image"}, {"videos", "video"}, {"audios", "audio"}, {"firstFrame", "image"}, {"lastFrame", "image"}} {
		items := array(input[pair[0]])
		singular := pair[0] == "firstFrame" || pair[0] == "lastFrame"
		if singular && input[pair[0]] != nil {
			items = []any{input[pair[0]]}
		}
		if len(items) == 0 {
			continue
		}
		if directory == "" {
			return nil, fail(400, "参考媒体估价需要工作目录")
		}
		metadata := []any{}
		for _, raw := range items {
			reference := asObject(raw)
			path, err := workspacePath(directory, str(reference["path"]), false)
			if err != nil {
				return nil, err
			}
			info, err := os.Stat(path)
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 100*1024*1024 {
				return nil, fail(413, "参考媒体须为100MiB以内非空普通文件")
			}
			file, err := os.Open(path)
			if err != nil {
				return nil, err
			}
			header := make([]byte, 512)
			n, _ := file.Read(header)
			_, _ = file.Seek(0, 0)
			mimeType := http.DetectContentType(header[:n])
			if mimeType == "application/octet-stream" {
				mimeType = str(reference["mimeType"])
			}
			if !strings.HasPrefix(mimeType, pair[1]+"/") {
				file.Close()
				return nil, fail(415, "参考媒体类型不匹配")
			}
			item := object{"mimeType": mimeType, "sizeBytes": info.Size()}
			if pair[1] == "image" {
				config, _, err := image.DecodeConfig(file)
				if err == nil {
					item["width"] = config.Width
					item["height"] = config.Height
				}
			} else if executable, err := s.toolPath("ffprobe"); err == nil {
				deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
				bytes, err := exec.CommandContext(deadline, executable, "-v", "quiet", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_format", "-show_streams", path).Output()
				cancel()
				if err == nil {
					var probed object
					if json.Unmarshal(bytes, &probed) == nil {
						if duration, err := strconv.ParseFloat(str(asObject(probed["format"])["duration"]), 64); err == nil && duration > 0 {
							item["duration"] = duration
						}
						for _, rawStream := range array(probed["streams"]) {
							stream := asObject(rawStream)
							if str(stream["codec_type"]) != pair[1] {
								continue
							}
							for _, key := range []string{"width", "height"} {
								if number(stream[key]) > 0 {
									item[key] = stream[key]
								}
							}
							rate := strings.Split(str(stream["avg_frame_rate"]), "/")
							if len(rate) == 2 {
								a, _ := strconv.ParseFloat(rate[0], 64)
								b, _ := strconv.ParseFloat(rate[1], 64)
								if a > 0 && b > 0 {
									item["frameRate"] = a / b
								}
							}
							break
						}
					}
				}
			}
			file.Close()
			latest, err := os.Stat(path)
			if err != nil || latest.Size() != info.Size() || !latest.ModTime().Equal(info.ModTime()) {
				return nil, stale("参考媒体已变化，请重新估价")
			}
			metadata = append(metadata, item)
		}
		if singular {
			body[pair[0]] = metadata[0]
		} else {
			body[pair[0]] = metadata
		}
	}
	return body, nil
}
func (s *server) validateMedia(v object, allowEmptyPrompt bool) error {
	kind := str(v["mediaType"])
	if kind != "image" && kind != "video" && kind != "audio" {
		return fail(400, "媒体类型无效")
	}
	prompt, promptValid := v["prompt"].(string)
	if !promptValid || (!allowEmptyPrompt && strings.TrimSpace(prompt) == "") || len(prompt) > 100000 {
		return fail(400, "生成提示词为空或过长")
	}
	allowed := map[string]bool{"directory": true, "mediaType": true, "taskId": true, "providerId": true, "modelId": true, "prompt": true, "outputDirectory": true, "images": true, "parameters": true}
	keys := map[string][]string{"image": {"ratio", "size"}, "video": {"ratio", "videos", "audios", "firstFrame", "lastFrame", "resolution", "duration", "generateAudio", "mode"}, "audio": {"audios", "voice", "speed", "volume", "pitch", "language", "format", "sampleRate"}}
	for _, key := range keys[kind] {
		allowed[key] = true
	}
	for key := range v {
		if !allowed[key] {
			return fail(400, "媒体请求包含不适用于当前类型的字段: "+key)
		}
	}
	if !providerID.MatchString(str(v["providerId"])) || len(str(v["modelId"])) == 0 || len(str(v["modelId"])) > 256 {
		return fail(400, "媒体供应商或模型标识无效")
	}
	for _, key := range []string{"size", "resolution", "language", "format", "voice"} {
		if raw, exists := v[key]; exists {
			value, ok := raw.(string)
			limit := 64
			if key == "voice" {
				limit = 256
			}
			if !ok || strings.TrimSpace(value) == "" || len(value) > limit {
				return fail(400, "媒体参数无效: "+key)
			}
		}
	}
	if value, exists := v["ratio"]; exists {
		if !regexp.MustCompile(`^[1-9]\d{0,3}:[1-9]\d{0,3}$`).MatchString(str(value)) {
			return fail(400, "画幅比例无效")
		}
	}
	for _, key := range []string{"duration", "speed", "volume", "pitch", "sampleRate"} {
		if raw, exists := v[key]; exists {
			value, ok := raw.(float64)
			if !ok || math.IsNaN(value) || math.IsInf(value, 0) || (key == "duration" && (value <= 0 || value > 3600)) || (key == "speed" && value <= 0) || (key == "sampleRate" && (value <= 0 || math.Trunc(value) != value)) {
				return fail(400, "媒体数值参数无效: "+key)
			}
		}
	}
	if raw, exists := v["generateAudio"]; exists {
		if _, ok := raw.(bool); !ok {
			return fail(400, "generateAudio 必须为布尔值")
		}
	}
	for _, pair := range [][2]string{{"images", "image"}, {"videos", "video"}, {"audios", "audio"}, {"firstFrame", "image"}, {"lastFrame", "image"}} {
		raw, exists := v[pair[0]]
		if !exists {
			continue
		}
		items, ok := raw.([]any)
		if pair[0] == "firstFrame" || pair[0] == "lastFrame" {
			items = []any{raw}
			ok = true
		}
		if !ok || len(items) > 64 {
			return fail(400, "媒体参考数量无效")
		}
		for _, item := range items {
			reference, ok := item.(map[string]any)
			if !ok || len(reference) != 2 {
				return fail(400, "媒体参考必须仅包含 path 与 mimeType")
			}
			path := str(reference["path"])
			mimeType := str(reference["mimeType"])
			if path == "" || len(path) > 2048 || strings.ContainsAny(path, "\\:\x00") || strings.HasPrefix(path, "/") {
				return fail(400, "媒体参考路径无效")
			}
			for _, part := range strings.Split(path, "/") {
				if part == "" || part == "." || part == ".." {
					return fail(400, "媒体参考路径无效")
				}
			}
			if !strings.HasPrefix(mimeType, pair[1]+"/") || !regexp.MustCompile(`^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$`).MatchString(mimeType) {
				return fail(400, "媒体参考 MIME 类型无效")
			}
		}
	}
	if raw, exists := v["mode"]; exists {
		if value, ok := raw.(string); ok {
			valid := false
			for _, allowed := range []string{"singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"} {
				if value == allowed {
					valid = true
				}
			}
			if !valid {
				return fail(400, "视频生成模式无效")
			}
		} else if items, ok := raw.([]any); ok && len(items) >= 1 && len(items) <= 3 {
			for _, item := range items {
				if !regexp.MustCompile(`^(image|video|audio)Reference:([1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$`).MatchString(str(item)) {
					return fail(400, "视频参考模式无效")
				}
			}
		} else {
			return fail(400, "视频生成模式无效")
		}
	}
	p, _, err := s.provider(str(v["providerId"]))
	if err != nil {
		return err
	}
	for _, raw := range array(p["models"]) {
		m := asObject(raw)
		if str(m["id"]) == str(v["modelId"]) && str(m["type"]) == kind {
			if err := validateMediaParameters(p, m, v); err != nil {
				return err
			}
			if kind == "video" {
				if err := validateVideoInputs(m, v); err != nil {
					return err
				}
			}
			if videoProtocol(p) == "comfyui" && !s.comfyEnabled(p) {
				return fail(400, "请先在 设置 → 媒体服务 → ComfyUI 工作流 中启用连接")
			}
			if videoProtocol(p) != "" {
				if !allowEmptyPrompt && !uuidValue.MatchString(str(v["taskId"])) {
					return fail(400, "此生成须提供 UUID operationId 或 taskId，以防重复提交")
				}
				_, config, err := s.provider(str(v["providerId"]))
				if err != nil {
					return err
				}
				if _, err := videoClient(p, config); err != nil {
					return err
				}
				if str(p["transport"]) != "local" && strings.TrimSpace(str(config["apiKey"])) == "" {
					return fail(400, "请先配置媒体供应商 API Key")
				}
				if !allowEmptyPrompt && kind == "video" {
					if _, err := s.toolPath("ffprobe"); err != nil {
						return fail(400, "视频生成需要先准备 FFmpeg，以核验实际产物")
					}
				}
			}
			return nil
		}
	}
	return fail(400, "媒体模型不存在或类型不匹配")
}
func providerBase(p, config object) string {
	if custom := str(config["apiUrl"]); custom != "" {
		return strings.TrimRight(custom, "/")
	}
	if custom := str(config["baseUrl"]); custom != "" {
		return strings.TrimRight(custom, "/")
	}
	switch str(p["id"]) {
	case "tfRouter":
		return "https://api.toonflow.net/v1"
	case "apiMart":
		if str(config["isOverseas"]) == "2" {
			return "https://api.apimart.ai/v1"
		}
		return "https://api.apib.ai/v1"
	case "metaso":
		return "https://metaso.cn/api/minimax"
	case "compshare":
		return "https://api.modelverse.cn"
	}
	return strings.TrimRight(str(p["apiUrl"]), "/")
}
func providerJSON(ctx context.Context, base, path string, config object, body any) (object, error) {
	return providerClientJSON(ctx, nil, base, path, config, body)
}

// client 为 nil 时走公网客户端且必须有 API Key；非 nil 只来自 localProviderClient，本地服务可以不设认证。
func providerClientJSON(ctx context.Context, client *http.Client, base, path string, config object, body any) (object, error) {
	baseURL, baseErr := url.Parse(base)
	if baseErr != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || baseURL.User != nil {
		return nil, fail(400, "供应商地址不能包含账号、查询凭据或锚点")
	}
	u, err := url.Parse(base + "/" + strings.TrimLeft(path, "/"))
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.User != nil || u.Host == "" {
		return nil, fail(400, "供应商 API URL 无效")
	}
	var reader io.Reader
	method := "GET"
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
		method = "POST"
	}
	request, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(strings.TrimPrefix(str(config["apiKey"]), "Bearer "))
	if key == "" && client == nil {
		return nil, fail(400, "请先配置媒体供应商 API Key")
	}
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	request.Header.Set("Content-Type", "application/json")
	if method == "POST" {
		markMediaSubmitted(ctx)
	}
	if client == nil {
		client = safeClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 20*1024*1024))
	if err != nil {
		return nil, err
	}
	redact := func(message string) string {
		if key == "" {
			return message
		}
		return strings.ReplaceAll(message, key, "[REDACTED]")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := redact(string(data))
		if len(message) > 2000 {
			message = message[:2000]
		}
		return nil, fail(502, fmt.Sprintf("供应商 HTTP %d: %s", response.StatusCode, message))
	}
	var result object
	if err = json.Unmarshal(data, &result); err != nil {
		return nil, fail(502, "供应商响应不是 JSON 对象")
	}
	if code := number(result["code"]); code >= 400 || result["success"] == false || result["error"] != nil {
		message := str(result["message"])
		if message == "" {
			message = str(asObject(result["error"])["message"])
		}
		if message == "" {
			message = "供应商拒绝请求"
		}
		message = redact(message)
		if len(message) > 2000 {
			message = message[:2000]
		}
		return nil, fail(502, message)
	}
	return result, nil
}
func waitContext(ctx context.Context) error {
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func referenceData(directory string, value any, kind string) (string, error) {
	reference := asObject(value)
	path, err := workspacePath(directory, str(reference["path"]), false)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 100*1024*1024 {
		return "", fail(413, "参考媒体须为100MiB以内普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	mimeType := str(reference["mimeType"])
	detected := http.DetectContentType(data)
	if detected != "application/octet-stream" {
		mimeType = detected
	}
	if !strings.HasPrefix(mimeType, kind+"/") {
		return "", fail(415, "参考媒体类型不匹配")
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}
func (s *server) generateMedia(ctx context.Context, directory string, v object) (outputFiles []any, operationErr error) {
	provider, config, err := s.provider(str(v["providerId"]))
	if err != nil {
		return nil, err
	}
	outputDirectory := str(v["outputDirectory"])
	if outputDirectory == "" {
		outputDirectory = "assets/generated"
	}
	output, err := workspacePath(directory, outputDirectory, true)
	if err != nil {
		return nil, err
	}
	release, err := s.lockFiles(output)
	if err != nil {
		return nil, err
	}
	defer release()
	if info, statErr := os.Stat(output); statErr == nil && !info.IsDir() {
		return nil, fail(400, "生成输出路径不是文件夹")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return nil, statErr
	}
	if err := os.MkdirAll(output, 0755); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var referenceBytes int64
	resumingVideo := str(currentVideoJob(ctx)["id"]) != ""
	for _, key := range []string{"images", "videos", "audios", "firstFrame", "lastFrame"} {
		if resumingVideo {
			continue
		}
		items := array(v[key])
		if (key == "firstFrame" || key == "lastFrame") && v[key] != nil {
			items = []any{v[key]}
		}
		for _, raw := range items {
			path, err := workspacePath(directory, str(asObject(raw)["path"]), false)
			if err != nil {
				return nil, err
			}
			info, err := os.Stat(path)
			if err != nil {
				return nil, err
			}
			referenceBytes += info.Size()
			if referenceBytes > 256*1024*1024 {
				return nil, fail(413, "参考素材总量超过256MiB")
			}
		}
	}
	kind := str(v["mediaType"])
	if kind == "video" && videoProtocol(provider) == "ark" && !resumingVideo {
		if err := s.validateArkReferenceVideos(ctx, directory, v); err != nil {
			return nil, err
		}
	}
	base := providerBase(provider, config)
	refs := object{}
	for _, pair := range [][2]string{{"images", "image"}, {"videos", "video"}, {"audios", "audio"}} {
		if resumingVideo {
			continue
		}
		items := []any{}
		for _, raw := range array(v[pair[0]]) {
			if len(items) >= 24 {
				return nil, fail(400, "参考素材过多")
			}
			data, err := referenceData(directory, raw, pair[1])
			if err != nil {
				return nil, err
			}
			items = append(items, data)
		}
		refs[pair[0]] = items
	}
	for _, key := range []string{"firstFrame", "lastFrame"} {
		if resumingVideo {
			continue
		}
		if v[key] != nil {
			data, err := referenceData(directory, v[key], "image")
			if err != nil {
				return nil, err
			}
			refs[key] = data
		}
	}
	var results []string
	if videoProtocol(provider) == "comfyui" {
		results, err = s.generateComfy(ctx, provider, config, v, refs)
	} else if videoProtocol(provider) != "" {
		results, err = s.generateVideoProvider(ctx, provider, config, v, refs)
	} else {
		switch str(provider["id"]) {
		case "tfRouter":
			results, err = generateTfRouter(ctx, base, config, v, refs)
		case "apiMart":
			results, err = generateApiMart(ctx, base, config, v, refs)
		case "metaso":
			results, err = generateMetaso(ctx, base, config, v, refs)
		case "compshare":
			results, err = generateCompshare(ctx, base, config, v, refs)
		default:
			results, err = generateHttpProvider(ctx, base, provider, config, v, refs)
		}
	}
	if err != nil {
		return nil, err
	}
	if len(results) == 0 {
		return nil, fail(502, "供应商未返回生成结果")
	}
	verifiedOutput, err := workspacePath(directory, outputDirectory, true)
	if err != nil || verifiedOutput != output {
		return nil, fail(409, "输出目录已变化")
	}
	if err = os.MkdirAll(output, 0755); err != nil {
		return nil, err
	}
	files := []any{}
	written := []string{}
	defer func() {
		if operationErr != nil {
			for _, path := range written {
				if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
					operationErr = errors.Join(operationErr, fmt.Errorf("未能回滚生成文件 %s: %w", filepath.Base(path), err))
				}
			}
		}
	}()
	for _, result := range results {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		var data []byte
		mimeType := ""
		if strings.HasPrefix(result, "data:") {
			parts := strings.SplitN(result, ",", 2)
			if len(parts) != 2 {
				return nil, fail(502, "媒体数据无效")
			}
			mimeType = strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
			data, err = base64.StdEncoding.DecodeString(parts[1])
		} else {
			client, target, e := resultClient(provider, config, result)
			if e != nil {
				return nil, e
			}
			request, e := http.NewRequestWithContext(ctx, "GET", target, nil)
			if e != nil {
				return nil, e
			}
			response, e := client.Do(request)
			if e != nil {
				return nil, e
			}
			data, err = io.ReadAll(io.LimitReader(response.Body, 100*1024*1024+1))
			_ = response.Body.Close()
			mimeType = strings.Split(response.Header.Get("Content-Type"), ";")[0]
			if response.StatusCode != 200 {
				return nil, fail(502, "下载生成结果失败")
			}
		}
		if err != nil {
			return nil, err
		}
		if len(data) == 0 || len(data) > 100*1024*1024 {
			return nil, fail(413, "生成结果为空或超过100MiB")
		}
		detected := http.DetectContentType(data)
		if detected != "application/octet-stream" {
			mimeType = detected
		}
		if !strings.HasPrefix(mimeType, kind+"/") {
			return nil, fail(415, "生成结果媒体类型不正确")
		}
		ext := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mp4": "m4a"}[mimeType]
		if ext == "" {
			return nil, fail(415, "生成媒体格式不受支持")
		}
		relative := filepath.ToSlash(filepath.Join(outputDirectory, kind+randomID()+"."+ext))
		recoverable := kind == "video" && videoProtocol(provider) != "" && uuidValue.MatchString(str(v["taskId"]))
		if recoverable {
			relative = filepath.ToSlash(filepath.Join(outputDirectory, "video"+str(v["taskId"])+hash(data)[:16]+"."+ext))
		}
		path, e := workspacePath(directory, relative, false)
		if e != nil {
			return nil, e
		}
		if err = atomicWrite(path, data, true, 0600); err != nil {
			if !recoverable || !os.IsExist(err) {
				return nil, err
			}
			digest, readErr := hashFile(ctx, path)
			if readErr != nil || digest != hash(data) {
				return nil, fail(409, "原视频产物文件已变化，未覆盖")
			}
		} else {
			written = append(written, path)
		}
		file := object{"path": relative, "mimeType": mimeType, "mediaType": kind, "assetId": hash(data), "sha256": hash(data), "sizeBytes": len(data)}
		if kind == "video" && videoProtocol(provider) != "" {
			deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
			metadata, probeErr := s.probeVideo(deadline, path)
			cancel()
			if probeErr != nil {
				return nil, fail(502, "生成产物不是可解码视频；未发布到节点: "+probeErr.Error())
			}
			file["metadata"] = metadata
		}
		files = append(files, file)
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return files, nil
}
func tfBody(v, refs object) object {
	kind := str(v["mediaType"])
	model := str(v["modelId"])
	ratio := str(v["ratio"])
	if ratio == "" {
		ratio = "16:9"
	}
	body := object{"model": model, "prompt": v["prompt"]}
	if kind == "audio" {
		format := str(v["format"])
		if format == "" {
			format = "mp3"
		}
		sample := v["sampleRate"]
		if sample == nil {
			sample = 24000
		}
		speed := number(v["speed"])
		if speed == 0 {
			speed = 1
		}
		body = object{"model": model, "text": v["prompt"], "format": format, "sampleRate": sample, "speechRate": math.Round((speed - 1) * 100), "loudnessRate": math.Round((math.Pow(10, number(v["volume"])/20) - 1) * 100), "pitchRate": v["pitch"]}
		references := []any{}
		for _, pair := range [][2]string{{"images", "image_data"}, {"audios", "audio_data"}} {
			for _, raw := range array(refs[pair[0]]) {
				parts := strings.SplitN(str(raw), ",", 2)
				references = append(references, object{pair[1]: parts[len(parts)-1]})
			}
		}
		if len(references) > 0 {
			body["references"] = references
		}
		return body
	}
	if kind == "image" {
		size := str(v["size"])
		if size == "" {
			size = "2K"
		}
		body["size"] = strings.ToLower(size)
		body["images"] = refs["images"]
		metadata := object{"aspectRatio": ratio}
		if strings.Contains(strings.ToLower(model), "seedream") || strings.Contains(strings.ToLower(model), "doubao") {
			metadata["response_format"] = "url"
			metadata["sequential_image_generation"] = "disabled"
			metadata["stream"] = false
			metadata["watermark"] = false
		}
		body["metadata"] = metadata
		return body
	}
	body["duration"] = v["duration"]
	body["resolution"] = v["resolution"]
	metadata := object{"ratio": ratio, "resolution": v["resolution"]}
	if v["generateAudio"] != nil {
		metadata["generate_audio"] = v["generateAudio"]
	}
	metadata["references"] = videoReferences(v, refs)
	if strings.Contains(strings.ToLower(model), "kling") {
		metadata = object{"aspect_ratio": ratio, "sound": "off", "video_list": []any{}, "image_list": []any{}}
		if boolean(v["generateAudio"]) {
			metadata["sound"] = "on"
		}
		for _, raw := range array(refs["videos"]) {
			metadata["video_list"] = append(array(metadata["video_list"]), object{"video_url": raw})
		}
		for _, raw := range array(videoReferences(v, refs)) {
			ref := asObject(raw)
			image := asObject(ref["image_url"])["url"]
			if image != nil {
				metadata["image_list"] = append(array(metadata["image_list"]), object{"image_url": image, "type": ref["role"]})
			}
		}
		images := array(refs["images"])
		if len(images) > 0 {
			metadata["image"] = images[0]
		}
		if refs["firstFrame"] != nil {
			metadata["image"] = refs["firstFrame"]
		}
		if refs["lastFrame"] != nil {
			metadata["image_tail"] = refs["lastFrame"]
		}
	}
	body["metadata"] = metadata
	return body
}
func videoReferences(v, refs object) []any {
	result := []any{}
	for _, key := range []string{"firstFrame", "lastFrame"} {
		if refs[key] != nil {
			role := "first_frame"
			if key == "lastFrame" {
				role = "last_frame"
			}
			result = append(result, object{"role": role, "type": "image_url", "image_url": object{"url": refs[key]}})
		}
	}
	if len(result) > 0 {
		return result
	}
	for _, pair := range [][2]string{{"images", "image"}, {"videos", "video"}, {"audios", "audio"}} {
		for _, raw := range array(refs[pair[0]]) {
			result = append(result, object{"role": "reference_" + pair[1], "type": pair[1] + "_url", pair[1] + "_url": object{"url": raw}})
		}
	}
	return result
}
func generateTfRouter(ctx context.Context, base string, config, v, refs object) ([]string, error) {
	kind := str(v["mediaType"])
	name := strings.ToUpper(kind[:1]) + kind[1:]
	path := kind + "/generate" + name
	if kind == "audio" {
		path = "tts/create"
	}
	task, err := providerJSON(ctx, base, path, config, tfBody(v, refs))
	if err != nil {
		return nil, err
	}
	id := str(task["data"])
	if id == "" {
		return nil, fail(502, "TF-router 未返回任务 ID")
	}
	query := kind + "/get" + name + "Status"
	if kind == "audio" {
		query = "tts/getAudioStatus"
	}
	for {
		result, err := providerJSON(ctx, base, query, config, object{"taskICode": id})
		if err != nil {
			return nil, err
		}
		data := asObject(result["data"])
		status := strings.ToLower(str(result["status"]))
		if status == "" {
			status = strings.ToLower(str(data["status"]))
		}
		if status == "success" || status == "completed" {
			recordVendorCost(ctx, data)
			url := str(data["data"])
			if url == "" {
				return nil, fail(502, "TF-router 未返回媒体结果")
			}
			return []string{url}, nil
		}
		if status == "failed" || status == "error" || status == "rejected" {
			return nil, fail(502, "TF-router 生成失败: "+str(data["failReason"]))
		}
		if err = waitContext(ctx); err != nil {
			return nil, err
		}
	}
}
func uploadApiMart(ctx context.Context, base string, config object, dataURL string) (string, error) {
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 {
		return dataURL, nil
	}
	data, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "reference.png")
	if err != nil {
		return "", err
	}
	_, _ = part.Write(data)
	_ = writer.Close()
	request, err := http.NewRequestWithContext(ctx, "POST", base+"/uploads/images", &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+str(config["apiKey"]))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	markMediaSubmitted(ctx)
	response, err := safeClient().Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	var result object
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		return "", err
	}
	if response.StatusCode != 200 || str(result["url"]) == "" {
		return "", fail(502, "APIMart 参考图片上传失败")
	}
	return str(result["url"]), nil
}
func generateApiMart(ctx context.Context, base string, config, v, refs object) ([]string, error) {
	kind := str(v["mediaType"])
	if kind == "audio" {
		return nil, fail(400, "APIMart 不支持音频生成")
	}
	images := []any{}
	for _, raw := range array(refs["images"]) {
		u, err := uploadApiMart(ctx, base, config, str(raw))
		if err != nil {
			return nil, err
		}
		images = append(images, u)
	}
	body := object{"model": v["modelId"], "prompt": v["prompt"], "resolution": v["resolution"], "size": v["ratio"], "duration": v["duration"]}
	path := "videos/generations"
	if kind == "image" {
		path = "images/generations"
		size := strings.ToUpper(str(v["size"]))
		model := strings.ToLower(str(v["modelId"]))
		if strings.Contains(model, "seedream-5-0-lite") && size == "1K" {
			size = "2K"
		} else if strings.Contains(model, "seedream-5-0-pro") {
			if size == "4K" {
				size = "2K"
			} else if size == "2K" {
				size = "1.5K"
			}
		}
		body["resolution"] = size
		body["n"] = 1
		body["image_urls"] = images
	} else {
		model := strings.ToLower(str(v["modelId"]))
		if (strings.Contains(model, "seedance") || strings.Contains(model, "doubao")) && len(array(v["mode"])) > 0 && len(images) > 0 {
			reviewed, err := reviewApiMartImages(ctx, base, config, images)
			if err != nil {
				return nil, err
			}
			images = reviewed
		}
		body["image_urls"] = images
		body["video_urls"] = refs["videos"]
		body["audio_urls"] = refs["audios"]
		body["generate_audio"] = v["generateAudio"]
		roles := []any{}
		for _, key := range []string{"firstFrame", "lastFrame"} {
			if refs[key] != nil {
				u, err := uploadApiMart(ctx, base, config, str(refs[key]))
				if err != nil {
					return nil, err
				}
				role := "first_frame"
				if key == "lastFrame" {
					role = "last_frame"
				}
				roles = append(roles, object{"role": role, "url": u})
			}
		}
		if len(roles) > 0 {
			body["image_with_roles"] = roles
		} else if strings.Contains(model, "seedance") || strings.Contains(model, "doubao") || strings.Contains(model, "minimax") {
			for _, u := range images {
				roles = append(roles, object{"role": "reference_image", "url": u})
			}
			body["image_with_roles"] = roles
		}
	}
	task, err := providerJSON(ctx, base, path, config, body)
	if err != nil {
		return nil, err
	}
	tasks := array(task["data"])
	if len(tasks) == 0 {
		return nil, fail(502, "APIMart 未返回任务 ID")
	}
	id := str(asObject(tasks[0])["task_id"])
	if id == "" {
		return nil, fail(502, "APIMart 任务 ID 无效")
	}
	for {
		result, err := providerJSON(ctx, base, "tasks/"+url.PathEscape(id), config, nil)
		if err != nil {
			return nil, err
		}
		data := asObject(result["data"])
		status := strings.ToLower(str(data["status"]))
		if status == "completed" || status == "success" {
			output := asObject(data["result"])
			key := "videos"
			if kind == "image" {
				key = "images"
			}
			items := array(output[key])
			urls := []string{}
			for _, raw := range items {
				for _, u := range array(asObject(raw)["url"]) {
					if str(u) != "" {
						urls = append(urls, str(u))
					}
				}
			}
			if len(urls) == 0 {
				return nil, fail(502, "APIMart 未返回生成结果")
			}
			return urls, nil
		}
		if status == "failed" || status == "failure" {
			return nil, fail(502, "APIMart 生成失败")
		}
		if err = waitContext(ctx); err != nil {
			return nil, err
		}
	}
}
func generateMetaso(ctx context.Context, base string, config, v, refs object) ([]string, error) {
	if str(v["mediaType"]) != "video" {
		return nil, fail(400, "此供应商仅支持视频")
	}
	content := []any{object{"type": "text", "text": v["prompt"]}}
	content = append(content, videoReferences(v, refs)...)
	task, err := providerJSON(ctx, base, "v2/video_generation", config, object{"model": v["modelId"], "duration": v["duration"], "resolution": v["resolution"], "ratio": v["ratio"], "content": content})
	if err != nil {
		return nil, err
	}
	id := str(task["task_id"])
	if id == "" {
		return nil, fail(502, "供应商未返回任务 ID")
	}
	for {
		result, err := providerJSON(ctx, base, "v2/query/video_generation/"+url.PathEscape(id), config, nil)
		if err != nil {
			return nil, err
		}
		task := asObject(result["task"])
		status := strings.ToLower(str(task["status"]))
		if status == "success" || status == "succeeded" || status == "completed" {
			output := str(asObject(task["content"])["url"])
			if output == "" {
				return nil, fail(502, "未返回视频结果")
			}
			return []string{output}, nil
		}
		if status == "fail" || status == "failed" || status == "failure" || status == "blocked" || status == "cancelled" {
			return nil, fail(502, "视频生成失败")
		}
		if err = waitContext(ctx); err != nil {
			return nil, err
		}
	}
}
func generateCompshare(ctx context.Context, base string, config, v, refs object) ([]string, error) {
	if str(v["mediaType"]) == "image" {
		if strings.Contains(strings.ToLower(str(v["modelId"])), "gpt-image") {
			return generateGptImage(ctx, base, config, v, refs)
		}
		return generateOpenAIImage(ctx, nil, base, config, v, refs)
	}
	if strings.Contains(strings.ToLower(str(v["modelId"])), "minimax-h3") {
		h3 := asObject(clone(config))
		h3["apiKey"] = config["minimaxApiKey"]
		h3Base := "https://cp.compshare.cn/minimax"
		if str(config["apiUrl"]) != "" {
			h3Base = str(config["apiUrl"])
		}
		return generateMetaso(ctx, h3Base, h3, v, refs)
	}
	content := []any{object{"type": "text", "text": v["prompt"]}}
	content = append(content, videoReferences(v, refs)...)
	body := object{"model": v["modelId"], "input": object{"content": content}, "parameters": object{"duration": v["duration"], "resolution": strings.ToLower(str(v["resolution"])), "ratio": v["ratio"], "generate_audio": v["generateAudio"]}}
	task, err := providerJSON(ctx, base, "v1/tasks/submit", config, body)
	if err != nil {
		return nil, err
	}
	id := str(asObject(task["output"])["task_id"])
	if id == "" {
		return nil, fail(502, "ModelVerse 未返回任务 ID")
	}
	for {
		result, err := providerJSON(ctx, base, "v1/tasks/status?task_id="+url.QueryEscape(id), config, nil)
		if err != nil {
			return nil, err
		}
		output := asObject(result["output"])
		status := str(output["task_status"])
		if status == "SUCCEEDED" || status == "success" || status == "Success" {
			urls := extractURLs(output)
			if len(urls) == 0 {
				return nil, fail(502, "ModelVerse 未返回视频结果")
			}
			return urls, nil
		}
		if status == "FAILED" || status == "CANCELED" || status == "Failure" || status == "Expired" || status == "Cancelled" || status == "Canceled" {
			return nil, fail(502, "ModelVerse 生成失败")
		}
		if err = waitContext(ctx); err != nil {
			return nil, err
		}
	}
}
func extractURLs(value any) []string {
	urls := []string{}
	switch v := value.(type) {
	case string:
		if strings.HasPrefix(v, "https://") || strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "data:") {
			urls = append(urls, v)
		}
	case []any:
		for _, item := range v {
			urls = append(urls, extractURLs(item)...)
		}
	case map[string]any:
		for key, item := range v {
			if key == "url" || key == "urls" || key == "video_url" || key == "image_url" || key == "audio_url" || key == "data" || key == "results" || key == "result" || key == "videos" || key == "images" {
				urls = append(urls, extractURLs(item)...)
			}
		}
	}
	return urls
}
func generateOpenAIImage(ctx context.Context, client *http.Client, base string, config, v, refs object) ([]string, error) {
	size, err := resolveProviderImageSize(str(v["modelId"]), str(v["size"]), str(v["ratio"]))
	if err != nil {
		return nil, err
	}
	body := object{"model": v["modelId"], "prompt": v["prompt"], "size": size, "n": 1, "watermark": false, "response_format": "url"}
	images := array(refs["images"])
	if len(images) == 1 {
		body["image"] = images[0]
	} else if len(images) > 1 {
		body["images"] = images
	}
	endpoint := "v1/images/generations"
	if strings.HasSuffix(base, "/v1") {
		endpoint = "images/generations"
	}
	result, err := providerClientJSON(ctx, client, base, endpoint, config, body)
	if err != nil {
		return nil, err
	}
	return imageResultURLs(result), nil
}
func generateHttpProvider(ctx context.Context, base string, p, config, v, refs object) ([]string, error) {
	client, base, err := localProviderClient(p, base)
	if err != nil {
		return nil, err
	}
	protocol := str(p["protocol"])
	if protocol == "openai" && str(v["mediaType"]) == "image" {
		return generateOpenAIImage(ctx, client, base, config, v, refs)
	}
	endpoint := str(asObject(p["endpoints"])[str(v["mediaType"])])
	if endpoint == "" {
		return nil, fail(400, "此 HTTP 供应商未声明对应媒体端点")
	}
	body := asObject(clone(v))
	delete(body, "directory")
	delete(body, "taskId")
	body["model"] = v["modelId"]
	for key, value := range refs {
		body[key] = value
	}
	result, err := providerClientJSON(ctx, client, base, endpoint, config, body)
	if err != nil {
		return nil, err
	}
	return extractURLs(result), nil
}

var providerID = regexp.MustCompile(`^[a-z][a-zA-Z0-9]{0,95}$`)

func (s *server) providerRoute(w http.ResponseWriter, r *http.Request, v object) error {
	p := strings.TrimPrefix(r.URL.Path, "/api/providers/media/")
	id := strings.TrimSuffix(strings.TrimSuffix(str(v["fileName"]), ".json"), ".ts")
	if p == "add" || p == "validate" {
		var provider object
		if builtinID := str(v["builtinId"]); builtinID != "" && p == "add" {
			builtin := builtinMediaProviders()
			for _, raw := range builtin {
				if item := asObject(raw); str(item["id"]) == builtinID {
					provider = item
					break
				}
			}
			if provider == nil {
				return fail(404, "内置供应商不存在")
			}
		} else {
			var err error
			provider, err = parseHTTPProvider(str(v["source"]))
			if err != nil {
				return err
			}
		}
		id = str(provider["id"])
		if p == "validate" {
			success(w, provider)
			return nil
		}
		for _, existing := range s.providers() {
			if str(asObject(existing)["id"]) == id {
				return fail(409, "供应商已存在，请使用其模型编辑或先明确删除")
			}
		}
		s.configMu.Lock()
		defer s.configMu.Unlock()
		previous := s.config["settings"]
		settings := asObject(clone(previous))
		providers := asObject(settings["mediaProviders"])
		if existing, ok := providers[id]; ok && existing != nil {
			return fail(409, "供应商已存在")
		}
		providers[id] = provider
		settings["mediaProviders"] = providers
		s.config["settings"] = settings
		if err := s.persistConfig(); err != nil {
			s.config["settings"] = previous
			return err
		}
		success(w, providerSnapshot(provider))
		return nil
	}
	provider, config, err := s.provider(id)
	if err != nil {
		return err
	}
	if owner := str(provider["pluginId"]); owner != "" {
		return fail(409, "供应商由插件 "+owner+" 提供，请在插件设置中停用或卸载")
	}
	if str(v["revision"]) == "" {
		return toolFailure("revisionRequired", "供应商修改须携带读取到的 revision", "validation", "notDispatched", object{}, "readState")
	}
	if str(v["revision"]) != str(provider["revision"]) {
		return stale("供应商已修改，请刷新后重试")
	}
	if p == "models" {
		modelsURL := str(provider["modelsUrl"])
		if modelsURL == "" {
			return fail(400, "供应商没有模型查询地址")
		}
		u, err := url.Parse(modelsURL)
		if err != nil {
			return err
		}
		client, base, err := localProviderClient(provider, u.Scheme+"://"+u.Host)
		if err != nil {
			return err
		}
		result, err := providerClientJSON(r.Context(), client, base, u.RequestURI(), config, nil)
		if err != nil {
			return err
		}
		v["models"] = result["data"]
		p = "save"
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	previous := s.config["settings"]
	settings := asObject(clone(previous))
	current, err := configuredProvider(settings, id)
	if err != nil {
		return err
	}
	if providerSnapshot(current)["revision"] != v["revision"] {
		return stale("供应商在操作期间已修改，未覆盖模型列表")
	}
	providers := asObject(settings["mediaProviders"])
	switch p {
	case "save":
		models := array(v["models"])
		if len(models) > 2000 {
			return fail(400, "模型过多")
		}
		seen := map[string]bool{}
		for _, raw := range models {
			m := asObject(raw)
			key := str(m["id"])
			kind := str(m["type"])
			if str(m["label"]) == "" {
				m["label"] = key
			}
			if key == "" || len(key) > 256 || strings.TrimSpace(str(m["label"])) == "" || len(str(m["label"])) > 200 || seen[key] || kind != "image" && kind != "video" && kind != "audio" && kind != "text" {
				return fail(400, "模型列表无效")
			}
			seen[key] = true
		}
		provider["models"] = models
		if err := validateVideoProvider(provider); err != nil {
			return err
		}
		delete(provider, "revision")
		providers[id] = provider
	case "delete":
		providers[id] = nil
		delete(asObject(settings["mediaProviderConfigs"]), id)
	default:
		return fail(404, "供应商操作不存在")
	}
	settings["mediaProviders"] = providers
	s.config["settings"] = settings
	if err = s.persistConfig(); err != nil {
		s.config["settings"] = previous
		return err
	}
	if p == "delete" {
		success(w, nil)
	} else {
		success(w, providerSnapshot(provider))
	}
	return nil
}
