package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed ffmpegCatalog.json
var ffmpegCatalog []byte
var downloadMu sync.Mutex
var downloadState = object{"phase": "idle", "received": 0}
var downloadCancel context.CancelFunc

const mediaInputFormats = "mov,matroska,webm,avi,ogg,mpegts,mpeg,wav,aiff,au,caf,mp3,flac,aac,image2,image2pipe,png_pipe,jpeg_pipe,webp_pipe,gif,rawvideo,apng"

func platformTarget() string {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return platform + "-" + arch
}
func (s *server) toolPath(name string) (string, error) {
	settings := asObject(s.settings()["ffmpeg"])
	mode := str(settings["mode"])
	directory := filepath.Join(s.dataDirectory, "ffmpeg", platformTarget())
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	if mode != "system" {
		path := filepath.Join(directory, name+suffix)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, nil
		}
	}
	if mode != "download" {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", &apiError{424, "当前操作需要 FFmpeg，请安装系统 FFmpeg 或在设置中下载。", "FFMPEG_REQUIRED"}
}
func (s *server) ffmpegStatus() object {
	tools := object{}
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		path, err := s.toolPath(name)
		entry := object{"path": path, "error": nil, "source": "system"}
		if err != nil {
			entry["error"] = err.Error()
		}
		if strings.HasPrefix(path, s.dataDirectory) {
			entry["source"] = "download"
		}
		if path != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			output, e := exec.CommandContext(ctx, path, "-version").Output()
			cancel()
			if e == nil {
				entry["version"] = strings.SplitN(string(output), "\n", 2)[0]
			}
		}
		tools[name] = entry
	}
	var catalog object
	_ = json.Unmarshal(ffmpegCatalog, &catalog)
	build := asObject(asObject(catalog["builds"])[platformTarget()])
	downloadMu.Lock()
	progress := clone(downloadState)
	downloadMu.Unlock()
	return object{"platform": runtime.GOOS, "arch": runtime.GOARCH, "target": platformTarget(), "supported": len(build) > 0, "directory": filepath.Join(s.dataDirectory, "ffmpeg", platformTarget()), "version": build["version"], "sources": catalog["downloadSources"], "config": asObject(s.settings()["ffmpeg"]), "tools": tools, "download": progress}
}
func (s *server) ffmpegRoute(w http.ResponseWriter, r *http.Request) error {
	operation := strings.TrimPrefix(r.URL.Path, "/api/ffmpeg/")
	if operation == "events" {
		if !s.sameOrigin(r) {
			return fail(403, "页面来源无效")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, ok := w.(http.Flusher)
		if !ok {
			return fail(500, "流式响应不可用")
		}
		_, _ = io.WriteString(w, ": connected\n\n")
		flusher.Flush()
		timer := time.NewTicker(20 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-r.Context().Done():
				return nil
			case <-timer.C:
				_, err := io.WriteString(w, ": keepalive\n\n")
				if err != nil {
					return nil
				}
				flusher.Flush()
			}
		}
	}
	if err := s.appRequest(r); err != nil {
		return err
	}
	switch operation {
	case "configuration":
		return s.ffmpegConfiguration(w, r)
	case "status":
		success(w, s.ffmpegStatus())
		return nil
	case "progress":
		downloadMu.Lock()
		defer downloadMu.Unlock()
		success(w, downloadState)
		return nil
	case "cancel":
		downloadMu.Lock()
		if downloadCancel != nil {
			downloadCancel()
		}
		result := clone(downloadState)
		downloadMu.Unlock()
		success(w, result)
		return nil
	case "download":
		v, err := decode(r)
		if err != nil {
			return err
		}
		return s.downloadFfmpeg(w, str(v["source"]))
	case "execute":
		return s.executeFfmpeg(w, r)
	}
	return fail(404, "FFmpeg 接口不存在")
}
func (s *server) downloadFfmpeg(w http.ResponseWriter, source string) error {
	var catalog object
	_ = json.Unmarshal(ffmpegCatalog, &catalog)
	build := asObject(asObject(catalog["builds"])[platformTarget()])
	if len(build) == 0 {
		return fail(400, "此平台没有已核验 FFmpeg 构建")
	}
	prefix := ""
	for _, raw := range array(catalog["downloadSources"]) {
		item := asObject(raw)
		if str(item["id"]) == source && boolean(item["available"]) {
			prefix = str(item["urlPrefix"])
		}
	}
	if prefix == "" {
		return fail(400, "下载源不可用")
	}
	downloadMu.Lock()
	if downloadCancel != nil {
		downloadMu.Unlock()
		return fail(409, "正在下载，请等待完成或取消")
	}
	ctx, cancel := context.WithCancel(context.Background())
	downloadCancel = cancel
	downloadState = object{"phase": "downloading", "received": 0}
	downloadMu.Unlock()
	go func() {
		err := func() error {
			directory := filepath.Join(s.dataDirectory, "ffmpeg", platformTarget())
			if err := os.MkdirAll(directory, 0755); err != nil {
				return err
			}
			for _, name := range []string{"ffmpeg", "ffprobe"} {
				entry := asObject(build[name])
				request, err := http.NewRequestWithContext(ctx, "GET", prefix+str(entry["fileName"]), nil)
				if err != nil {
					return err
				}
				response, err := safeClient().Do(request)
				if err != nil {
					return err
				}
				if response.StatusCode != 200 {
					_ = response.Body.Close()
					return fmt.Errorf("FFmpeg 下载 HTTP %d", response.StatusCode)
				}
				data, err := io.ReadAll(io.LimitReader(response.Body, 150*1024*1024))
				_ = response.Body.Close()
				if err != nil {
					return err
				}
				if hash(data) != str(entry["sha256"]) {
					return fmt.Errorf("FFmpeg 下载完整性校验失败")
				}
				reader, err := gzip.NewReader(bytes.NewReader(data))
				if err != nil {
					return err
				}
				binary, err := io.ReadAll(io.LimitReader(reader, 300*1024*1024))
				_ = reader.Close()
				if err != nil {
					return err
				}
				if ctx.Err() != nil {
					return ctx.Err()
				}
				suffix := ""
				if runtime.GOOS == "windows" {
					suffix = ".exe"
				}
				if err = atomicWrite(filepath.Join(directory, name+suffix), binary, false, 0755); err != nil {
					return err
				}
				downloadMu.Lock()
				downloadState["received"] = len(data)
				downloadMu.Unlock()
			}
			return nil
		}()
		downloadMu.Lock()
		defer downloadMu.Unlock()
		downloadCancel = nil
		if err != nil {
			phase := "error"
			if ctx.Err() != nil {
				phase = "cancelled"
			}
			downloadState = object{"phase": phase, "received": 0, "error": err.Error()}
		} else {
			downloadState = object{"phase": "completed", "received": 0}
		}
		cancel()
	}()
	success(w, object{"phase": "downloading", "received": 0})
	return nil
}

type ffCall struct {
	Method        string `json:"method"`
	Args          []any  `json:"args"`
	UndefinedArgs []int  `json:"undefinedArgs"`
}
type ffProcess struct {
	cancel context.CancelFunc
	done   chan struct{}
}
type ffRequest struct {
	Directory string   `json:"directory"`
	RequestID string   `json:"requestId"`
	Options   object   `json:"options"`
	Calls     []ffCall `json:"calls"`
	Operation ffCall   `json:"operation"`
}

func values(args []any) []string {
	result := []string{}
	for _, arg := range args {
		if items, ok := arg.([]any); ok {
			result = append(result, values(items)...)
		} else {
			result = append(result, fmt.Sprint(arg))
		}
	}
	return result
}
func scalar(call ffCall) string {
	if len(call.Args) == 0 {
		return ""
	}
	return fmt.Sprint(call.Args[0])
}

var filterSource = regexp.MustCompile(`(?i)(?:^|[,;\[\]])\s*(?:a?movie|subtitles|ass|drawtext|sendcmd|asendcmd|zmq|azmq)\b`)
var allowedFilters = map[string]bool{"setpts": true, "asetpts": true, "scale": true, "format": true, "showinfo": true, "pad": true, "atempo": true, "volume": true, "atrim": true, "trim": true, "concat": true, "adelay": true, "amix": true, "aresample": true, "asplit": true, "split": true, "anull": true, "null": true, "fps": true, "setsar": true, "setdar": true, "hstack": true, "vstack": true, "xstack": true, "tile": true, "edgedetect": true, "eq": true, "sobel": true, "negate": true, "tblend": true, "blend": true, "boxblur": true, "gblur": true, "tpad": true, "apad": true, "transpose": true, "hflip": true, "vflip": true, "crop": true, "overlay": true, "color": true, "anullsrc": true, "sine": true, "fade": true, "afade": true, "acrossfade": true, "xfade": true, "lutrgb": true, "lutyuv": true, "lut": true, "geq": true, "hue": true, "colorchannelmixer": true, "colorspace": true, "zscale": true, "tonemap": true, "yadif": true, "bwdif": true, "deband": true, "unsharp": true, "hqdn3d": true, "dynaudnorm": true, "loudnorm": true, "aformat": true, "pan": true, "amerge": true, "asetrate": true, "astats": true, "silencedetect": true, "reverse": true, "areverse": true, "framestep": true, "select": true, "aselect": true, "thumbnail": true}

func validateFilters(text string) error {
	start := true
	quote := byte(0)
	parentheses := 0
	for i := 0; i < len(text); i++ {
		c := text[i]
		if start {
			if c == ' ' || c == '\t' || c == '\n' {
				continue
			}
			if c == '[' {
				end := strings.IndexByte(text[i:], ']')
				if end < 0 {
					return fail(400, "滤镜标签无效")
				}
				i += end
				continue
			}
			begin := i
			for i < len(text) && ((text[i] >= 'a' && text[i] <= 'z') || (text[i] >= 'A' && text[i] <= 'Z') || (text[i] >= '0' && text[i] <= '9') || text[i] == '_') {
				i++
			}
			if i == begin || !allowedFilters[text[begin:i]] {
				return fail(403, "FFmpeg 滤镜未授权，不能访问文件、网络或插件代码")
			}
			i--
			start = false
			continue
		}
		if c == '\\' {
			i++
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '(' {
			parentheses++
		} else if c == ')' && parentheses > 0 {
			parentheses--
		}
		if (c == ',' || c == ';') && parentheses == 0 {
			start = true
		}
	}
	if quote != 0 || parentheses != 0 {
		return fail(400, "滤镜表达式未闭合")
	}
	return nil
}

func filterString(args []any, complex bool) (string, error) {
	if len(args) == 0 {
		return "", fail(400, "滤镜参数缺失")
	}
	parts := []string{}
	var add func(any) error
	add = func(value any) error {
		switch v := value.(type) {
		case string:
			if filterSource.MatchString(v) {
				return fail(403, "文件型滤镜必须先通过工作区资源接口绑定")
			}
			if err := validateFilters(v); err != nil {
				return err
			}
			parts = append(parts, v)
		case []any:
			for _, item := range v {
				if err := add(item); err != nil {
					return err
				}
			}
		case map[string]any:
			prefix := ""
			for _, input := range values(array(v["inputs"])) {
				prefix += "[" + input + "]"
			}
			name := str(v["filter"])
			if name == "" {
				return fail(400, "滤镜名称无效")
			}
			options := ""
			if v["options"] != nil {
				if optionsMap, ok := v["options"].(map[string]any); ok {
					pairs := []string{}
					for key, value := range optionsMap {
						pairs = append(pairs, key+"="+fmt.Sprint(value))
					}
					options = strings.Join(pairs, ":")
				} else {
					options = strings.Join(values([]any{v["options"]}), ":")
				}
			}
			text := prefix + name
			if options != "" {
				text += "=" + options
			}
			for _, output := range values(array(v["outputs"])) {
				text += "[" + output + "]"
			}
			return add(text)
		default:
			return fail(400, "滤镜参数无效")
		}
		return nil
	}
	if err := add(args[0]); err != nil {
		return "", err
	}
	separator := ","
	if complex {
		separator = ";"
	}
	return strings.Join(parts, separator), nil
}

var allowedOptions = map[string]bool{"-framerate": true, "-start_number": true, "-stream_loop": true, "-loop": true, "-f": true, "-r": true, "-ss": true, "-t": true, "-to": true, "-map": true, "-map_metadata": true, "-map_chapters": true, "-q:v": true, "-q:a": true, "-pix_fmt": true, "-fps_mode": true, "-movflags": true, "-preset": true, "-crf": true, "-threads": true, "-filter_threads": true, "-filter_complex_threads": true, "-segment_time": true, "-segment_format": true, "-segment_time_delta": true, "-reset_timestamps": true, "-break_non_keyframes": true, "-force_key_frames": true, "-vsync": true, "-vcodec": true, "-acodec": true, "-c:v": true, "-c:a": true, "-b:v": true, "-b:a": true, "-ar": true, "-ac": true, "-an": true, "-vn": true, "-sn": true, "-dn": true, "-shortest": true, "-copyts": true, "-start_at_zero": true, "-avoid_negative_ts": true, "-max_muxing_queue_size": true, "-af": true, "-vf": true, "-filter_complex": true, "-frames:v": true, "-frames:a": true, "-s": true, "-aspect": true, "-y": true, "-n": true}

func init() {
	for _, name := range []string{"-loglevel", "-pixel_format", "-video_size", "-update", "-re"} {
		allowedOptions[name] = true
	}
}

func optionArgs(args []any) ([]string, error) {
	flat := values(args)
	result := []string{}
	for _, raw := range flat {
		parts := strings.Fields(raw)
		if strings.HasPrefix(raw, "-") && len(parts) > 1 {
			result = append(result, parts...)
		} else {
			result = append(result, raw)
		}
	}
	for _, value := range result {
		if strings.HasPrefix(value, "-") && !allowedOptions[value] {
			if _, err := strconv.ParseFloat(value, 64); err != nil {
				return nil, fail(403, "FFmpeg 参数未授权: "+value)
			}
		}
		if filterSource.MatchString(value) {
			return nil, fail(403, "滤镜不能直接打开磁盘文件")
		}
		if strings.Contains(value, "://") || strings.Contains(value, "../") || strings.HasPrefix(value, "/") {
			return nil, fail(403, "FFmpeg 选项不能传入文件或网络路径")
		}
	}
	for i, value := range result {
		if value == "-af" || value == "-vf" || value == "-filter_complex" {
			if i+1 >= len(result) {
				return nil, fail(400, "滤镜选项缺少内容")
			}
			if err := validateFilters(result[i+1]); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}
func (s *server) executeFfmpeg(w http.ResponseWriter, r *http.Request) error {
	var request ffRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2*1024*1024))
	if err := decoder.Decode(&request); err != nil {
		return fail(400, "FFmpeg 请求格式无效")
	}
	if len(request.RequestID) != 36 || len(request.Calls) > 2048 {
		return fail(400, "FFmpeg 请求标识或调用数量无效")
	}
	directory, err := s.workspace(r, request.Directory)
	if err != nil {
		return err
	}
	key := directory + "\x00" + request.RequestID
	operation := request.Operation.Method
	if operation == "cancel" {
		s.processesMu.Lock()
		process := s.processes[key]
		s.processesMu.Unlock()
		if process != nil {
			process.cancel()
			select {
			case <-process.done:
			case <-r.Context().Done():
				return r.Context().Err()
			}
		}
		success(w, nil)
		return nil
	}
	ffmpeg, err := s.toolPath("ffmpeg")
	if err != nil {
		return err
	}
	ffprobe, err := s.toolPath("ffprobe")
	if err != nil {
		return err
	}
	if operation == "prepare" {
		success(w, nil)
		return nil
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.processesMu.Lock()
	if s.processes[key] != nil {
		s.processesMu.Unlock()
		return fail(409, "FFmpeg 请求已在执行")
	}
	process := &ffProcess{cancel: cancel, done: make(chan struct{})}
	s.processes[key] = process
	s.processesMu.Unlock()
	defer func() { s.processesMu.Lock(); delete(s.processes, key); close(process.done); s.processesMu.Unlock() }()
	flusher, ok := w.(http.Flusher)
	if !ok {
		return fail(500, "HTTP 流式响应不可用")
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	flusher.Flush()
	var writeMu sync.Mutex
	emit := func(event string, args ...any) {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, _ := json.Marshal(object{"event": event, "args": args})
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}
	failEvent := func(err error) { emit("error", object{"name": "Error", "message": err.Error()}) }
	heartbeat := time.NewTicker(time.Second)
	defer heartbeat.Stop()
	heartbeatDone := make(chan struct{})
	defer close(heartbeatDone)
	go func() {
		for {
			select {
			case <-heartbeatDone:
				return
			case <-ctx.Done():
				return
			case <-heartbeat.C:
				writeMu.Lock()
				_, _ = io.WriteString(w, ": keepalive\n\n")
				flusher.Flush()
				writeMu.Unlock()
			}
		}
	}()
	args := []string{"-hide_banner", "-nostdin", "-protocol_whitelist", "file,pipe", "-format_whitelist", mediaInputFormats}
	inputs := []string{}
	outputs := []string{}
	pendingInput := []string{}
	if source := str(request.Options["source"]); source != "" {
		path, e := workspacePath(directory, source, false)
		if e != nil {
			failEvent(e)
			return nil
		}
		inputs = append(inputs, path)
	}
	addInput := func(path string) error {
		resolved, e := workspacePath(directory, path, false)
		if e != nil {
			return e
		}
		inputs = append(inputs, resolved)
		args = append(args, pendingInput...)
		pendingInput = nil
		args = append(args, "-i", resolved)
		return nil
	}
	addOutput := func(path string) error {
		resolved, e := workspacePath(directory, path, false)
		if e != nil {
			return e
		}
		if resolved == directory {
			return fail(400, "输出不能是工程根目录")
		}
		for _, input := range inputs {
			if resolved == input {
				return fail(409, "不能原地覆盖输入媒体")
			}
		}
		if _, e = os.Lstat(resolved); e == nil {
			return fail(409, "输出文件已存在，请使用新文件名")
		}
		outputs = append(outputs, resolved)
		args = append(args, resolved)
		return nil
	}
	if len(inputs) > 0 {
		args = append(args, "-i", inputs[0])
	}
	inputFlags := func(options ...string) {
		index := -1
		for i, arg := range args {
			if arg == "-i" {
				index = i
			}
		}
		if index >= 0 {
			args = append(args[:index], append(options, args[index:]...)...)
		} else {
			pendingInput = append(pendingInput, options...)
		}
	}
	mapping := map[string]string{"audioCodec": "-c:a", "audioBitrate": "-b:a", "audioChannels": "-ac", "audioFrequency": "-ar", "audioQuality": "-q:a", "videoCodec": "-c:v", "videoBitrate": "-b:v", "fps": "-r", "outputFps": "-r", "frames": "-frames:v", "duration": "-t", "seek": "-ss", "seekOutput": "-ss", "format": "-f", "outputFormat": "-f", "aspect": "-aspect", "aspectRatio": "-aspect", "size": "-s", "map": "-map"}
	aliases := map[string]string{"addInput": "input", "mergeAdd": "input", "addOutput": "output", "withNoAudio": "noAudio", "withNoVideo": "noVideo", "withAudioCodec": "audioCodec", "withAudioBitrate": "audioBitrate", "withAudioChannels": "audioChannels", "withAudioFrequency": "audioFrequency", "withAudioQuality": "audioQuality", "withVideoCodec": "videoCodec", "withVideoBitrate": "videoBitrate", "withFps": "fps", "withFPS": "fps", "FPS": "fps", "outputFPS": "outputFps", "withOutputFps": "outputFps", "withOutputFPS": "outputFps", "fpsOutput": "outputFps", "FPSOutput": "outputFps", "withFpsOutput": "outputFps", "withFPSOutput": "outputFps", "takeFrames": "frames", "withFrames": "frames", "withDuration": "duration", "setDuration": "duration", "toFormat": "format", "withOutputFormat": "format", "withSize": "size", "setSize": "size", "withAspect": "aspect", "withAspectRatio": "aspect", "setAspect": "aspect", "setAspectRatio": "aspect", "withAudioFilter": "audioFilters", "withAudioFilters": "audioFilters", "audioFilter": "audioFilters", "withVideoFilter": "videoFilters", "withVideoFilters": "videoFilters", "videoFilter": "videoFilters", "filterGraph": "complexFilter", "setStartTime": "seekInput"}
	for _, call := range request.Calls {
		method := call.Method
		if alias := aliases[method]; alias != "" {
			method = alias
		}
		var e error
		switch method {
		case "input":
			e = addInput(scalar(call))
		case "output":
			e = addOutput(scalar(call))
		case "noAudio":
			args = append(args, "-an")
		case "noVideo":
			args = append(args, "-vn")
		case "seekInput":
			pendingInput = append(pendingInput, "-ss", scalar(call))
			if len(inputs) > 0 {
				index := -1
				for i, a := range args {
					if a == "-i" {
						index = i
					}
				}
				if index >= 0 {
					args = append(args[:index], append([]string{"-ss", scalar(call)}, args[index:]...)...)
					pendingInput = nil
				}
			}
		case "inputFormat", "withInputFormat", "fromFormat":
			inputFlags("-f", scalar(call))
		case "inputFps", "inputFPS", "withInputFps", "withInputFPS", "fpsInput", "FPSInput", "withFpsInput", "withFPSInput":
			inputFlags("-r", scalar(call))
		case "nativeFramerate", "withNativeFramerate", "native":
			inputFlags("-re")
		case "loop":
			inputFlags("-loop", "1")
			if scalar(call) != "" {
				args = append(args, "-t", scalar(call))
			}
		case "audioFilters", "videoFilters", "complexFilter":
			var filter string
			filter, e = filterString(call.Args, method == "complexFilter")
			if e == nil {
				flag := "-vf"
				if method == "audioFilters" {
					flag = "-af"
				} else if method == "complexFilter" {
					flag = "-filter_complex"
				}
				args = append(args, flag, filter)
			}
		case "clone", "renice":
		case "keepPixelAspect", "keepDisplayAspect", "keepDisplayAspectRatio", "keepDAR":
			args = append(args, "-aspect", "1:1")
		case "autoPad", "autopad", "applyAutopadding", "applyAutoPadding", "applyAutopad", "applyAutoPad", "withAutopadding", "withAutoPadding", "withAutopad", "withAutoPad":
			args = append(args, "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2")
		default:
			if strings.HasSuffix(method, "Option") || strings.HasSuffix(method, "Options") {
				var options []string
				options, e = optionArgs(call.Args)
				if e == nil {
					if strings.Contains(strings.ToLower(method), "input") {
						if len(inputs) > 0 {
							index := -1
							for i, a := range args {
								if a == "-i" {
									index = i
								}
							}
							if index >= 0 {
								args = append(args[:index], append(options, args[index:]...)...)
							}
						} else {
							pendingInput = append(pendingInput, options...)
						}
					} else {
						args = append(args, options...)
					}
				}
			} else if flag := mapping[method]; flag != "" {
				value := scalar(call)
				if (method == "audioBitrate" || method == "videoBitrate") && !strings.HasSuffix(value, "k") && !strings.HasSuffix(value, "M") {
					value += "k"
				}
				args = append(args, flag, value)
			} else {
				e = fail(400, "FFmpeg 配置方法不可用: "+method)
			}
		}
		if e != nil {
			failEvent(e)
			return nil
		}
	}
	if strings.HasPrefix(operation, "getAvailable") {
		operation = "available" + strings.TrimPrefix(operation, "getAvailable")
	}
	if operation == "ffprobe" {
		if len(inputs) == 0 {
			failEvent(fail(400, "ffprobe 需要输入文件"))
			return nil
		}
		probeArgs := []string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", "-protocol_whitelist", "file,pipe", "-format_whitelist", mediaInputFormats, inputs[0]}
		out, e := exec.CommandContext(ctx, ffprobe, probeArgs...).CombinedOutput()
		if e != nil {
			message := strings.TrimSpace(string(out))
			if message == "" {
				message = e.Error()
			}
			failEvent(fail(400, "FFprobe 读取媒体失败: "+message))
			return nil
		}
		var data any
		if e = json.Unmarshal(out, &data); e != nil {
			failEvent(e)
			return nil
		}
		emit("result", data)
		return nil
	}
	if strings.HasPrefix(operation, "available") {
		flag := map[string]string{"availableFilters": "-filters", "availableCodecs": "-codecs", "availableEncoders": "-encoders", "availableFormats": "-formats"}[operation]
		if flag == "" {
			failEvent(fail(400, "查询方法不可用"))
			return nil
		}
		out, e := exec.CommandContext(ctx, ffmpeg, "-hide_banner", flag).Output()
		if e != nil {
			failEvent(e)
			return nil
		}
		entries := object{}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 2 {
				entries[fields[1]] = object{"description": strings.Join(fields[2:], " ")}
			}
		}
		emit("result", entries)
		return nil
	}
	if operation == "save" || operation == "saveToFile" {
		if err = addOutput(scalar(request.Operation)); err != nil {
			failEvent(err)
			return nil
		}
	} else if operation != "run" {
		failEvent(fail(400, "执行方法不可用: "+operation))
		return nil
	}
	if len(outputs) == 0 {
		failEvent(fail(400, "FFmpeg 输出文件缺失"))
		return nil
	}
	// Fluent 配置跟随当前 output；把后续选项放回该 output 文件之前。
	// ACT: 只接受已验证的输出路径，不能由原始 option 注入另一个输出。
	ordered := []string{}
	block := []string{}
	currentOutput := ""
	for _, arg := range args {
		isOutput := false
		for _, output := range outputs {
			if arg == output {
				isOutput = true
				break
			}
		}
		if isOutput {
			if currentOutput != "" {
				ordered = append(ordered, block...)
				ordered = append(ordered, currentOutput)
				block = nil
			}
			currentOutput = arg
		} else if currentOutput == "" {
			ordered = append(ordered, arg)
		} else {
			block = append(block, arg)
		}
	}
	ordered = append(ordered, block...)
	if currentOutput != "" {
		ordered = append(ordered, currentOutput)
	}
	args = ordered
	lockedPaths := append([]string{}, inputs...)
	for _, output := range outputs {
		lockedPaths = append(lockedPaths, filepath.Dir(output))
	}
	release, lockErr := s.lockFiles(lockedPaths...)
	if lockErr != nil {
		failEvent(lockErr)
		return nil
	}
	defer release()
	args = append([]string{"-n"}, args...)
	args = append(args, "-progress", "pipe:1")
	command := exec.CommandContext(ctx, ffmpeg, args...)
	command.Dir = directory
	stdout, e := command.StdoutPipe()
	if e != nil {
		failEvent(e)
		return nil
	}
	stderr, e := command.StderrPipe()
	if e != nil {
		failEvent(e)
		return nil
	}
	if timeout := number(request.Options["timeout"]); timeout > 0 {
		timer := time.AfterFunc(time.Duration(timeout)*time.Second, cancel)
		defer timer.Stop()
	}
	if e = command.Start(); e != nil {
		failEvent(e)
		return nil
	}
	emit("start", ffmpeg+" "+strings.Join(args, " "))
	var wait sync.WaitGroup
	var stderrText strings.Builder
	wait.Add(2)
	go func() {
		defer wait.Done()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 65536), 2*1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if stderrText.Len() < 4*1024*1024 {
				stderrText.WriteString(line + "\n")
			}
			emit("stderr", line)
		}
	}()
	go func() {
		defer wait.Done()
		scanner := bufio.NewScanner(stdout)
		progress := object{}
		for scanner.Scan() {
			parts := strings.SplitN(scanner.Text(), "=", 2)
			if len(parts) != 2 {
				continue
			}
			switch parts[0] {
			case "frame":
				n, _ := strconv.ParseFloat(parts[1], 64)
				progress["frames"] = n
			case "fps":
				n, _ := strconv.ParseFloat(parts[1], 64)
				progress["currentFps"] = n
			case "bitrate":
				progress["currentKbps"] = strings.TrimSuffix(parts[1], "kbits/s")
			case "total_size":
				n, _ := strconv.ParseFloat(parts[1], 64)
				progress["targetSize"] = n / 1024
			case "out_time":
				progress["timemark"] = parts[1]
			case "progress":
				emit("progress", clone(progress))
			}
		}
	}()
	wait.Wait()
	err = command.Wait()
	if err != nil {
		message := stderrText.String()
		if ctx.Err() != nil {
			message = "FFmpeg 已取消"
		}
		if message == "" {
			message = err.Error()
		}
		failEvent(fail(400, message))
	} else {
		emit("end", nil, stderrText.String())
	}
	return nil
}
func (s *server) gitClone(w http.ResponseWriter, r *http.Request, directory, target, source string) error {
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		return fail(409, "目标目录已存在")
	}
	cmd := exec.CommandContext(r.Context(), "git", "-c", "protocol.file.allow=never", "clone", "--", source, target)
	cmd.Dir = directory
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fail(502, "工程克隆失败: "+string(output))
	}
	success(w, object{"directory": target})
	return nil
}
