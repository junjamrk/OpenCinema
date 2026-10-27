package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed depthModel.json
var depthModelBytes []byte

//go:embed referenceDepthWorker.py
var depthWorkerSource string

const depthNormalization = "clip min/max; temporally aligned relative inverse depth, no metric calibration"

type depthTask struct {
	input            object
	fingerprint      string
	state            string
	cancel           context.CancelFunc
	ctx              context.Context
	settled          bool
	durable          bool
	cancelRequested  bool
	result           object
	error, errorCode string
	touched          time.Time
}

var depthMu sync.Mutex
var depthTasks = map[string]*depthTask{}

func depthModel() object { var model object; _ = json.Unmarshal(depthModelBytes, &model); return model }
func (s *server) depthModelPath(ctx context.Context) (string, error) {
	root, err := workspacePath(s.dataDirectory, ".models/videoDepthAnythingSmall", false)
	if err != nil {
		return "", err
	}
	for _, value := range array(depthModel()["files"]) {
		entry := asObject(value)
		path, pathErr := workspacePath(root, str(entry["name"]), false)
		if pathErr != nil {
			return "", pathErr
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			return "", statErr
		}
		if info.Size() != int64(number(entry["size"])) || !info.Mode().IsRegular() {
			return "", fail(424, "Video Depth Anything 固定模型或源码大小不匹配")
		}
		digest, hashErr := hashFile(ctx, path)
		if hashErr != nil {
			return "", hashErr
		}
		if digest != str(entry["sha256"]) {
			return "", fail(424, "Video Depth Anything 模型或源码 SHA256 校验失败")
		}
	}
	return filepath.Join(root, "video_depth_anything_vits.pth"), nil
}
func (s *server) depthRuntime(ctx context.Context) (string, string, error) {
	python := filepath.Join(s.dataDirectory, ".models/videoDepthRuntime/bin/python")
	if runtime.GOOS == "windows" {
		python = filepath.Join(s.dataDirectory, ".models/videoDepthRuntime/Scripts/python.exe")
	}
	if info, err := os.Stat(python); err != nil || !info.Mode().IsRegular() {
		return "", "", fail(424, "请先准备 Video Depth Anything 的独立 Python/PyTorch 运行环境")
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	device := os.Getenv("OPEN_CINEMA_DEPTH_DEVICE")
	if device == "" {
		device = "cpu"
	}
	if device != "cpu" && device != "cuda" && device != "mps" {
		return "", "", fail(424, "Video Depth Anything device 须为 cpu/cuda/mps")
	}
	probe := "import torch,torchvision,cv2,numpy,einops,easydict,tqdm; assert torch.__version__.split('+')[0]=='2.6.0'; assert torchvision.__version__.split('+')[0]=='0.21.0'; assert numpy.__version__=='1.26.4'; import sys; device=sys.argv[1]; assert device=='cpu' or (device=='cuda' and torch.cuda.is_available()) or (device=='mps' and torch.backends.mps.is_available())"
	if err := exec.CommandContext(ctx, python, "-I", "-B", "-c", probe, device).Run(); err != nil {
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
		return "", "", fail(424, "Video Depth Anything 独立 PyTorch 依赖或所选设备不可用，请重新准备；不会回退到旧单帧模型")
	}
	return python, device, nil
}
func (s *server) depthModelStatus(ctx context.Context) object {
	ctx, cancel := context.WithTimeout(ctx, 65*time.Second)
	defer cancel()
	_, modelErr := s.depthModelPath(ctx)
	runtimeErr := error(fail(424, "请先准备固定视频深度模型及其独立运行环境"))
	if modelErr == nil {
		_, _, runtimeErr = s.depthRuntime(ctx)
	}
	_, ffmpegErr := s.toolPath("ffmpeg")
	_, ffprobeErr := s.toolPath("ffprobe")
	phase := "ready"
	message := "Video Depth Anything Small 时序模型可用，片段统一归一化；本机推理不上传视频"
	if modelErr != nil {
		phase = "missing"
		message = "Video Depth Anything Small 权重或固定源码未准备／校验未通过；不会回退旧单帧模型"
	} else if runtimeErr != nil {
		message = runtimeErr.Error()
	} else if ffmpegErr != nil || ffprobeErr != nil {
		message = "请配置可用的 FFmpeg 与 FFprobe"
	}
	preparationMu.Lock()
	record := preparations[s.dataDirectory]
	progress := preparationSnapshot(record)
	if record == nil && modelErr == nil {
		progress = object{"phase": "ready", "received": depthDownloadSize(), "total": depthDownloadSize()}
	}
	if record != nil && (record.phase != "ready" || modelErr != nil) {
		phase = record.phase
	}
	preparationMu.Unlock()
	preparing := phase == "preparing" || phase == "cancelling" || phase == "committing"
	if preparing {
		message = "视频深度模型及独立运行环境正在准备或收尾，请查询原准备状态"
	}
	return object{"available": !preparing && modelErr == nil && runtimeErr == nil && ffmpegErr == nil && ffprobeErr == nil, "model": depthModel(), "phase": phase, "runtimeAvailable": runtimeErr == nil, "mediaToolsAvailable": ffmpegErr == nil && ffprobeErr == nil, "message": message, "preparationProgress": progress, "preparation": object{"automatic": false, "entry": "设置 → 本地分析模型 → 准备视频深度白模", "modelId": "videoDepthAnythingSmall"}}
}
func (s *server) authorizeDepth(r *http.Request, directory string) (string, error) {
	if !s.localRequest(r) || r.Header.Get("X-Toonflow-Collaboration") != "" || r.Header.Get("X-Studio-Project") != "" || r.Header.Get("X-Studio-Token") != "" {
		return "", fail(403, "相对深度仅支持本机普通画布，不能借用协作角色")
	}
	root, err := s.workspace(r, directory)
	if err != nil {
		return "", err
	}
	s.roomsMu.Lock()
	defer s.roomsMu.Unlock()
	for _, room := range s.rooms {
		if !room.Closed && room.Directory == root {
			return "", fail(403, "请先结束此工作区的活动协作")
		}
	}
	if within(filepath.Join(s.dataDirectory, "studio"), root) {
		return "", fail(403, "Studio 工程应使用其权威分析入口")
	}
	return root, nil
}
func depthSnapshot(task *depthTask) object {
	result := asObject(clone(task.input))
	delete(result, "sourcePath")
	delete(result, "contentSha256")
	delete(result, "settings")
	result["input"] = clone(task.input)
	result["outputDirectory"] = "assets/" + str(task.input["nodeId"]) + "/motionDepth" + strings.ReplaceAll(str(task.input["operationId"]), "-", "")
	result["state"] = task.state
	result["executionSettled"] = task.settled
	result["cancelRequested"] = task.cancelRequested
	if task.result != nil {
		result["result"] = clone(task.result)
	}
	if task.error != "" {
		result["error"] = task.error
		result["errorCode"] = task.errorCode
	}
	return result
}
func depthUnknown(input object, message string) object {
	return object{"operationId": input["operationId"], "directory": input["directory"], "canvasId": input["canvasId"], "nodeId": input["nodeId"],
		"state": "unknown", "executionSettled": false, "cancelRequested": false, "error": message, "errorCode": "OPERATION_UNKNOWN"}
}
func (s *server) depthReceiptPath(id string) (string, error) {
	root, err := workspacePath(s.dataDirectory, "depthOperations", true)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "operation"+strings.ReplaceAll(id, "-", "")+".json"), nil
}
func (s *server) readDepthReceipt(id string) (object, error) {
	path, err := s.depthReceiptPath(id)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 64*1024 {
		return nil, fail(409, "原深度操作记录无效，保留操作ID与已有产物，不能重派")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var receipt object
	if json.Unmarshal(data, &receipt) != nil || !moduleRevision.MatchString(str(receipt["fingerprint"])) {
		return nil, fail(409, "原深度操作记录或摘要无效，不能重派")
	}
	return receipt, nil
}
func restoredDepthSnapshot(receipt, binding object) object {
	unknown := depthUnknown(binding, "原操作没有可验证的持久终态；不会重新派发，请保留操作ID并核对原产物")
	input := asObject(receipt["input"])
	for _, key := range []string{"operationId", "directory", "canvasId", "nodeId"} {
		if str(input[key]) != str(binding[key]) {
			return unknown
		}
	}
	if str(input["sourcePath"]) == "" || !moduleRevision.MatchString(str(input["contentSha256"])) {
		return unknown
	}
	bytes, err := json.Marshal(input)
	if err != nil || hash(bytes) != str(receipt["fingerprint"]) {
		return unknown
	}
	snapshot := asObject(receipt["snapshot"])
	bytes, err = json.Marshal(snapshot)
	if err != nil || hash(bytes) != str(receipt["snapshotSha256"]) || !reflect.DeepEqual(snapshot["input"], input) || !boolean(snapshot["executionSettled"]) {
		return unknown
	}
	for _, key := range []string{"operationId", "directory", "canvasId", "nodeId"} {
		if str(snapshot[key]) != str(input[key]) {
			return unknown
		}
	}
	state := str(snapshot["state"])
	if state != "succeeded" && state != "failed" && state != "cancelled" {
		return unknown
	}
	if state == "succeeded" {
		result := asObject(snapshot["result"])
		source := asObject(result["source"])
		if str(result["operationId"]) != str(input["operationId"]) || str(result["canvasId"]) != str(input["canvasId"]) || str(result["nodeId"]) != str(input["nodeId"]) || str(source["path"]) != str(input["sourcePath"]) || str(source["contentSha256"]) != str(input["contentSha256"]) || !reflect.DeepEqual(result["settings"], input["settings"]) {
			return unknown
		}
	} else if snapshot["result"] != nil {
		return unknown
	}
	return snapshot
}
func (s *server) persistDepthTerminal(task *depthTask) error {
	if !task.settled || task.durable {
		return nil
	}
	path, err := s.depthReceiptPath(str(task.input["operationId"]))
	if err != nil {
		return err
	}
	snapshot := depthSnapshot(task)
	bytes, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	receipt, err := json.Marshal(object{"fingerprint": task.fingerprint, "input": task.input, "snapshot": snapshot, "snapshotSha256": hash(bytes)})
	if err != nil {
		return err
	}
	if len(receipt) > 64*1024 {
		return fail(413, "视频深度终态记录超过持久化范围")
	}
	if err = atomicWrite(path, receipt, false, 0600); err != nil {
		return err
	}
	task.durable = true
	return nil
}
func (s *server) depthResponse(task *depthTask) object {
	if err := s.persistDepthTerminal(task); err != nil {
		unknown := depthUnknown(task.input, "原操作已收尾但终态保存失败；请保留原ID重查，不重新派发。"+err.Error())
		unknown["input"] = clone(task.input)
		return unknown
	}
	return depthSnapshot(task)
}
func (s *server) depthRoute(w http.ResponseWriter, r *http.Request) error {
	operation := strings.TrimPrefix(r.URL.Path, "/api/media/referenceDepth/")
	if operation == "modelStatus" {
		if _, err := s.authorizeDepth(r, r.URL.Query().Get("directory")); err != nil {
			return err
		}
		success(w, s.depthModelStatus(r.Context()))
		return nil
	}
	input, err := decode(r)
	if err != nil {
		return err
	}
	if operation == "prepareModel" || operation == "cancelModelPreparation" {
		return s.prepareDepthModel(w, r, input, operation == "cancelModelPreparation")
	}
	directory, err := s.authorizeDepth(r, str(input["directory"]))
	if err != nil {
		return err
	}
	input["directory"] = directory
	id := str(input["operationId"])
	nodeID := str(input["nodeId"])
	if !uuidValue.MatchString(id) || len(nodeID) < 1 || len(nodeID) > 200 || nodeID == "." || nodeID == ".." || strings.ContainsAny(nodeID, "/\\\x00") {
		return fail(400, "相对深度冻结绑定无效")
	}
	for _, character := range nodeID {
		if character < 32 {
			return fail(400, "相对深度节点ID含无效字符")
		}
	}
	canvasID := str(input["canvasId"])
	if !strings.HasSuffix(strings.ToLower(canvasID), ".json") || strings.HasPrefix(canvasID, "assets/") {
		return fail(400, "相对深度须绑定已保存的普通画布")
	}
	if _, err = workspacePath(directory, canvasID, true); err != nil {
		return err
	}
	depthMu.Lock()
	defer depthMu.Unlock()
	task := depthTasks[id]
	if operation == "status" || operation == "cancel" {
		if task == nil || str(task.input["directory"]) != directory || str(task.input["canvasId"]) != str(input["canvasId"]) || str(task.input["nodeId"]) != str(input["nodeId"]) {
			receipt, readErr := s.readDepthReceipt(id)
			if readErr != nil {
				return readErr
			}
			if receipt != nil {
				success(w, restoredDepthSnapshot(receipt, input))
			} else {
				success(w, depthUnknown(input, "操作未登记、已过期或服务已重启；请保留原操作ID与草稿，不能据此判断任务已终止。"))
			}
			return nil
		}
		task.touched = time.Now()
		if operation == "cancel" && !task.settled {
			task.cancelRequested = true
			task.cancel()
			task.state = "cancelling"
		}
		success(w, s.depthResponse(task))
		return nil
	}
	if operation != "start" {
		return fail(404, "相对深度接口不存在")
	}
	fingerprintBytes, _ := json.Marshal(input)
	fingerprint := hash(fingerprintBytes)
	if task != nil {
		if task.fingerprint != fingerprint {
			return fail(409, "操作ID已用于其他冻结请求，不能改参重放")
		}
		success(w, s.depthResponse(task))
		return nil
	}
	receiptPath, err := s.depthReceiptPath(id)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(receiptPath), 0700); err != nil {
		return err
	}
	recorded, err := s.readDepthReceipt(id)
	if err != nil {
		return err
	}
	if recorded != nil {
		if str(recorded["fingerprint"]) != fingerprint {
			return fail(409, "操作ID已有持久记录，不能改参重放")
		}
		success(w, restoredDepthSnapshot(recorded, input))
		return nil
	}
	for _, active := range depthTasks {
		if !active.settled {
			return fail(429, "本机相对深度任务仍在执行或收尾")
		}
	}
	settings := asObject(input["settings"])
	duration := number(settings["end"]) - number(settings["start"])
	fps := number(settings["sampleFps"])
	if duration <= 0 || duration > 30 || number(settings["start"]) < 0 || fps < 2 || fps > 12 || math.Trunc(fps) != fps {
		return fail(400, "相对深度范围须在30秒内，采样率为2至12整数")
	}
	preparationMu.Lock()
	preparation := preparations[s.dataDirectory]
	preparing := preparation != nil && (preparation.phase == "preparing" || preparation.phase == "cancelling" || preparation.phase == "committing")
	preparationMu.Unlock()
	if preparing {
		return &apiError{424, "视频深度模型及独立运行环境正在准备或收尾，请查询原准备状态", "MODEL_NOT_READY"}
	}
	receipt, _ := json.Marshal(object{"fingerprint": fingerprint, "input": input})
	if err = atomicWrite(receiptPath, receipt, true, 0600); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	task = &depthTask{input: asObject(clone(input)), fingerprint: fingerprint, state: "running", ctx: ctx, cancel: cancel, touched: time.Now()}
	depthTasks[id] = task
	go func() {
		result, err := s.analyzeDepth(ctx, input)
		depthMu.Lock()
		defer depthMu.Unlock()
		task.settled = true
		if err != nil {
			task.state = "failed"
			task.error = err.Error()
			task.errorCode = "REFERENCE_DEPTH_FAILED"
			if ctx.Err() != nil {
				task.state = "cancelled"
				task.errorCode = "CANCELLED"
			}
		} else {
			task.state = "succeeded"
			task.result = result
		}
		_ = s.persistDepthTerminal(task)
		cancel()
	}()
	success(w, s.depthResponse(task))
	return nil
}
func (s *server) checkDepthBinding(ctx context.Context, input object) error {
	directory := str(input["directory"])
	canvas, err := workspacePath(directory, str(input["canvasId"]), false)
	if err != nil {
		return err
	}
	info, err := os.Stat(canvas)
	if err != nil {
		return err
	}
	if info.Size() > 8*1024*1024 {
		return fail(413, "画布超过8MiB")
	}
	data, err := os.ReadFile(canvas)
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
	var target object
	nodes := map[string]object{}
	for _, raw := range array(document["nodes"]) {
		node := asObject(raw)
		nodes[str(node["id"])] = node
		if str(node["id"]) == str(input["nodeId"]) {
			target = node
		}
	}
	nodeType := strings.TrimPrefix(str(target["type"]), "remote-")
	if target == nil || (nodeType != "motionAnalysisNode" && nodeType != "videoDepthNode") || asObject(target["data"])["studioShotId"] != nil || document["toonflowStudio"] != nil {
		return stale("请选择未绑定 Studio 镜头的普通 Motion 或视频深度节点")
	}
	saved := asObject(asObject(target["data"])["analysisSettings"])
	expected := asObject(input["settings"])
	if (nodeType == "motionAnalysisNode" && !boolean(saved["depth"])) || !reflect.DeepEqual(object{"start": saved["start"], "end": saved["end"], "sampleFps": saved["sampleFps"]}, expected) {
		return stale("请先保存所选相对深度设置，冻结范围与画布不一致")
	}
	edges := []object{}
	for _, raw := range array(document["edges"]) {
		edge := asObject(raw)
		if str(edge["target"]) == str(target["id"]) && str(edge["targetHandle"]) == "input" {
			edges = append(edges, edge)
		}
	}
	if len(edges) != 1 {
		return fail(400, "相对深度需要且只接受一路已保存 RGB 视频")
	}
	source := nodes[str(edges[0]["source"])]
	output := asObject(asObject(asObject(source["data"])["outputs"])[str(edges[0]["sourceHandle"])])
	value := asObject(output["value"])
	if str(output["dataType"]) != "VIDEO" || str(value["url"]) != str(input["sourcePath"]) || value["controlType"] != nil || !strings.HasPrefix(str(value["mimeType"]), "video/") {
		return stale("冻结源视频与已保存画布 RGB 引用不一致")
	}
	sourcePath, err := workspacePath(directory, str(input["sourcePath"]), false)
	if err != nil {
		return err
	}
	digest, err := hashFile(ctx, sourcePath)
	if err != nil {
		return err
	}
	if digest != str(input["contentSha256"]) {
		return stale("源视频 SHA 与冻结请求不一致")
	}
	return nil
}
func (s *server) probeVideo(ctx context.Context, path string) (object, error) {
	executable, err := s.toolPath("ffprobe")
	if err != nil {
		return nil, err
	}
	out, err := exec.CommandContext(ctx, executable, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", "-protocol_whitelist", "file,pipe", path).Output()
	if err != nil {
		return nil, err
	}
	var data object
	if err = json.Unmarshal(out, &data); err != nil {
		return nil, err
	}
	for _, raw := range array(data["streams"]) {
		stream := asObject(raw)
		if str(stream["codec_type"]) != "video" {
			continue
		}
		frameRate := str(stream["avg_frame_rate"])
		pieces := strings.Split(frameRate, "/")
		fps := 0.0
		if len(pieces) == 2 {
			a, _ := strconv.ParseFloat(pieces[0], 64)
			b, _ := strconv.ParseFloat(pieces[1], 64)
			if b > 0 {
				fps = a / b
			}
		}
		duration, _ := strconv.ParseFloat(str(asObject(data["format"])["duration"]), 64)
		frameCount, _ := strconv.Atoi(str(stream["nb_frames"]))
		if number(stream["width"]) <= 0 || number(stream["width"]) > 16384 || number(stream["height"]) <= 0 || number(stream["height"]) > 16384 || fps <= 0 || math.IsNaN(fps) || math.IsInf(fps, 0) || duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
			return nil, fail(400, "视频须具备有效且有界的尺寸、帧率与时长")
		}
		return object{"width": stream["width"], "height": stream["height"], "fps": fps, "frameRate": frameRate, "duration": duration, "frameCount": frameCount, "codec": stream["codec_name"]}, nil
	}
	return nil, fail(400, "源文件没有视频流")
}
func artifactInfo(directory, path, mimeType string) (object, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 100*1024*1024 {
		return nil, fail(500, "相对深度产物不是有界普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	relative, _ := filepath.Rel(directory, path)
	return object{"path": filepath.ToSlash(relative), "mimeType": mimeType, "size": len(data), "sha256": hash(data)}, nil
}
func (s *server) analyzeDepth(ctx context.Context, input object) (object, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := s.checkDepthBinding(ctx, input); err != nil {
		return nil, err
	}
	directory := str(input["directory"])
	source, err := workspacePath(directory, str(input["sourcePath"]), false)
	if err != nil {
		return nil, err
	}
	outputRelative := "assets/" + str(input["nodeId"]) + "/motionDepth" + strings.ReplaceAll(str(input["operationId"]), "-", "")
	output, err := workspacePath(directory, outputRelative, true)
	if err != nil {
		return nil, err
	}
	s.roomsMu.Lock()
	for _, room := range s.rooms {
		if room.Directory == directory && !room.Closed {
			s.roomsMu.Unlock()
			return nil, fail(409, "相对深度分析暂不支持协作工程，请先关闭协作")
		}
	}
	release, err := s.lockFiles(source, output)
	s.roomsMu.Unlock()
	if err != nil {
		return nil, err
	}
	defer release()
	if _, err = os.Stat(output); !os.IsNotExist(err) {
		return nil, fail(409, "本操作产物目录已存在，不能重放覆盖，请保留操作ID并检查产物")
	}
	if err = os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		return nil, err
	}
	if err = os.Mkdir(output, 0700); err != nil {
		return nil, err
	}
	temporary, err := os.MkdirTemp(output, ".depthFrames")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temporary)
	modelPath, err := s.depthModelPath(ctx)
	if err != nil {
		return nil, err
	}
	python, device, err := s.depthRuntime(ctx)
	if err != nil {
		return nil, err
	}
	ffmpeg, err := s.toolPath("ffmpeg")
	if err != nil {
		return nil, err
	}
	sourceInfo, err := s.probeVideo(ctx, source)
	if err != nil {
		return nil, err
	}
	settings := asObject(input["settings"])
	start := number(settings["start"])
	duration := number(settings["end"]) - start
	fps := number(settings["sampleFps"])
	if number(settings["end"]) > number(sourceInfo["duration"])+.001 {
		return nil, fail(400, "冻结分析范围超过源片时长")
	}
	largest := math.Max(number(sourceInfo["width"]), number(sourceInfo["height"]))
	width := int(math.Max(48, math.Round(number(sourceInfo["width"])/largest*384/2)*2))
	height := int(math.Max(48, math.Round(number(sourceInfo["height"])/largest*384/2)*2))
	count := duration * fps
	if math.Abs(count-math.Round(count)) <= 1e-9 {
		count = math.Round(count)
	}
	frameCount := int(math.Max(1, math.Ceil(count)))
	options, _ := json.Marshal(object{"modelPath": modelPath, "sourceDirectory": filepath.Join(filepath.Dir(modelPath), "source"), "device": device, "width": width, "height": height, "fps": fps, "frameCount": frameCount})
	worker := exec.CommandContext(ctx, python, "-I", "-B", "-c", depthWorkerSource)
	worker.Dir = filepath.Dir(modelPath)
	worker.Env = append(os.Environ(), "OPEN_CINEMA_DEPTH_OPTIONS="+string(options))
	stdin, err := worker.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := worker.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var workerErrors bytes.Buffer
	worker.Stderr = &workerErrors
	if err = worker.Start(); err != nil {
		return nil, err
	}
	defer func() {
		if worker.ProcessState == nil {
			_ = worker.Process.Kill()
			_ = worker.Wait()
		}
	}()
	decoder := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file,pipe", "-ss", fmt.Sprint(start), "-t", fmt.Sprint(duration), "-i", source, "-vf", fmt.Sprintf("fps=%g:start_time=0:round=up:eof_action=pass,scale=%d:%d:flags=bilinear", fps, width, height), "-frames:v", fmt.Sprint(frameCount), "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1")
	decoder.Stdout = stdin
	var decodeErrors bytes.Buffer
	decoder.Stderr = &decodeErrors
	if err = decoder.Start(); err != nil {
		return nil, err
	}
	decoded := make(chan error, 1)
	go func() { err := decoder.Wait(); _ = stdin.Close(); decoded <- err }()
	decodeWaited := false
	defer func() {
		cancel()
		if !decodeWaited {
			<-decoded
		}
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 65536), 2*1024*1024)
	frames := []any{}
	runtimeInfo := object{"backend": "pytorch", "device": device, "relative": true, "preprocessing": "upstream-cubic252-multiple14-ImageNet", "normalization": "clip min/max", "temporal": true}
	for scanner.Scan() {
		var message object
		if err = json.Unmarshal(scanner.Bytes(), &message); err != nil {
			return nil, err
		}
		switch str(message["type"]) {
		case "ready":
			for _, key := range []string{"inputSize", "device", "torchVersion", "numpyVersion", "temporalWindow", "temporalOverlap"} {
				runtimeInfo[key] = message[key]
			}
		case "normalization":
			runtimeInfo["clipMin"] = message["min"]
			runtimeInfo["clipMax"] = message["max"]
		case "artifact":
			name := str(message["name"])
			if filepath.Base(name) != name || !strings.HasPrefix(name, "frame") || !strings.HasSuffix(name, ".png") {
				return nil, fail(500, "视频深度 Worker 产物协议无效")
			}
			data, err := base64.StdEncoding.DecodeString(str(message["data"]))
			if err != nil || len(data) > 1024*1024 {
				return nil, fail(500, "视频深度 Worker 帧产物无效")
			}
			if err = atomicWrite(filepath.Join(temporary, name), data, true, 0600); err != nil {
				return nil, err
			}
		case "frame":
			if int(number(message["index"])) != len(frames) {
				return nil, fail(500, "视频深度帧次序无效")
			}
			frames = append(frames, object{"time": message["time"], "min": message["min"], "max": message["max"], "mean": message["mean"]})
			runtimeInfo["inferenceMs"] = number(runtimeInfo["inferenceMs"]) + number(message["inferenceMs"])
			runtimeInfo["peakRss"] = math.Max(number(runtimeInfo["peakRss"]), number(message["peakRss"]))
		case "closed":
			runtimeInfo["frames"] = message["frames"]
		default:
			return nil, fail(500, "视频深度 Worker 响应类型无效")
		}
	}
	if err = scanner.Err(); err != nil {
		return nil, err
	}
	err = <-decoded
	decodeWaited = true
	if err != nil {
		return nil, fmt.Errorf("相对深度解码失败: %s", decodeErrors.String())
	}
	if err = worker.Wait(); err != nil {
		return nil, fmt.Errorf("Video Depth Anything 推理失败: %s", workerErrors.String())
	}
	if len(frames) != frameCount {
		return nil, fail(500, "相对深度输出帧不完整")
	}
	depth := object{"space": "relative", "frameCountPolicy": "halfOpenStableCeilV1", "fps": fps, "duration": duration, "width": sourceInfo["width"], "height": sourceInfo["height"], "frames": frames}
	dataPath := filepath.Join(output, "relativeDepth.json")
	data, _ := json.Marshal(object{"schemaVersion": 2, "referenceId": input["operationId"], "contentFingerprint": input["contentSha256"], "model": depthModel(), "range": object{"start": start, "end": settings["end"]}, "mapping": object{"sourceTimeOffset": start, "clipTimeScale": 1}, "depth": depth, "control": object{"width": width, "height": height, "normalizationMin": runtimeInfo["clipMin"], "normalizationMax": runtimeInfo["clipMax"]}, "normalization": depthNormalization})
	if err = atomicWrite(dataPath, data, true, 0600); err != nil {
		return nil, err
	}
	videoPath := filepath.Join(output, "relativeDepth.mp4")
	encode := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-framerate", fmt.Sprint(fps), "-i", filepath.Join(temporary, "frame%04d.png"), "-frames:v", fmt.Sprint(frameCount), "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "1", "-movflags", "+faststart", videoPath)
	if out, err := encode.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("相对深度控制视频编码失败: %s", out)
	}
	posterPath := filepath.Join(output, "relativeDepth.png")
	poster, err := os.ReadFile(filepath.Join(temporary, "frame0000.png"))
	if err != nil {
		return nil, err
	}
	if err = atomicWrite(posterPath, poster, true, 0600); err != nil {
		return nil, err
	}
	video, err := s.probeVideo(ctx, videoPath)
	if err != nil {
		return nil, err
	}
	if str(video["codec"]) != "h264" || int(number(video["frameCount"])) != frameCount || math.Abs(number(video["fps"])-fps) > .001 {
		return nil, fail(500, "相对深度控制视频的实际编码帧数或帧率不匹配")
	}
	if err = s.checkDepthBinding(ctx, input); err != nil {
		return nil, err
	}
	artifacts := []any{}
	for _, entry := range [][3]string{{"depthData", dataPath, "application/json"}, {"depthControl", videoPath, "video/mp4"}, {"depthPoster", posterPath, "image/png"}} {
		artifact, err := artifactInfo(directory, entry[1], entry[2])
		if err != nil {
			return nil, err
		}
		artifact["kind"] = entry[0]
		if entry[0] == "depthControl" {
			mappedEnd := math.Min(duration, number(video["duration"]))
			artifact["video"] = object{"width": video["width"], "height": video["height"], "fps": video["fps"], "frameRate": video["frameRate"], "frameCount": video["frameCount"], "duration": video["duration"], "sampleCount": len(frames), "validSourceDuration": duration, "mapping": object{"sourceTimeOffset": start, "clipTimeScale": 1, "sourceMappedVideoEnd": mappedEnd}, "lastFrameHold": object{"start": mappedEnd, "end": video["duration"], "seconds": math.Max(0, number(video["duration"])-duration), "note": "末帧保持到完整编码帧结束；实际帧数与帧率来自 FFprobe"}}
		}
		artifacts = append(artifacts, artifact)
	}
	result := object{"schemaVersion": 2, "frameCountPolicy": "halfOpenStableCeilV1", "operationId": input["operationId"], "canvasId": input["canvasId"], "nodeId": input["nodeId"], "source": object{"path": input["sourcePath"], "contentSha256": input["contentSha256"], "width": sourceInfo["width"], "height": sourceInfo["height"], "duration": sourceInfo["duration"], "fps": sourceInfo["fps"]}, "settings": settings, "model": depthModel(), "normalization": depthNormalization, "runtime": runtimeInfo, "artifacts": artifacts}
	manifestPath := filepath.Join(output, "manifest.json")
	manifest, _ := json.MarshalIndent(result, "", "  ")
	if err = atomicWrite(manifestPath, manifest, true, 0600); err != nil {
		return nil, err
	}
	result["manifest"], err = artifactInfo(directory, manifestPath, "application/json")
	return result, err
}
