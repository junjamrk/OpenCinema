package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// adapter 协议接声明式写不了的流程，例如请求签名。清单只选协议，从不声明命令，否则导入清单就等于远程执行：
// 可执行文件固定是数据目录下 providerAdapters/<供应商 ID>/adapter，只能由用户手动放置并设为可执行。
// 每个动作起一个进程，stdin 收一行 JSON，stdout 回一行 JSON；任务句柄只有远端 ID，服务重启后照常查询。
// 凭据只走 stdin，不进参数、环境变量或日志；stderr 直接丢弃，退出错误也不带它的内容。
// ACT: 超时只杀直接子进程，适配器自己派生的进程不受管；上限是脚本型适配器可能留下孙进程，升级方式是按平台建进程组。

var adapterTimeout = 2 * time.Minute

// 100MiB 产物编码成 data URI 后约 134MiB，上限按单个产物算。
var adapterOutputLimit = 140 * 1024 * 1024

// manifestCommandFields 不参与执行，出现就说明清单作者以为能声明命令，导入时明确拒绝。
var manifestCommandFields = []string{"adapter", "args", "command", "cwd", "env", "executable", "path", "program", "script", "shell"}

func validateAdapterProvider(provider object) error {
	for _, field := range manifestCommandFields {
		if provider[field] != nil {
			return fail(403, "清单不能声明命令或路径（"+field+"）；适配器只能手动放到数据目录的 providerAdapters/"+str(provider["id"])+"/adapter")
		}
	}
	if provider["transport"] != nil {
		return fail(400, "adapter 不走 HTTP，不声明 transport")
	}
	return nil
}

// adapterExecutable 解析真实路径后再比对边界，符号链接不能把执行点带出 providerAdapters/<ID>/。
func (s *server) adapterExecutable(provider object) (string, error) {
	id := str(provider["id"])
	if !providerID.MatchString(id) {
		return "", fail(400, "适配器 ID 无效")
	}
	name := "adapter"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	missing := fail(400, "请先把适配器放到数据目录的 providerAdapters/"+id+"/"+name+" 并设为可执行")
	root, err := filepath.EvalSymlinks(filepath.Join(s.dataDirectory, "providerAdapters"))
	if err != nil {
		return "", missing
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(root, id, name))
	if err != nil {
		return "", missing
	}
	if !within(filepath.Join(root, id), resolved) {
		return "", fail(403, "适配器不能指向 providerAdapters/"+id+" 之外")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", missing
	}
	// Windows 没有可执行位，只看 .exe 文件名。
	if runtime.GOOS != "windows" {
		if info.Mode().Perm()&0o111 == 0 {
			return "", missing
		}
		if info.Mode().Perm()&0o002 != 0 {
			return "", fail(403, "适配器不能是所有用户可写的文件")
		}
	}
	return resolved, nil
}

// 不能内嵌 bytes.Buffer：io.Copy 会直接走它的 ReadFrom，绕过这里的上限。
type adapterOutput struct{ data bytes.Buffer }

func (output *adapterOutput) Write(data []byte) (int, error) {
	if output.data.Len()+len(data) > adapterOutputLimit {
		return 0, fail(502, "适配器输出超过上限")
	}
	return output.data.Write(data)
}

func adapterMessage(provider, config object, message string) string {
	for _, raw := range array(provider["rules"]) {
		rule := asObject(raw)
		if value := str(config[str(rule["field"])]); value != "" && secretProviderRule(rule) {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	if len(message) > 2000 {
		message = strings.ToValidUTF8(message[:2000], "")
	}
	return message
}

func (s *server) runAdapter(ctx context.Context, provider, config, request object) (object, error) {
	executable, err := s.adapterExecutable(provider)
	if err != nil {
		return nil, err
	}
	request["config"] = config
	line, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	deadline, cancel := context.WithTimeout(ctx, adapterTimeout)
	defer cancel()
	command := exec.CommandContext(deadline, executable)
	command.Dir = filepath.Dir(executable)
	command.Stdin = bytes.NewReader(append(line, '\n'))
	output := &adapterOutput{}
	command.Stdout = output
	command.WaitDelay = 2 * time.Second
	if err = command.Start(); err != nil {
		return nil, fail(400, "适配器无法启动；未执行此动作")
	}
	err = command.Wait()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if deadline.Err() != nil {
		return nil, fail(502, "适配器超时；结果未确认，不会重新提交")
	}
	if err != nil {
		return nil, fail(502, "适配器异常退出或输出超限；结果未确认，不会重新提交")
	}
	var reply object
	if json.Unmarshal(bytes.TrimSpace(output.data.Bytes()), &reply) != nil || reply == nil {
		return nil, fail(502, "适配器须在 stdout 回一行 JSON 对象；结果未确认，不会重新提交")
	}
	return reply, nil
}

func (s *server) submitAdapter(ctx context.Context, provider, config, input, refs object) (object, object, error) {
	job := newRemoteJob(ctx, provider, config, input)
	if err := beginVideoSubmission(ctx, job); err != nil {
		return nil, nil, err
	}
	reply, err := s.runAdapter(ctx, provider, config, object{"action": "submit", "taskId": input["taskId"], "mediaType": input["mediaType"], "modelId": input["modelId"], "input": taskFields(input, refs)})
	if err != nil {
		return nil, nil, err
	}
	// submit 回 error 表示确认没有提交；拿不准时适配器应非零退出，任务会停在未确认。
	if message := str(reply["error"]); message != "" {
		return nil, nil, fail(400, "适配器拒绝请求："+adapterMessage(provider, config, message))
	}
	id, err := taskJobID(reply, "id")
	if err != nil {
		return nil, nil, err
	}
	job["id"] = id
	return job, nil, updateVideoJob(ctx, job)
}

func (s *server) adapterJob(ctx context.Context, action string, provider, config, input, job object) (object, error) {
	reply, err := s.runAdapter(ctx, provider, config, object{"action": action, "id": job["id"], "mediaType": input["mediaType"], "modelId": input["modelId"]})
	if err != nil {
		return nil, err
	}
	if message := str(reply["error"]); message != "" {
		return nil, fail(502, "适配器错误："+adapterMessage(provider, config, message))
	}
	return reply, nil
}

func (s *server) pollRemoteJob(ctx context.Context, provider, config, input, job object) (object, error) {
	if videoProtocol(provider) == "adapter" {
		return s.adapterJob(ctx, "status", provider, config, input, job)
	}
	return videoJSON(ctx, provider, config, http.MethodGet, str(job["statusPath"]), nil)
}

// 取消接口常回空正文，这里只看状态码；是否真的终止由取消后的状态查询确认。
func (s *server) cancelRemoteJob(ctx context.Context, provider, config, input, job object) error {
	if videoProtocol(provider) == "adapter" {
		_, err := s.adapterJob(ctx, "cancel", provider, config, input, job)
		return err
	}
	response, err := videoRequest(ctx, provider, config, str(job["cancelMethod"]), str(job["cancelPath"]), nil, "application/json")
	if err != nil {
		return err
	}
	return response.Body.Close()
}
