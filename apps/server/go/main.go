package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

type object = map[string]any
type apiError struct {
	status  int
	message string
	code    string
}

func (e *apiError) Error() string           { return e.message }
func fail(status int, message string) error { return &apiError{status, message, ""} }
func stale(message string) error            { return &apiError{409, message, "ESTALE"} }

type server struct {
	dataDirectory, webRoot string
	local                  bool
	configMu               sync.Mutex
	config                 object
	fileMu                 sync.Mutex
	busy                   map[string]bool
	controlMu              sync.Mutex
	connections            map[string]*controlConnection
	operationMu            sync.Mutex
	operations             map[string]*mcpOperation
	tasksMu                sync.Mutex
	tasks                  map[string]*mediaTask
	processesMu            sync.Mutex
	processes              map[string]*ffProcess
	roomsMu                sync.Mutex
	rooms                  map[string]*collaborationRoom
	widget                 *widgetRuntime
	appOrigin              string
	managed                *managedRuntime
	managedMode            bool
	referenceBindingsMu    sync.Mutex
	referenceBindingURLs   map[string]string
}

func main() {
	address := flag.String("listen", "127.0.0.1:47920", "HTTP listen address")
	data := flag.String("dataDirectory", "data", "Persistent configuration directory")
	web := flag.String("webRoot", "build/web", "React static output directory")
	local := flag.Bool("local", true, "Allow same-origin loopback clients to open local workspaces")
	widgetResource := flag.String("widgetResource", "", "Native MCP Widget resource catalog")
	runtimeInfo := flag.String("runtimeInfo", "", "Managed runtime information file")
	runtimeRevision := flag.String("runtimeRevision", "", "Managed runtime artifact revision")
	managed := flag.Bool("managed", false, "Exit after all runtime leases expire")
	flag.Parse()
	if err := runServer(*address, *data, *web, *local, *widgetResource, *runtimeInfo, *runtimeRevision, *managed); err != nil {
		log.Fatal(err)
	}
}
func runServer(address, data, web string, local bool, resource, info, revision string, managed bool) error {
	if managed && (info == "" || !moduleRevision.MatchString(revision)) {
		return fmt.Errorf("受管实例需要 runtimeInfo 和64位 runtimeRevision")
	}
	owner, err := acquireRuntime(data, info, revision)
	if err != nil {
		return err
	}
	defer owner.release()
	s, err := newServer(data, web, local)
	if err != nil {
		return err
	}
	s.managed, s.managedMode = owner, managed
	if managed && !boolean(asObject(s.settings()["mcp"])["enabled"]) {
		return fmt.Errorf("受管 MCP 实例的连接能力已被禁用，请使用启用 MCP 的独立数据目录")
	}
	if err = s.loadWidget(resource); err != nil {
		return err
	}
	listener, err := runtimeListener(address, managed)
	if err != nil {
		return err
	}
	defer listener.Close()
	s.appOrigin = "http://" + listener.Addr().String()
	srv := &http.Server{Handler: http.HandlerFunc(s.serve), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	owner.idleSince = time.Now()
	if err = s.publishRuntime(s.appOrigin); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	var once sync.Once
	shutdown := func() {
		once.Do(func() {
			s.closeWidgets()
			s.cancelAll()
			deadline, release := context.WithTimeout(context.Background(), 10*time.Second)
			defer release()
			if err := srv.Shutdown(deadline); err != nil {
				_ = srv.Close()
			}
			if err := s.waitRuntimeTasks(deadline); err != nil {
				owner.mu.Lock()
				owner.preserveLock = true
				owner.mu.Unlock()
				log.Print("后台任务未确认收尾，保留本实例锁和运行记录，禁止其他进程自动接管")
			}
		})
	}
	go func() { <-ctx.Done(); shutdown() }()
	go s.watchRuntime(ctx, shutdown)
	log.Printf("OpenCinema Go server: %s (data: %s)", s.appOrigin, s.dataDirectory)
	err = srv.Serve(listener)
	shutdown()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func newServer(data, web string, local bool) (*server, error) {
	data, err := filepath.Abs(data)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(data, 0700); err != nil {
		return nil, err
	}
	data, err = filepath.EvalSymlinks(data)
	if err != nil {
		return nil, err
	}
	web, _ = filepath.Abs(web)
	s := &server{dataDirectory: data, webRoot: web, local: local, config: object{}, busy: map[string]bool{}, connections: map[string]*controlConnection{}, tasks: map[string]*mediaTask{}, processes: map[string]*ffProcess{}, rooms: map[string]*collaborationRoom{}}
	bytes, err := os.ReadFile(filepath.Join(data, "settings.json"))
	if err == nil {
		if err = json.Unmarshal(bytes, &s.config); err != nil {
			return nil, fmt.Errorf("settings.json 无效，保留原文件: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	if _, ok := s.config["settings"]; !ok {
		s.config["settings"] = object{}
	}
	settings := asObject(s.config["settings"])
	mcp := asObject(settings["mcp"])
	if len(str(mcp["token"])) < 32 {
		mcp["token"] = randomID() + randomID()
	}
	if _, ok := mcp["enabled"]; !ok {
		mcp["enabled"] = true
	}
	settings["mcp"] = mcp
	if err = s.persistConfig(); err != nil {
		return nil, err
	}
	_ = os.MkdirAll(filepath.Join(data, "workspaces"), 0700)
	if err = s.loadRooms(); err != nil {
		return nil, err
	}
	if err = s.loadMcpOperations(); err != nil {
		return nil, err
	}
	return s, nil
}
func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func hash(bytes []byte) string { sum := sha256.Sum256(bytes); return hex.EncodeToString(sum[:]) }
func hashFile(ctx context.Context, path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !before.Mode().IsRegular() {
		return "", fail(400, "只能计算普通文件 SHA")
	}
	digest := sha256.New()
	buffer := make([]byte, 1024*1024)
	for {
		if err = ctx.Err(); err != nil {
			return "", err
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			_, _ = digest.Write(buffer[:n])
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}
	after, err := file.Stat()
	if err != nil {
		return "", err
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return "", stale("计算 SHA 期间文件已变化")
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
func asObject(v any) object {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return object{}
}
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	case int64:
		return float64(n)
	case uint64:
		return float64(n)
	case json.Number:
		value, _ := n.Float64()
		return value
	}
	return 0
}
func boolean(v any) bool { b, _ := v.(bool); return b }
func array(v any) []any  { a, _ := v.([]any); return a }
func clone(v any) any {
	b, _ := json.Marshal(v)
	var result any
	_ = json.Unmarshal(b, &result)
	return result
}

var secretField = regexp.MustCompile(`(?i)(api.?key|access.?token|refresh.?token|password|secret|authorization)$|^token$`)
var uuidValue = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func redactSecrets(value any) any {
	switch item := value.(type) {
	case map[string]any:
		result := object{}
		for key, child := range item {
			if key == "value" && secretField.MatchString(str(item["field"])) && child != nil && child != "" {
				result[key] = "[REDACTED]"
			} else if secretField.MatchString(key) && child != nil && child != "" {
				result[key] = "[REDACTED]"
			} else {
				result[key] = redactSecrets(child)
			}
		}
		return result
	case []any:
		result := make([]any, len(item))
		for i, child := range item {
			result[i] = redactSecrets(child)
		}
		return result
	default:
		return value
	}
}
func success(w http.ResponseWriter, v any) {
	respond(w, 200, object{"code": 200, "data": v, "message": "成功"})
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, err error) {
	status := 500
	code := ""
	var a *apiError
	if errors.As(err, &a) {
		status = a.status
		code = a.code
	} else if os.IsNotExist(err) {
		status = 404
		code = "ENOENT"
	} else if os.IsExist(err) {
		status = 409
		code = "EEXIST"
	} else if os.IsPermission(err) {
		status = 403
		code = "EACCES"
	}
	var data any
	var toolError *mcpCallError
	if errors.As(err, &toolError) {
		status = 400
		if toolError.details["code"] == "revisionConflict" {
			status = 409
		}
		code = str(toolError.details["code"])
		data = object{"code": code, "errorDetails": toolError.details}
	}
	if code != "" {
		if data == nil {
			data = object{"code": code}
		}
	}
	respond(w, status, object{"code": status, "data": data, "message": err.Error()})
}
func decode(r *http.Request) (object, error) {
	defer r.Body.Close()
	var v object
	limit := int64(100 * 1024 * 1024)
	if r.URL.Path == "/api/nodes/install" {
		limit = 128 * 1024 * 1024
	}
	if r.ContentLength > limit {
		return nil, fail(413, "请求正文超过大小限制")
	}
	reader := &io.LimitedReader{R: r.Body, N: limit + 1}
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(&v); err != nil {
		if reader.N <= 0 {
			return nil, fail(413, "请求正文超过大小限制")
		}
		return nil, fail(400, "JSON 参数无效")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if reader.N <= 0 {
			return nil, fail(413, "请求正文超过大小限制")
		}
		return nil, fail(400, "JSON 正文不能包含第二个值或额外内容")
	}
	if v == nil {
		return nil, fail(400, "参数必须是对象")
	}
	return v, nil
}
func (s *server) settings() object {
	s.configMu.Lock()
	defer s.configMu.Unlock()
	return asObject(clone(s.config["settings"]))
}
func (s *server) persistConfig() error {
	b, err := json.MarshalIndent(s.config, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.dataDirectory, "settings.json"), append(b, '\n'), false, 0600)
}
func (s *server) sameOrigin(r *http.Request) bool {
	source := r.Header.Get("Origin")
	if source == "" {
		source = r.Header.Get("Referer")
	}
	u, err := url.Parse(source)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host == r.Host
}
func (s *server) appRequest(r *http.Request) error {
	if !s.sameOrigin(r) || r.Header.Get("X-Toonflow-Workspace") != "1" {
		return fail(403, "只允许同源 OpenCinema 工作台访问")
	}
	return nil
}
func (s *server) localRequest(r *http.Request) bool {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	hostname := strings.Trim(strings.Split(r.Host, ":")[0], "[]")
	return s.local && net.ParseIP(host).IsLoopback() && (hostname == "localhost" || hostname == "127.0.0.1" || strings.HasPrefix(r.Host, "[::1]")) && s.appRequest(r) == nil && r.Header.Get("X-Toonflow-Local-Client") != "0"
}
func trustedLoopback(r *http.Request) bool {
	address, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(address)
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	host := r.Host
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
func (s *server) validBearer(r *http.Request) bool {
	token := str(asObject(s.settings()["mcp"])["token"])
	return len(token) >= 32 && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) == 1
}
func (s *server) authorizeMcp(r *http.Request) bool {
	mcp := asObject(s.settings()["mcp"])
	token := str(mcp["token"])
	actual := r.Header.Get("Authorization")
	if !boolean(mcp["enabled"]) || len(token) < 32 {
		return false
	}
	if r.Header.Get("Origin") != "" && !s.sameOrigin(r) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte("Bearer "+token)) == 1
}
func (s *server) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Header.Get("Origin") != "" && !s.sameOrigin(r) {
		failure(w, fail(403, "请求来源与服务地址不一致"))
		return
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.URL.Path == "/mcp" {
		s.mcp(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if !trustedLoopback(r) && !s.validBearer(r) {
			failure(w, fail(401, "远程 API 访问需要明确的 Bearer 授权"))
			return
		}
		if err := s.route(w, r); err != nil {
			failure(w, err)
		}
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		failure(w, fail(405, "HTTP 方法不支持"))
		return
	}
	target := filepath.Join(s.webRoot, filepath.FromSlash(filepath.Clean("/"+r.URL.Path)))
	if !within(s.webRoot, target) {
		failure(w, fail(403, "路径无效"))
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		if r.URL.Path == "/assets" || strings.HasPrefix(r.URL.Path, "/assets/") || filepath.Ext(r.URL.Path) != "" {
			http.NotFound(w, r)
			return
		}
		target = filepath.Join(s.webRoot, "index.html")
	}
	if filepath.Ext(target) == ".html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, target)
}
func (s *server) route(w http.ResponseWriter, r *http.Request) error {
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/api/workspaces/"):
		return s.workspaceRoute(w, r)
	case p == "/api/runtime/lease":
		return s.runtimeLease(w, r)
	case strings.HasPrefix(p, "/api/host/"):
		return s.hostRoute(w, r)
	case strings.HasPrefix(p, "/api/mcp/"):
		return s.controlRoute(w, r)
	case strings.HasPrefix(p, "/api/ffmpeg/"):
		return s.ffmpegRoute(w, r)
	case strings.HasPrefix(p, "/api/nodes/"):
		return s.nodesRoute(w, r)
	case strings.HasPrefix(p, "/api/ai/") || strings.HasPrefix(p, "/api/providers/"):
		return s.mediaRoute(w, r)
	case strings.HasPrefix(p, "/api/collaboration/"):
		return s.collaborationRoute(w, r)
	case strings.HasPrefix(p, "/api/media/localConnection/"):
		return s.localMediaConnectionRoute(w, r)
	case strings.HasPrefix(p, "/api/media/referenceDepth/"):
		return s.depthRoute(w, r)
	case strings.HasPrefix(p, "/api/assets/"):
		return s.assetsRoute(w, r)
	case p == "/api/settings/general":
		return s.generalConfiguration(w, r)
	case p == "/api/settings/get":
		if err := s.appRequest(r); err != nil {
			return err
		}
		settings := s.settings()
		if !s.localRequest(r) {
			settings = asObject(redactSecrets(settings))
		}
		success(w, settings)
		return nil
	case p == "/api/settings/save":
		if !s.localRequest(r) {
			return fail(403, "连接凭据和全局设置仅允许本机工作台修改")
		}
		if err := s.appRequest(r); err != nil {
			return err
		}
		if r.Method != "PUT" {
			return fail(405, "HTTP 方法不支持")
		}
		v, err := decode(r)
		if err != nil {
			return err
		}
		settings, ok := v["settings"].(map[string]any)
		if !ok {
			return fail(400, "settings 必须是对象")
		}
		s.configMu.Lock()
		previous := s.config["settings"]
		s.config["settings"] = settings
		err = s.persistConfig()
		if err != nil {
			s.config["settings"] = previous
		}
		s.configMu.Unlock()
		if err != nil {
			return err
		}
		success(w, object{"aiModels": []any{}})
		return nil
	case p == "/api/hello":
		success(w, object{"runtime": "go", "version": "0.3.0"})
		return nil
	}
	return fail(404, "接口不存在: "+p)
}
func (s *server) cancelAll() {
	s.cancelMcpOperations()
	s.processesMu.Lock()
	for _, process := range s.processes {
		process.cancel()
	}
	s.processesMu.Unlock()
	s.tasksMu.Lock()
	for _, task := range s.tasks {
		task.cancel()
	}
	s.tasksMu.Unlock()
	depthMu.Lock()
	for _, task := range depthTasks {
		if !task.settled {
			task.cancel()
		}
	}
	depthMu.Unlock()
	preparationMu.Lock()
	if task := preparations[s.dataDirectory]; task != nil && task.cancel != nil {
		task.cancel()
	}
	preparationMu.Unlock()
}
