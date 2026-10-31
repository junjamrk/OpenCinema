package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"time"
)

type videoTaskKey struct{}
type videoTaskContext struct {
	server *server
	id     string
	task   *mediaTask
}

func videoConfigRevision(config object) string { data, _ := json.Marshal(config); return hash(data) }

func currentVideoJob(ctx context.Context) object {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil {
		return object{}
	}
	value.server.tasksMu.Lock()
	defer value.server.tasksMu.Unlock()
	return asObject(clone(value.task.job))
}

func beginVideoSubmission(ctx context.Context, job object) error {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil {
		return fail(400, "视频执行必须登记 taskId，不能使用无恢复凭据的同步提交")
	}
	value.server.tasksMu.Lock()
	defer value.server.tasksMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if value.task.cancelRequested {
		return fail(499, "视频生成提交前已取消；未派发生成")
	}
	value.task.job = asObject(clone(job))
	value.task.submitted.Store(true)
	return value.server.saveMediaTask(value.id, value.task, false)
}

func updateVideoJob(ctx context.Context, job object) error {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil {
		return fail(400, "视频任务上下文不存在")
	}
	value.server.tasksMu.Lock()
	defer value.server.tasksMu.Unlock()
	previous, _ := json.Marshal(value.task.job)
	next, _ := json.Marshal(job)
	if string(previous) == string(next) {
		return nil
	}
	value.task.job = asObject(clone(job))
	return value.server.saveMediaTask(value.id, value.task, false)
}

func settleVideoRemote(ctx context.Context, job object) error {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil {
		return fail(400, "视频任务上下文不存在")
	}
	value.server.tasksMu.Lock()
	defer value.server.tasksMu.Unlock()
	value.task.job, value.task.remoteSettled = asObject(clone(job)), true
	return value.server.saveMediaTask(value.id, value.task, false)
}

func (s *server) generateVideoProvider(ctx context.Context, provider, config, input, refs object) ([]string, error) {
	job := currentVideoJob(ctx)
	var response object
	if str(job["id"]) == "" {
		if job["protocol"] != nil {
			return nil, fail(409, "上次提交未收到远端任务 ID；不能自动重新生成")
		}
		if job["phase"] == "preparingReferences" && (job["providerRevision"] != provider["revision"] || job["configRevision"] != videoConfigRevision(config)) {
			return nil, fail(409, "参考素材准备时的供应商配置已变化；不能改用其他连接")
		}
		if videoProtocol(provider) == "ark" && len(array(refs["videos"])) > 0 {
			var err error
			refs, err = prepareArkVideoReferences(ctx, provider, config, input, refs)
			if err != nil {
				return nil, err
			}
		}
		var err error
		job, response, err = submitVideo(ctx, provider, config, input, refs)
		if err != nil {
			return nil, err
		}
	} else if job["providerRevision"] != provider["revision"] || job["configRevision"] != videoConfigRevision(config) {
		return nil, fail(409, "视频供应商配置或模型声明已变化；保留原任务，不能向其他连接恢复查询")
	}
	defer func() {
		if ctx.Err() == nil {
			return
		}
		value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
		if value == nil {
			return
		}
		s.tasksMu.Lock()
		requested := value.task.cancelRequested
		s.tasksMu.Unlock()
		if !requested || job["cancelMode"] != "request" {
			return
		}
		deadline, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := videoJSON(deadline, provider, config, str(job["cancelMethod"]), str(job["cancelPath"]), nil)
		if err != nil {
			return
		}
		result, err := videoJSON(deadline, provider, config, http.MethodGet, str(job["statusPath"]), nil)
		if err != nil {
			return
		}
		state := videoRemoteState(result)
		if state == "cancelled" || state == "failed" {
			job["status"] = state
			_ = settleVideoRemote(ctx, job)
		}
	}()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if response == nil {
			var err error
			response, err = videoJSON(ctx, provider, config, http.MethodGet, str(job["statusPath"]), nil)
			if err != nil {
				return nil, err
			}
		}
		state := videoRemoteState(response)
		job["status"] = state
		if progress, ok := response["progress"].(float64); ok && progress >= 0 && progress <= 100 {
			job["progress"] = progress
		}
		if err := updateVideoJob(ctx, job); err != nil {
			return nil, err
		}
		switch state {
		case "failed", "cancelled":
			if err := settleVideoRemote(ctx, job); err != nil {
				return nil, err
			}
			if state == "cancelled" {
				return nil, fail(499, "视频供应商已确认任务取消")
			}
			return nil, fail(502, "视频供应商已确认生成失败；保留远端任务 ID")
		case "completed":
			if err := settleVideoRemote(ctx, job); err != nil {
				return nil, err
			}
			protocol := videoProtocol(provider)
			if protocol == "openaiVideo" {
				result, err := videoRequest(ctx, provider, config, http.MethodGet, str(job["resultPath"]), nil, "")
				if err != nil {
					return nil, err
				}
				data, err := io.ReadAll(io.LimitReader(result.Body, 100*1024*1024+1))
				result.Body.Close()
				if err != nil {
					return nil, err
				}
				if len(data) == 0 || len(data) > 100*1024*1024 {
					return nil, fail(413, "视频结果为空或超过100MiB")
				}
				return []string{"data:video/mp4;base64," + base64.StdEncoding.EncodeToString(data)}, nil
			}
			if protocol == "fal" {
				var err error
				response, err = videoJSON(ctx, provider, config, http.MethodGet, str(job["resultPath"]), nil)
				if err != nil {
					return nil, err
				}
				if response["error"] != nil {
					return nil, fail(502, "fal 已完成任务但返回生成错误")
				}
			}
			urls := videoOutputURLs(response, protocol)
			if len(urls) == 0 {
				return nil, fail(502, "视频任务结束但未返回视频产物")
			}
			return urls, nil
		}
		response = nil
		if err := waitContext(ctx); err != nil {
			return nil, err
		}
	}
}

func (s *server) runMediaTask(ctx context.Context, id string, task *mediaTask) {
	ctx = context.WithValue(ctx, mediaSubmissionKey{}, &task.submitted)
	ctx = context.WithValue(ctx, videoTaskKey{}, &videoTaskContext{s, id, task})
	finishCost, err := s.beginMediaCost(ctx, id, task)
	var files []any
	if err == nil {
		files, err = s.generateMedia(ctx, task.directory, task.request)
	}
	finishCost(err == nil)
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	if err != nil {
		code := 500
		var api *apiError
		if errors.As(err, &api) {
			code = api.status
		} else if errors.Is(err, context.Canceled) {
			code = 499
		}
		var rejected *videoRequestRejected
		var network *net.OpError
		if str(task.job["id"]) == "" && (errors.As(err, &rejected) || errors.As(err, &network) && network.Op == "dial" || errors.As(err, &api) && (api.status == 400 || api.status == 403)) {
			task.submitted.Store(false)
		}
		task.unknown = task.submitted.Load() && !task.remoteSettled
		if task.unknown {
			code = 409
		}
		task.result = object{"code": code, "data": nil, "message": err.Error()}
	} else {
		task.unknown = false
		task.result = object{"code": 200, "data": files, "message": "成功"}
	}
	task.settled = time.Now()
	if err := s.saveMediaTask(id, task, false); err != nil {
		task.unknown = true
		task.result = object{"code": 500, "data": nil, "message": "任务结果记录保存失败；保留原ID及工程产物: " + err.Error()}
	}
	task.cancel()
	close(task.done)
}

// Called only under tasksMu and after workspace authorization. Generation POST
// is never replayed. An interrupted reference preparation can resume because
// beginVideoSubmission durably changes phase before any generation request.
func (s *server) resumeVideoTask(id string, task *mediaTask) error {
	// ComfyUI 已无记录时再查也不会变，继续恢复只会把未确认盖成运行中；取消时才重新核对。
	if task.job["status"] == "missing" && !task.cancelRequested {
		return nil
	}
	retryDownload := !task.settled.IsZero() && task.job["status"] == "completed" && number(task.result["code"]) != 200
	retryReferences := task.unknown && task.job["phase"] == "preparingReferences" && task.job["protocol"] == nil
	if retryReferences && task.cancelRequested && str(task.job["id"]) == "" {
		task.submitted.Store(false)
		task.unknown = false
		task.settled = time.Now()
		task.job["status"] = "cancelled"
		task.result = object{"code": 499, "data": nil, "message": "参考素材准备期间已取消；未提交视频生成"}
		if err := s.saveMediaTask(id, task, false); err != nil {
			task.unknown = true
			return err
		}
		return nil
	}
	if (!task.unknown && !retryDownload) || (str(task.job["id"]) == "" && !retryReferences) || task.request == nil {
		return nil
	}
	if retryReferences {
		task.submitted.Store(false)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	task.done, task.cancel, task.settled, task.result, task.unknown = make(chan struct{}), cancel, time.Time{}, nil, false
	task.touched = time.Now()
	go s.runMediaTask(ctx, id, task)
	return nil
}
