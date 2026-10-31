package main

import (
	"context"
	"errors"
	"math"
	"net"
	"net/http"
	"sort"
	"time"
)

func (s *server) inspectLocalMediaConnection(w http.ResponseWriter, r *http.Request, input object) error {
	for key := range input {
		if key != "expectedRevision" {
			return fail(400, "未知本地连接检查字段")
		}
	}
	state := localMediaConnectionState(s.settings())
	if err := requireLocalMediaRevision(input, state); err != nil {
		return err
	}
	config := asObject(state["config"])
	result := asObject(clone(state))
	for key, value := range (object{"status": "disabled", "reachable": false, "ready": false, "system": nil, "workflows": []any{}, "observedAt": time.Now().UTC().Format(time.RFC3339)}) {
		result[key] = value
	}
	if boolean(config["enabled"]) {
		endpoint, err := localMediaEndpoint(str(config["endpoint"]))
		if err != nil {
			return err
		}
		if net.ParseIP(endpoint.Hostname()).IsLoopback() {
			result["executionLocation"] = "thisMachine"
		} else {
			result["executionLocation"] = "localNetwork"
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		client := localComfyClient(endpoint)
		defer client.CloseIdleConnections()
		stats, err := localComfyJSON(ctx, client, endpoint, "/system_stats", 1024*1024)
		if err != nil {
			result["status"], result["errorCode"], result["message"] = "unreachable", "connectionUnavailable", err.Error()
			var responseError *localComfyReadError
			if errors.As(err, &responseError) && responseError.reached {
				result["status"], result["reachable"], result["errorCode"] = "incompatible", true, "systemStatsUnavailable"
			}
		} else {
			result["reachable"] = true
			if _, ok := stats["system"].(map[string]any); !ok {
				result["status"], result["errorCode"], result["message"] = "incompatible", "invalidSystemStats", "system_stats 缺少 ComfyUI system 对象"
			} else {
				result["system"] = localComfySystem(stats)
				nodes, err := localComfyJSON(ctx, client, endpoint, "/object_info", 32*1024*1024)
				if err != nil {
					result["status"], result["errorCode"], result["message"] = "incompatible", "nodeDiscoveryUnavailable", err.Error()
				} else {
					s.inspectComfyWorkflows(result, nodes)
				}
			}
		}
	}
	if actual := localMediaConnectionState(s.settings()); actual["configRevision"] != state["configRevision"] {
		return stale("检查期间本地连接配置已变化；请重新读取配置后检查")
	}
	success(w, result)
	return nil
}

func localComfySystem(stats object) object {
	system := asObject(stats["system"])
	text := func(value any) string {
		valueText := str(value)
		if len(valueText) > 512 {
			return ""
		}
		return valueText
	}
	devices := []any{}
	for _, raw := range array(stats["devices"]) {
		if len(devices) >= 8 {
			break
		}
		device := asObject(raw)
		devices = append(devices, object{"name": text(device["name"]), "type": text(device["type"]), "vramTotalBytes": math.Max(0, number(device["vram_total"]))})
	}
	return object{"os": text(system["os"]), "comfyVersion": text(system["comfyui_version"]), "pythonVersion": text(system["python_version"]), "pytorchVersion": text(system["pytorch_version"]), "ramTotalBytes": math.Max(0, number(system["ram_total"])), "devices": devices}
}

func (s *server) inspectComfyWorkflows(result, nodes object) {
	workflows := []any{}
	ready := true
	for _, raw := range s.providers() {
		provider := asObject(raw)
		if str(provider["id"]) != "comfyui" {
			continue
		}
		for _, rawModel := range array(provider["models"]) {
			model := asObject(rawModel)
			missing := map[string]bool{}
			for _, node := range asObject(asObject(model["comfy"])["workflow"]) {
				if name := str(asObject(node)["class_type"]); nodes[name] == nil {
					missing[name] = true
				}
			}
			names := []string{}
			for name := range missing {
				names = append(names, name)
			}
			sort.Strings(names)
			ready = ready && len(names) == 0
			workflows = append(workflows, object{"modelId": model["id"], "label": model["label"], "type": model["type"], "missingNodes": names})
		}
	}
	result["workflows"], result["ready"] = workflows, ready
	result["status"] = "dependenciesMissing"
	if ready {
		result["status"] = "ready"
	}
	result["message"] = "只检查服务和工作流节点是否存在；模型文件和显存在提交时由 ComfyUI 校验"
}
