package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

func (s *server) inspectLocalMediaConnection(w http.ResponseWriter, r *http.Request, input object) error {
	for key := range input {
		if key != "expectedRevision" && key != "offset" && key != "limit" && key != "inspectionRevision" {
			return fail(400, "未知本地连接检查字段")
		}
	}
	offset, limit := 0, 30
	for key, maximum := range map[string]float64{"offset": 100000, "limit": 100} {
		if raw, exists := input[key]; exists {
			value, ok := raw.(float64)
			if !ok || value < 0 || value > maximum || math.Trunc(value) != value || key == "limit" && value == 0 {
				return fail(400, "检查分页参数无效")
			}
			if key == "offset" {
				offset = int(value)
			} else {
				limit = int(value)
			}
		}
	}
	if raw, exists := input["inspectionRevision"]; exists {
		if value, valid := raw.(string); !valid || len(value) != 64 {
			return fail(400, "inspectionRevision 必须为已返回的摘要")
		}
	}
	if offset > 0 && str(input["inspectionRevision"]) == "" {
		return fail(400, "后续分页须携带 inspectionRevision，不能拼接不同检查结果")
	}
	state := localMediaConnectionState(s.settings())
	if err := requireLocalMediaRevision(input, state); err != nil {
		return err
	}
	config := asObject(state["config"])
	result := asObject(clone(state))
	for key, value := range (object{"status": "disabled", "reachable": false, "ready": false, "system": nil, "capabilities": []any{}, "modelCandidates": []any{}, "modelLoadState": "unknown", "generationVerified": false, "observedAt": time.Now().UTC().Format(time.RFC3339), "offset": offset, "total": 0, "hasMore": false, "nextOffset": nil, "inspectionRevision": hash([]byte(str(state["configRevision"]) + ":disabled"))}) {
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
				} else if err = localH3Discovery(result, nodes, offset, limit); err != nil {
					return err
				}
			}
		}
		if result["status"] == "unreachable" || result["status"] == "incompatible" {
			result["inspectionRevision"] = hash([]byte(str(state["configRevision"]) + ":" + str(result["status"]) + ":" + str(result["errorCode"])))
		}
	}
	if expected := str(input["inspectionRevision"]); expected != "" && expected != result["inspectionRevision"] {
		return stale("ComfyUI 节点或模型目录已变化，请从 offset 0 重新检查")
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

func localComfyChoices(nodes object, nodeName, field string) []string {
	input := asObject(asObject(nodes[nodeName])["input"])
	for _, group := range []string{"required", "optional"} {
		definition := array(asObject(input[group])[field])
		if len(definition) == 0 {
			continue
		}
		values := []string{}
		for _, value := range array(definition[0]) {
			if name, ok := value.(string); ok {
				values = append(values, name)
			}
		}
		return values
	}
	return []string{}
}

func localComfyHasInput(nodes object, nodeName, field string) bool {
	input := asObject(asObject(nodes[nodeName])["input"])
	for _, group := range []string{"required", "optional"} {
		if _, exists := asObject(input[group])[field]; exists {
			return true
		}
	}
	return false
}

func localH3Discovery(result, nodes object, offset, limit int) error {
	candidates := []any{}
	roles := map[string]bool{}
	for _, loader := range []struct{ node, field, role string }{{"UNETLoader", "unet_name", "diffusionModel"}, {"CLIPLoader", "clip_name", "textEncoder"}, {"VAELoader", "vae_name", "vae"}} {
		seen := map[string]bool{}
		for _, name := range localComfyChoices(nodes, loader.node, loader.field) {
			lower := strings.ToLower(name)
			if !strings.Contains(lower, "minimax") || !strings.Contains(lower, "h3") || seen[name] {
				continue
			}
			if len(name) > 2048 || strings.ContainsAny(name, "\x00\r\n") || len(candidates) >= 100000 {
				return fail(502, "ComfyUI 模型目录项过大或格式无效")
			}
			seen[name] = true
			role, mode := loader.role, ""
			switch role {
			case "diffusionModel":
				if strings.Contains(lower, "fl2va") || strings.Contains(lower, "fl2v_") {
					mode = "h3Fl2va"
				} else if strings.Contains(lower, "ref2va") || strings.Contains(lower, "ref2v_") {
					mode = "h3Ref2va"
				}
				if mode == "" || strings.Contains(lower, "turbo") || strings.Contains(lower, "lora") {
					continue
				}
			case "vae":
				if strings.Contains(lower, "video") {
					role = "videoVae"
				} else if strings.Contains(lower, "audio") {
					role = "audioVae"
				} else {
					continue
				}
			}
			item := object{"role": role, "name": name}
			roles[role+mode] = true
			if mode != "" {
				item["mode"] = mode
			}
			candidates = append(candidates, item)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := asObject(candidates[i]), asObject(candidates[j])
		return str(a["role"])+":"+str(a["name"]) < str(b["role"])+":"+str(b["name"])
	})
	common := []string{"UNETLoader", "CLIPLoader", "VAELoader", "BasicGuider", "RandomNoise", "KSamplerSelect", "BasicScheduler", "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo"}
	relevant := object{}
	capabilities := []any{}
	ready := false
	for _, mode := range []struct{ id, node string }{{"h3Fl2va", "MiniMaxH3ImageToVideo"}, {"h3Ref2va", "MiniMaxH3ReferenceToVideo"}} {
		required := append(append([]string{}, common...), mode.node)
		missing, missingRoles := []string{}, []string{}
		for _, name := range required {
			node, exists := nodes[name].(map[string]any)
			if !exists || len(node) == 0 {
				missing = append(missing, name)
			}
			relevant[name] = node
		}
		for _, role := range []string{"diffusionModel", "textEncoder", "videoVae", "audioVae"} {
			key := role
			if role == "diffusionModel" {
				key += mode.id
			}
			if !roles[key] {
				missingRoles = append(missingRoles, role)
			}
		}
		compatible := true
		for _, field := range []string{"clip", "vae", "prompt", "width", "height", "length"} {
			compatible = compatible && localComfyHasInput(nodes, mode.node, field)
		}
		minimaxClip := false
		for _, name := range localComfyChoices(nodes, "CLIPLoader", "type") {
			minimaxClip = minimaxClip || name == "minimax"
		}
		compatible = compatible && minimaxClip
		available := len(missing) == 0 && len(missingRoles) == 0 && compatible
		ready = ready || available
		capabilities = append(capabilities, object{"id": mode.id, "available": available, "requiredNodes": required, "missingNodes": missing, "missingModelRoles": missingRoles, "schemaCompatible": compatible, "workflowBound": false, "generationVerified": false})
	}
	encoded, _ := json.Marshal(object{"configRevision": result["configRevision"], "nodes": relevant, "modelCandidates": candidates})
	result["inspectionRevision"] = hash(encoded)
	result["capabilities"], result["ready"] = capabilities, ready
	result["status"] = "dependenciesMissing"
	if ready {
		result["status"] = "dependenciesAvailable"
	}
	result["message"] = "仅检查真实节点声明与模型文件目录；未加载权重、未绑定执行工作流或验证生成能力"
	if offset > len(candidates) {
		return fail(400, "offset 超出模型目录范围")
	}
	page, used := []any{}, 0
	for index := offset; index < len(candidates) && len(page) < limit; index++ {
		encoded, _ := json.Marshal(candidates[index])
		if used+len(encoded) > 40*1024 {
			break
		}
		used += len(encoded)
		page = append(page, candidates[index])
	}
	next := offset + len(page)
	result["modelCandidates"], result["total"], result["hasMore"] = page, len(candidates), next < len(candidates)
	if next < len(candidates) {
		result["nextOffset"] = next
	}
	return nil
}
