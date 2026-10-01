package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type runtimeOwner struct {
	PID         int    `json:"pid"`
	InstanceID  string `json:"instanceId"`
	Revision    string `json:"revision"`
	RuntimeInfo string `json:"runtimeInfo"`
}
type managedRuntime struct {
	mu            sync.Mutex
	owner         runtimeOwner
	lockDirectory string
	leases        map[string]time.Time
	idleSince     time.Time
	stopping      bool
	preserveLock  bool
}

func acquireRuntime(data, info, revision string) (*managedRuntime, error) {
	root, err := filepath.Abs(data)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	if info != "" {
		info, err = filepath.Abs(info)
		if err != nil {
			return nil, err
		}
	}
	lock := filepath.Join(root, ".runtimeLock")
	if err = os.Mkdir(lock, 0700); err != nil {
		return nil, fmt.Errorf("运行目录已被占用或无法独占；不会抢占未知锁 %s: %w", lock, err)
	}
	runtime := &managedRuntime{owner: runtimeOwner{os.Getpid(), sessionToken(), revision, info}, lockDirectory: lock, leases: map[string]time.Time{}, idleSince: time.Now()}
	bytes, err := json.Marshal(runtime.owner)
	if err == nil {
		err = atomicWrite(filepath.Join(lock, "owner.json"), bytes, true, 0600)
	}
	if err != nil {
		_ = os.Remove(lock)
		return nil, err
	}
	return runtime, nil
}
func (runtime *managedRuntime) release() {
	runtime.mu.Lock()
	preserve := runtime.preserveLock
	runtime.mu.Unlock()
	if preserve {
		return
	}
	bytes, err := os.ReadFile(filepath.Join(runtime.lockDirectory, "owner.json"))
	var owner runtimeOwner
	if err != nil || json.Unmarshal(bytes, &owner) != nil || owner.PID != runtime.owner.PID || owner.InstanceID != runtime.owner.InstanceID {
		return
	}
	if runtime.owner.RuntimeInfo != "" {
		bytes, err = os.ReadFile(runtime.owner.RuntimeInfo)
		var info object
		if err == nil && json.Unmarshal(bytes, &info) == nil && str(info["instanceId"]) == runtime.owner.InstanceID && int(number(info["pid"])) == runtime.owner.PID {
			_ = os.Remove(runtime.owner.RuntimeInfo)
		}
	}
	_ = os.Remove(filepath.Join(runtime.lockDirectory, "owner.json"))
	_ = os.Remove(runtime.lockDirectory)
}
func (s *server) publishRuntime(origin string) error {
	runtime := s.managed
	if runtime == nil || runtime.owner.RuntimeInfo == "" {
		return nil
	}
	path := runtime.owner.RuntimeInfo
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if _, err := os.Lstat(path); err == nil {
		return fmt.Errorf("运行信息已存在，拒绝覆盖未知实例: %s", path)
	} else if !os.IsNotExist(err) {
		return err
	}
	bytes, err := json.Marshal(object{"pid": runtime.owner.PID, "instanceId": runtime.owner.InstanceID, "url": origin + "/mcp", "revision": runtime.owner.Revision, "token": asObject(s.settings()["mcp"])["token"]})
	if err != nil {
		return err
	}
	return atomicWrite(path, bytes, true, 0600)
}
func (s *server) runtimeLease(w http.ResponseWriter, r *http.Request) error {
	if !trustedLoopback(r) || !s.validBearer(r) {
		return fail(401, "运行租约需要本机 Bearer 授权")
	}
	if s.managed == nil || !s.managedMode {
		return fail(404, "此服务不使用受管生命周期")
	}
	if r.Method != "POST" {
		return fail(405, "运行租约只接受 POST")
	}
	input, err := decode(r)
	if err != nil {
		return err
	}
	for key := range input {
		if key != "action" && key != "id" {
			return fail(400, "运行租约包含未知字段")
		}
	}
	action, id := str(input["action"]), str(input["id"])
	runtime := s.managed
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.stopping {
		return fail(409, "受管运行实例正在退出")
	}
	now := time.Now()
	for key, expiry := range runtime.leases {
		if !expiry.After(now) {
			delete(runtime.leases, key)
		}
	}
	switch action {
	case "attach":
		if id != "" {
			return fail(400, "attach 不接受旧租约ID")
		}
		if len(runtime.leases) >= 128 {
			return fail(429, "运行租约过多")
		}
		id = sessionToken()
	case "heartbeat":
		if _, exists := runtime.leases[id]; !exists {
			return fail(404, "运行租约已过期，请重新连接")
		}
	case "release":
		if id == "" || len(id) > 128 {
			return fail(400, "运行租约ID无效")
		}
		delete(runtime.leases, id)
		if len(runtime.leases) == 0 && runtime.idleSince.IsZero() {
			runtime.idleSince = now
		}
		success(w, object{"id": id, "expiresAt": now.UnixMilli()})
		return nil
	default:
		return fail(400, "运行租约 action 无效")
	}
	expiry := now.Add(60 * time.Second)
	runtime.leases[id] = expiry
	runtime.idleSince = time.Time{}
	success(w, object{"id": id, "expiresAt": expiry.UnixMilli()})
	return nil
}
func (s *server) watchRuntime(ctx context.Context, shutdown func()) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.cleanWidgetStreams()
			if !s.managedMode {
				continue
			}
			runtime := s.managed
			runtime.mu.Lock()
			for id, expiry := range runtime.leases {
				if !expiry.After(now) {
					delete(runtime.leases, id)
				}
			}
			if len(runtime.leases) == 0 && runtime.idleSince.IsZero() {
				runtime.idleSince = now
			}
			stop := len(runtime.leases) == 0 && now.Sub(runtime.idleSince) >= 30*time.Second
			if stop {
				runtime.stopping = true
			}
			runtime.mu.Unlock()
			if stop {
				shutdown()
				return
			}
		}
	}
}

func runtimeListener(address string, managed bool) (net.Listener, error) {
	if managed {
		address = "127.0.0.1:0"
	}
	return net.Listen("tcp", address)
}

func (s *server) waitRuntimeTasks(ctx context.Context) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		active := false
		s.operationMu.Lock()
		for _, operation := range s.operations {
			if operation.cancel != nil {
				active = true
			}
		}
		s.operationMu.Unlock()
		s.tasksMu.Lock()
		for _, task := range s.tasks {
			if task.settled.IsZero() {
				active = true
			}
		}
		s.tasksMu.Unlock()
		s.processesMu.Lock()
		active = active || len(s.processes) > 0
		s.processesMu.Unlock()
		depthMu.Lock()
		for _, task := range depthTasks {
			if !task.settled {
				active = true
			}
		}
		depthMu.Unlock()
		preparationMu.Lock()
		if task := preparations[s.dataDirectory]; task != nil && (task.phase == "preparing" || task.phase == "cancelling" || task.phase == "committing") {
			active = true
		}
		preparationMu.Unlock()
		if !active {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
