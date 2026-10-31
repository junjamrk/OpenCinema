package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// ComfyUI 工作流按黑盒执行：Provider 模型保存 API 格式的图和显式输入映射，
// 这里只替换映射到的字段、提交并回收产物，不解析或改写工作流的生成逻辑。
// ACT: 工作流只由用户在设置页导入；Agent 工具和生成请求都不能写入或携带图。

var comfyListSlots = map[string]bool{"images": true, "videos": true, "audios": true}
var comfyOutputTypes = map[string]map[string]string{
	"image": {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"},
	"video": {".mp4": "video/mp4", ".webm": "video/webm"},
	"audio": {".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg"},
}
var comfyUploadExtensions = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "audio/wave": ".wav", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/flac": ".flac"}

type comfyConnection struct {
	client   *http.Client
	endpoint *url.URL
}

// 内置 comfyui 供应商的地址和启用状态来自本地连接；用户添加的其他 ComfyUI 服务用自己的 apiUrl，随供应商增删。
func (s *server) comfyEnabled(provider object) bool {
	return str(provider["id"]) != "comfyui" || boolean(asObject(localMediaConnectionState(s.settings())["config"])["enabled"])
}

func validateComfyModel(model object) error {
	options, valid := model["comfy"].(map[string]any)
	kind := str(model["type"])
	if !valid || (kind != "image" && kind != "video" && kind != "audio") {
		return fail(400, "ComfyUI 模型须为图片、视频或音频，并包含 comfy.workflow 与 comfy.inputs")
	}
	for key := range options {
		if key != "workflow" && key != "inputs" && key != "fps" && key != "frameStep" {
			return fail(400, "未知 ComfyUI 模型字段: "+key)
		}
	}
	workflow, valid := options["workflow"].(map[string]any)
	if !valid || len(workflow) == 0 || len(workflow) > 5000 {
		return fail(400, "comfy.workflow 须为 ComfyUI 导出的 API 格式工作流")
	}
	if encoded, _ := json.Marshal(workflow); len(encoded) > 2*1024*1024 {
		return fail(413, "ComfyUI 工作流超过 2MiB")
	}
	if providerManifestHasSecret(workflow) {
		return fail(403, "ComfyUI 工作流不能包含凭据")
	}
	for id, raw := range workflow {
		node, valid := raw.(map[string]any)
		if _, literal := node["inputs"].(map[string]any); !valid || !literal || str(node["class_type"]) == "" {
			return fail(400, "节点 "+id+" 不是 API 格式；请在 ComfyUI 中用导出（API）重新导出")
		}
	}
	inputs, valid := options["inputs"].(map[string]any)
	if !valid {
		return fail(400, "comfy.inputs 须为对象")
	}
	literals := func(slot string, raw any) ([]any, error) {
		targets, valid := raw.([]any)
		if !valid || len(targets) == 0 || len(targets) > 64 {
			return nil, fail(400, "ComfyUI 输入 "+slot+" 须映射1至64个目标")
		}
		values := []any{}
		for _, rawTarget := range targets {
			target := asObject(rawTarget)
			value, exists := asObject(asObject(workflow[str(target["node"])])["inputs"])[str(target["field"])]
			if _, linked := value.([]any); !exists || linked {
				return nil, fail(400, "ComfyUI 输入 "+slot+" 须指向节点上的固定值，不能指向连线")
			}
			values = append(values, value)
		}
		return values, nil
	}
	for slot, raw := range inputs {
		if slot == "parameters" {
			continue
		}
		if !comfyListSlots[slot] && slot != "prompt" && slot != "firstFrame" && slot != "lastFrame" && slot != "width" && slot != "height" && slot != "frames" {
			return fail(400, "未知 ComfyUI 输入: "+slot)
		}
		if _, err := literals(slot, raw); err != nil {
			return err
		}
	}
	// 声明与映射必须一一对应：没映射的参数写不进工作流，不能显示在节点上再静默丢弃。
	declared := asObject(asObject(model["parameters"])["properties"])
	mapped, valid := inputs["parameters"].(map[string]any)
	if inputs["parameters"] != nil && !valid {
		return fail(400, "comfy.inputs.parameters 须为对象")
	}
	for name, raw := range mapped {
		field, exists := declared[name]
		if !exists {
			return fail(400, "ComfyUI 映射了未声明的参数: "+name)
		}
		values, err := literals("parameters."+name, raw)
		if err != nil {
			return err
		}
		for _, value := range values {
			if !parameterTypeMatches(str(asObject(field)["type"]), value) {
				return fail(400, "ComfyUI 参数类型与工作流字段不符: "+name)
			}
		}
	}
	for name := range declared {
		if mapped[name] == nil {
			return fail(400, "ComfyUI 参数须在 comfy.inputs.parameters 中映射: "+name)
		}
	}
	if len(array(inputs["prompt"])) == 0 {
		return fail(400, "ComfyUI 工作流须映射提示词；未映射的输入不能静默丢弃")
	}
	if (inputs["width"] == nil) != (inputs["height"] == nil) {
		return fail(400, "ComfyUI 宽和高须同时映射")
	}
	if inputs["frames"] != nil && number(options["fps"]) <= 0 {
		return fail(400, "映射帧数时须声明 comfy.fps")
	}
	return nil
}

func comfyDimensions(options, input object, kind string) (int, int, bool, error) {
	inputs, workflow := asObject(options["inputs"]), asObject(options["workflow"])
	ratio := strings.Split(str(input["ratio"]), ":")
	if inputs["width"] == nil || len(ratio) != 2 {
		// ACT: 工作流未映射尺寸时由它自己决定，节点上的画幅不生效；导入时已提示。
		return 0, 0, false, nil
	}
	literal := func(slot string) int {
		target := asObject(array(inputs[slot])[0])
		return int(number(asObject(asObject(workflow[str(target["node"])])["inputs"])[str(target["field"])]))
	}
	short := min(literal("width"), literal("height"))
	side := str(input["resolution"])
	if kind == "image" {
		side = str(input["size"])
	}
	if side != "" {
		value, err := strconv.Atoi(strings.TrimSuffix(side, "p"))
		if err != nil || value <= 0 || value > 16384 {
			return 0, 0, false, fail(400, "ComfyUI 分辨率须写成短边像素，例如 720p")
		}
		short = value
	}
	a, _ := strconv.Atoi(ratio[0])
	b, _ := strconv.Atoi(ratio[1])
	if a <= 0 || b <= 0 {
		return 0, 0, false, fail(400, "视频画幅无效")
	}
	// 潜空间模型按 8 像素对齐；工作流原尺寸在此取整下保持不变。
	long := int(math.Round(float64(short)*float64(max(a, b))/float64(min(a, b))/8)) * 8
	if a >= b {
		return long, short, true, nil
	}
	return short, long, true, nil
}

func comfyFrames(options object, duration float64) int {
	step := max(1, int(number(options["frameStep"])))
	frames := int(math.Round(duration * number(options["fps"])))
	return max(1, int(math.Round(float64(frames-1)/float64(step)))*step+1)
}

func (c comfyConnection) prepare(ctx context.Context, model, input, refs object) (object, error) {
	options := asObject(model["comfy"])
	inputs := asObject(options["inputs"])
	workflow := asObject(clone(options["workflow"]))
	write := func(targets []any, value any) {
		for _, raw := range targets {
			target := asObject(raw)
			asObject(asObject(workflow[str(target["node"])])["inputs"])[str(target["field"])] = value
		}
	}
	assign := func(slot string, value any) { write(array(inputs[slot]), value) }
	assign("prompt", input["prompt"])
	fixed := map[string]bool{}
	for name, value := range asObject(input["parameters"]) {
		targets := array(asObject(inputs["parameters"])[name])
		write(targets, value)
		for _, raw := range targets {
			fixed[str(asObject(raw)["node"])+"/"+str(asObject(raw)["field"])] = true
		}
	}
	width, height, sized, err := comfyDimensions(options, input, str(model["type"]))
	if err != nil {
		return nil, err
	}
	if sized {
		assign("width", width)
		assign("height", height)
	}
	if input["duration"] != nil {
		if inputs["frames"] == nil {
			return nil, fail(400, "此工作流未映射帧数，不能设置时长")
		}
		assign("frames", comfyFrames(options, number(input["duration"])))
	}
	for _, slot := range []string{"images", "videos", "audios"} {
		values, targets := array(refs[slot]), array(inputs[slot])
		if len(values) != len(targets) {
			return nil, fail(400, fmt.Sprintf("此工作流的 %s 需要 %d 个素材，当前为 %d 个；未提交生成", slot, len(targets), len(values)))
		}
		for index, value := range values {
			name, err := c.upload(ctx, str(value))
			if err != nil {
				return nil, err
			}
			target := asObject(targets[index])
			asObject(asObject(workflow[str(target["node"])])["inputs"])[str(target["field"])] = name
		}
	}
	for _, slot := range []string{"firstFrame", "lastFrame"} {
		if (refs[slot] != nil) != (inputs[slot] != nil) {
			return nil, fail(400, "此工作流的 "+slot+" 与当前参考不匹配；未提交生成")
		}
		if refs[slot] != nil {
			name, err := c.upload(ctx, str(refs[slot]))
			if err != nil {
				return nil, err
			}
			assign(slot, name)
		}
	}
	// ComfyUI 对完全相同的图直接返回缓存，每次提交必须换种子才会真正重新生成；用户填了种子时以用户为准。
	for id, raw := range workflow {
		fields := asObject(asObject(raw)["inputs"])
		for _, field := range []string{"seed", "noise_seed"} {
			if _, literal := fields[field].(float64); literal && !fixed[id+"/"+field] {
				fields[field] = rand.Int64N(1 << 53)
			}
		}
	}
	return workflow, nil
}

func (c comfyConnection) send(ctx context.Context, method, path string, query url.Values, body io.Reader, contentType string) (*http.Response, error) {
	target := *c.endpoint
	target.Path += path
	target.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("ComfyUI 连接失败: %w", err)
	}
	return response, nil
}

func (c comfyConnection) post(ctx context.Context, path string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	response, err := c.send(ctx, http.MethodPost, path, nil, bytes.NewReader(data), "application/json")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fail(502, fmt.Sprintf("ComfyUI %s 返回 HTTP %d", path, response.StatusCode))
	}
	return nil
}

// ACT: 按内容命名后放在 input 根目录，同一素材不重复上传。子目录会让部分自定义加载节点的下拉校验失败；
// 上限是文件留在 ComfyUI 的 input 目录，由用户在 ComfyUI 侧清理。
func (c comfyConnection) upload(ctx context.Context, value string) (string, error) {
	parts := strings.SplitN(value, ",", 2)
	mimeType := strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
	extension := comfyUploadExtensions[mimeType]
	if len(parts) != 2 || extension == "" {
		return "", fail(415, "ComfyUI 不支持此参考素材格式: "+mimeType)
	}
	data, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	part, err := writer.CreateFormFile("image", "openCinema_"+hash(data)[:32]+extension)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(data); err != nil {
		return "", err
	}
	for field, text := range map[string]string{"type": "input", "overwrite": "true"} {
		if err = writer.WriteField(field, text); err != nil {
			return "", err
		}
	}
	if err = writer.Close(); err != nil {
		return "", err
	}
	response, err := c.send(ctx, http.MethodPost, "/upload/image", nil, &buffer, writer.FormDataContentType())
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	var result object
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result) != nil || str(result["name"]) == "" {
		return "", fail(502, fmt.Sprintf("ComfyUI 素材上传失败（HTTP %d）", response.StatusCode))
	}
	return path.Join(str(result["subfolder"]), str(result["name"])), nil
}

func comfyRejection(data []byte) string {
	var result object
	_ = json.Unmarshal(data, &result)
	details := []string{}
	failure := asObject(result["error"])
	if text := strings.TrimSpace(str(failure["message"]) + " " + str(failure["details"])); text != "" {
		details = append(details, text)
	}
	ids := []string{}
	nodes := asObject(result["node_errors"])
	for id := range nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		node := asObject(nodes[id])
		for _, raw := range array(node["errors"]) {
			item := asObject(raw)
			details = append(details, fmt.Sprintf("节点 %s %s: %s %s", id, str(node["class_type"]), str(item["message"]), str(item["details"])))
		}
	}
	text := strings.Join(details, "；")
	if len(text) > 2000 {
		text = strings.ToValidUTF8(text[:2000], "")
	}
	if text == "" {
		return "未返回校验详情"
	}
	return text
}

func (c comfyConnection) submit(ctx context.Context, provider, config, input, workflow object) (object, error) {
	id := strings.ToLower(str(input["taskId"]))
	data, err := json.Marshal(object{"prompt": workflow, "prompt_id": id, "client_id": id})
	if err != nil {
		return nil, err
	}
	job := currentVideoJob(ctx)
	job["protocol"], job["providerId"], job["modelId"], job["id"] = "comfyui", provider["id"], input["modelId"], id
	job["configRevision"], job["cancelMode"] = videoConfigRevision(config), "request"
	// 任务 ID 在提交前落盘：响应丢失后按同一 ID 查询，不重新提交。
	if err = beginVideoSubmission(ctx, job); err != nil {
		return nil, err
	}
	discard := func(cause error) error {
		delete(job, "id")
		return errors.Join(cause, updateVideoJob(ctx, job))
	}
	response, err := c.send(ctx, http.MethodPost, "/prompt", nil, bytes.NewReader(data), "application/json")
	if err != nil {
		var network *net.OpError
		if errors.As(err, &network) && network.Op == "dial" {
			return nil, discard(err)
		}
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	if response.StatusCode == http.StatusBadRequest {
		return nil, discard(fail(400, "ComfyUI 拒绝工作流："+comfyRejection(body)))
	}
	if response.StatusCode != http.StatusOK {
		return nil, fail(502, fmt.Sprintf("ComfyUI /prompt 返回 HTTP %d", response.StatusCode))
	}
	var result object
	if json.Unmarshal(body, &result) != nil || !uuidValue.MatchString(str(result["prompt_id"])) {
		return nil, fail(502, "ComfyUI 未返回有效任务 ID；禁止自动重新提交")
	}
	// 旧版 ComfyUI 忽略客户端 ID，以服务端返回值为准。
	job["id"] = result["prompt_id"]
	return job, updateVideoJob(ctx, job)
}

func (c comfyConnection) state(ctx context.Context, id string) (string, object, error) {
	// 先查队列再查历史：任务只会从队列进入历史，反过来查会在完成瞬间两边都查不到。
	queue, err := localComfyJSON(ctx, c.client, c.endpoint, "/queue", 64*1024*1024)
	if err != nil {
		return "", nil, err
	}
	for key, state := range map[string]string{"queue_running": "running", "queue_pending": "queued"} {
		for _, raw := range array(queue[key]) {
			if item := array(raw); len(item) > 1 && str(item[1]) == id {
				return state, nil, nil
			}
		}
	}
	history, err := localComfyJSON(ctx, c.client, c.endpoint, "/history/"+id, 64*1024*1024)
	if err != nil {
		return "", nil, err
	}
	entry := asObject(history[id])
	if len(entry) == 0 {
		return "missing", nil, nil
	}
	status := asObject(entry["status"])
	if str(status["status_str"]) != "error" {
		return "completed", entry, nil
	}
	for _, raw := range array(status["messages"]) {
		if item := array(raw); len(item) > 0 && str(item[0]) == "execution_interrupted" {
			return "cancelled", entry, nil
		}
	}
	return "failed", entry, nil
}

func comfyFailure(entry object) string {
	for _, raw := range array(asObject(entry["status"])["messages"]) {
		if item := array(raw); len(item) == 2 && str(item[0]) == "execution_error" {
			details := asObject(item[1])
			text := strings.TrimSpace(str(details["node_type"]) + " " + str(details["exception_message"]))
			if len(text) > 2000 {
				text = strings.ToValidUTF8(text[:2000], "")
			}
			return text
		}
	}
	return "未返回错误详情"
}

func comfyOutputs(entry object, kind string) []object {
	nodes := asObject(entry["outputs"])
	ids := []string{}
	for id := range nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	items := []object{}
	for _, id := range ids {
		// 产物字段不固定（images、gifs、audio 等），按文件类型筛选，只收 output 目录的正式文件。
		for _, raw := range asObject(nodes[id]) {
			for _, rawItem := range array(raw) {
				item := asObject(rawItem)
				extension := strings.ToLower(path.Ext(str(item["filename"])))
				if str(item["type"]) == "output" && comfyOutputTypes[kind][extension] != "" {
					items = append(items, item)
				}
			}
		}
	}
	return items
}

func (c comfyConnection) download(ctx context.Context, item object, kind string) (string, error) {
	filename := str(item["filename"])
	query := url.Values{"filename": {filename}, "subfolder": {str(item["subfolder"])}, "type": {"output"}}
	response, err := c.send(ctx, http.MethodGet, "/view", query, nil, "")
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fail(502, fmt.Sprintf("下载 ComfyUI 产物失败（HTTP %d）", response.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 100*1024*1024+1))
	if err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > 100*1024*1024 {
		return "", fail(413, "ComfyUI 产物为空或超过100MiB")
	}
	mimeType := comfyOutputTypes[kind][strings.ToLower(path.Ext(filename))]
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func (c comfyConnection) cancel(ctx context.Context, job object) error {
	deadline, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	id := str(job["id"])
	for {
		state, _, err := c.state(deadline, id)
		if err != nil {
			return err
		}
		switch state {
		case "queued":
			if err = c.post(deadline, "/queue", object{"delete": []any{id}}); err != nil {
				return err
			}
		case "running":
			// ACT: 新版只中断此任务；不识别 prompt_id 的旧版会中断当前运行项，上面刚确认过它就是此任务。
			// 上限是确认与中断之间任务恰好结束的毫秒级窗口，升级方式是只用 /api/jobs/{id}/cancel。
			if err = c.post(deadline, "/interrupt", object{"prompt_id": id}); err != nil {
				return err
			}
		case "completed":
			job["status"] = state
			return errors.Join(settleVideoRemote(ctx, job), fail(499, "取消时 ComfyUI 已完成任务；保留原任务产物"))
		case "missing":
			job["status"] = "cancelled"
			return errors.Join(settleVideoRemote(ctx, job), fail(499, "ComfyUI 已没有此任务，不再运行"))
		default:
			job["status"] = "cancelled"
			return errors.Join(settleVideoRemote(ctx, job), fail(499, "ComfyUI 已确认任务取消"))
		}
		select {
		case <-deadline.Done():
			return fail(409, "已请求取消，ComfyUI 尚未确认终止；保留原任务")
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func readComfyFrame(reader *bufio.Reader) (byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(reader, head[:]); err != nil {
		return 0, nil, err
	}
	size := int64(head[1] & 0x7f)
	if size == 126 {
		var extended [2]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return 0, nil, err
		}
		size = int64(binary.BigEndian.Uint16(extended[:]))
	} else if size == 127 {
		var extended [8]byte
		if _, err := io.ReadFull(reader, extended[:]); err != nil {
			return 0, nil, err
		}
		size = int64(binary.BigEndian.Uint64(extended[:]))
	}
	if size < 0 {
		return 0, nil, fail(502, "ComfyUI WebSocket 帧无效")
	}
	// 预览图等大帧不解析，只跳过。
	if size > 1024*1024 {
		_, err := io.CopyN(io.Discard, reader, size)
		return 0, nil, err
	}
	payload := make([]byte, size)
	_, err := io.ReadFull(reader, payload)
	return head[0] & 0x0f, payload, err
}

// 进度只用于展示，任务状态始终以轮询为准，所以这里任何失败都直接放弃。
// ACT: 只实现读进度所需的最小 WebSocket 客户端，不支持 https 端点和分片文本帧；需要时再换成完整实现。
func (c comfyConnection) watchProgress(ctx context.Context, id string, progress *atomic.Int64) {
	if c.endpoint.Scheme != "http" {
		return
	}
	connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", c.endpoint.Host)
	if err != nil {
		return
	}
	defer connection.Close()
	defer context.AfterFunc(ctx, func() { connection.Close() })()
	target := *c.endpoint
	target.Path += "/ws"
	target.RawQuery = url.Values{"clientId": {id}}.Encode()
	key := base64.StdEncoding.EncodeToString([]byte(randomID())[:16])
	if _, err = fmt.Fprintf(connection, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", target.RequestURI(), target.Host, key); err != nil {
		return
	}
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		return
	}
	for {
		opcode, payload, err := readComfyFrame(reader)
		if err != nil || opcode == 8 {
			return
		}
		if opcode == 9 && len(payload) <= 125 {
			// 客户端帧必须带掩码；全零掩码不改变内容。
			frame := append([]byte{0x8a, 0x80 | byte(len(payload)), 0, 0, 0, 0}, payload...)
			if _, err = connection.Write(frame); err != nil {
				return
			}
		}
		if opcode != 1 {
			continue
		}
		var message object
		if json.Unmarshal(payload, &message) != nil || str(message["type"]) != "progress" {
			continue
		}
		data := asObject(message["data"])
		if str(data["prompt_id"]) == id && number(data["max"]) > 0 {
			progress.Store(int64(number(data["value"]) * 100 / number(data["max"])))
		}
	}
}

func (s *server) mediaCancelRequested(ctx context.Context) bool {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil {
		return false
	}
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	return value.task.cancelRequested
}

func (s *server) generateComfy(ctx context.Context, provider, config, input, refs object) ([]string, error) {
	endpoint, err := localMediaEndpoint(providerBase(provider, config))
	if err != nil {
		return nil, err
	}
	client := localComfyClient(endpoint)
	client.Timeout = 2 * time.Minute
	defer client.CloseIdleConnections()
	connection := comfyConnection{client, endpoint}
	job := currentVideoJob(ctx)
	if str(job["id"]) == "" {
		if job["protocol"] != nil {
			return nil, fail(409, "上次提交未确认；不能自动重新生成")
		}
		workflow, err := connection.prepare(ctx, providerModel(provider, str(input["modelId"])), input, refs)
		if err != nil {
			return nil, err
		}
		if job, err = connection.submit(ctx, provider, config, input, workflow); err != nil {
			return nil, err
		}
	} else if job["configRevision"] != videoConfigRevision(config) {
		// 查询只依赖连接：工作流都存在同一供应商里，运行中导入新工作流不影响已提交的任务。
		return nil, fail(409, "ComfyUI 连接已变化；保留原任务，不能向其他连接恢复查询")
	}
	kind := str(input["mediaType"])
	var progress atomic.Int64
	progress.Store(-1)
	go connection.watchProgress(ctx, str(job["id"]), &progress)
	for {
		if s.mediaCancelRequested(ctx) && job["status"] != "completed" {
			return nil, connection.cancel(ctx, job)
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		state, entry, err := connection.state(ctx, str(job["id"]))
		if err != nil {
			if ctx.Err() != nil {
				continue
			}
			return nil, err
		}
		switch state {
		case "missing":
			job["status"] = state
			return nil, errors.Join(updateVideoJob(ctx, job), fail(409, "ComfyUI 没有此任务记录，可能已重启；保留原任务，不自动重新提交"))
		case "failed", "cancelled":
			job["status"] = state
			if err := settleVideoRemote(ctx, job); err != nil {
				return nil, err
			}
			if state == "cancelled" {
				return nil, fail(499, "ComfyUI 已确认任务取消")
			}
			return nil, fail(502, "ComfyUI 执行失败："+comfyFailure(entry))
		case "completed":
			job["status"] = state
			if err := settleVideoRemote(ctx, job); err != nil {
				return nil, err
			}
			items := comfyOutputs(entry, kind)
			if len(items) == 0 {
				return nil, fail(502, "工作流已完成，但没有 "+kind+" 类型的保存产物；请确认它使用了保存节点")
			}
			results := []string{}
			for _, item := range items {
				result, err := connection.download(ctx, item, kind)
				if err != nil {
					return nil, err
				}
				results = append(results, result)
			}
			return results, nil
		}
		job["status"] = state
		if value := progress.Load(); value >= 0 {
			job["progress"] = float64(value)
		}
		if err := updateVideoJob(ctx, job); err != nil {
			return nil, err
		}
		// 取消或超时都回到循环开头处理，这里不提前返回。
		_ = waitContext(ctx)
	}
}
