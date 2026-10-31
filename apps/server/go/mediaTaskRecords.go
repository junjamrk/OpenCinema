package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

func (s *server) saveMediaTask(id string, task *mediaTask, exclusive bool) error {
	root := filepath.Join(s.dataDirectory, "mediaTasks")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	input := object{"directory": task.directory, "inputHash": task.inputHash, "submitted": task.submitted.Load(), "unknown": task.unknown, "result": task.result, "settledAt": task.settled.UnixMilli(), "createdAt": task.touched.UnixMilli()}
	input["request"], input["job"], input["remoteSettled"], input["cancelRequested"], input["cost"] = task.request, task.job, task.remoteSettled, task.cancelRequested, task.cost
	if task.settled.IsZero() {
		input["settledAt"] = 0
	}
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(root, id+".json"), data, exclusive, 0600)
}
func (s *server) loadMediaTask(id string) error {
	if s.tasks[id] != nil {
		return nil
	}
	if !uuidValue.MatchString(id) {
		return fail(400, "taskId 必须为 UUID")
	}
	data, err := os.ReadFile(filepath.Join(s.dataDirectory, "mediaTasks", id+".json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var input object
	if err = json.Unmarshal(data, &input); err != nil || str(input["directory"]) == "" || str(input["inputHash"]) == "" {
		return fail(409, "任务记录损坏，禁止重放可能已经提交的生成请求")
	}
	task := &mediaTask{directory: str(input["directory"]), inputHash: str(input["inputHash"]), done: make(chan struct{}), cancel: func() {}, touched: time.Now(), result: asObject(input["result"])}
	task.request, task.job, task.remoteSettled, task.cancelRequested, task.cost = asObject(input["request"]), asObject(input["job"]), boolean(input["remoteSettled"]), boolean(input["cancelRequested"]), asObject(input["cost"])
	if number(input["settledAt"]) > 0 {
		task.settled = time.UnixMilli(int64(number(input["settledAt"])))
		task.submitted.Store(boolean(input["submitted"]))
		task.unknown = boolean(input["unknown"])
	} else {
		task.settled = time.Now()
		task.unknown = true
		task.submitted.Store(true)
		task.result = object{"code": 409, "data": nil, "message": "服务重启中断了任务观察，远端可能已执行；保留原任务ID，不能自动重新提交"}
	}
	close(task.done)
	s.tasks[id] = task
	return nil
}
