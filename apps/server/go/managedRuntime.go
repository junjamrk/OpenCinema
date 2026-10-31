package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type runtimeOwner struct {
	PID          int    `json:"pid"`
	InstanceID   string `json:"instanceId"`
	Revision     string `json:"revision"`
	RuntimeInfo  string `json:"runtimeInfo"`
	ProcessGuard bool   `json:"processGuard,omitempty"`
	Preserved    bool   `json:"preserved,omitempty"`
}
type managedRuntime struct {
	mu            sync.Mutex
	owner         runtimeOwner
	lockDirectory string
	guard         *os.File // 持有到进程退出；引用丢失后 GC 关闭文件会提前释放锁
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
	guard, err := lockRuntimeGuard(filepath.Join(root, ".runtimeGuard"))
	if err == nil {
		err = claimRuntimeLock(lock)
	}
	if err != nil {
		return nil, fmt.Errorf("运行目录已被占用或无法独占；不会抢占未知锁 %s: %w", lock, err)
	}
	runtime := &managedRuntime{owner: runtimeOwner{PID: os.Getpid(), InstanceID: sessionToken(), Revision: revision, RuntimeInfo: info, ProcessGuard: true}, lockDirectory: lock, guard: guard, leases: map[string]time.Time{}, idleSince: time.Now()}
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

// claimRuntimeLock 创建锁目录；目录已存在时只回收确认已退出的持有者留下的残锁。
// 调用方须已持有 runtimeGuard，否则并发启动的实例会互相删除刚建好的锁。
//
// ACT: 持有者是否存活由进程存活期间一直持有的 OS 锁判定，内核在任何退出方式下都会释放，
// 判定不看 PID，所以 PID 被复用不影响结果，也不需要比较受时钟、时区影响的进程启动时间。
// 上限：只证明 Go 主进程已退出，不证明它遗留的 ffmpeg、Python 子进程已结束；网络文件系统
// 不保证跨主机互斥，数据目录只支持单机使用；锁刚建好、owner.json 落盘前被杀会留下无法判定的空锁，
// 仍需人工处理。未声明 processGuard 的旧版锁只凭 PID 判定，PID 被复用时按存活拒绝。
func claimRuntimeLock(lock string) error {
	err := os.Mkdir(lock, 0700)
	if !os.IsExist(err) {
		return err
	}
	bytes, err := os.ReadFile(filepath.Join(lock, "owner.json"))
	if err != nil {
		return err
	}
	var owner runtimeOwner
	if err = json.Unmarshal(bytes, &owner); err != nil {
		return err
	}
	switch {
	case owner.Preserved:
		return errors.New("上次退出时后台任务未确认收尾，需人工确认后处理")
	case owner.PID <= 0:
		return errors.New("owner.json 无效")
	case !owner.ProcessGuard && !processGone(owner.PID):
		return fmt.Errorf("旧版实例进程 %d 仍存在或无法确认已退出", owner.PID)
	}
	removeRuntimeInfo(owner)
	if err = os.RemoveAll(lock); err != nil {
		return err
	}
	log.Printf("已回收崩溃实例遗留的运行锁: pid=%d", owner.PID)
	return os.Mkdir(lock, 0700)
}

// processGone 只在系统明确报告 PID 不存在时返回 true，权限不足等情况一律按存活处理。
func processGone(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return errors.Is(err, syscall.Errno(87)) // Windows ERROR_INVALID_PARAMETER：PID 不存在
	}
	defer process.Release()
	return errors.Is(process.Signal(syscall.Signal(0)), os.ErrProcessDone)
}
func removeRuntimeInfo(owner runtimeOwner) {
	if owner.RuntimeInfo == "" {
		return
	}
	bytes, err := os.ReadFile(owner.RuntimeInfo)
	var info object
	if err == nil && json.Unmarshal(bytes, &info) == nil && str(info["instanceId"]) == owner.InstanceID && int(number(info["pid"])) == owner.PID {
		_ = os.Remove(owner.RuntimeInfo)
	}
}
func (runtime *managedRuntime) release() {
	runtime.mu.Lock()
	preserve := runtime.preserveLock
	runtime.mu.Unlock()
	if preserve {
		// 进程退出后 guard 随之释放，须落盘标记，否则下次启动会按崩溃残锁回收。
		owner := runtime.owner
		owner.Preserved = true
		bytes, err := json.Marshal(owner)
		if err == nil {
			err = atomicWrite(filepath.Join(runtime.lockDirectory, "owner.json"), bytes, false, 0600)
		}
		if err != nil {
			log.Printf("无法标记保留的运行锁，下次启动可能按崩溃残锁回收: %v", err)
		}
		return
	}
	bytes, err := os.ReadFile(filepath.Join(runtime.lockDirectory, "owner.json"))
	var owner runtimeOwner
	if err != nil || json.Unmarshal(bytes, &owner) != nil || owner.PID != runtime.owner.PID || owner.InstanceID != runtime.owner.InstanceID {
		return
	}
	removeRuntimeInfo(runtime.owner)
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
