package main

import (
	"encoding/json"
	"net/http"
)

func ffmpegConfigurationState(settings object) object {
	config := asObject(settings["ffmpeg"])
	mode := str(config["mode"])
	if mode != "download" && mode != "system" {
		mode = "auto"
	}
	value := object{"mode": mode, "source": str(config["source"])}
	bytes, _ := json.Marshal(value)
	return object{"config": value, "configRevision": hash(bytes)}
}

func (s *server) ffmpegConfiguration(w http.ResponseWriter, r *http.Request) error {
	if !s.localRequest(r) {
		return fail(403, "FFmpeg 配置仅支持本机工作台")
	}
	if r.Method != "GET" && r.Method != "PUT" {
		return fail(405, "FFmpeg 配置只支持 GET 或 PUT")
	}
	input := object{}
	if r.Method == "PUT" {
		var err error
		input, err = decode(r)
		if err != nil {
			return err
		}
		for key := range input {
			if key != "changes" && key != "expectedRevision" {
				return fail(400, "未知 FFmpeg 配置字段")
			}
		}
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	settings := asObject(s.config["settings"])
	state := ffmpegConfigurationState(settings)
	if r.Method == "GET" {
		success(w, state)
		return nil
	}
	if str(input["expectedRevision"]) == "" {
		return toolFailure("revisionRequired", "FFmpeg 配置须携带 configRevision", "validation", "notDispatched", object{}, "readState")
	}
	if input["expectedRevision"] != state["configRevision"] {
		return stale("FFmpeg 配置已变化，请重新读取 configRevision；未执行保存")
	}
	changes, ok := input["changes"].(map[string]any)
	if !ok || len(changes) == 0 || len(changes) > 2 {
		return fail(400, "changes 须包含 mode 或 source")
	}
	next := asObject(clone(settings["ffmpeg"]))
	for field, value := range changes {
		text, valid := value.(string)
		if !valid {
			return fail(400, "FFmpeg 配置值必须为文本")
		}
		switch field {
		case "mode":
			if text != "auto" && text != "download" && text != "system" {
				return fail(400, "mode 必须为 auto、download 或 system")
			}
		case "source":
			var catalog object
			_ = json.Unmarshal(ffmpegCatalog, &catalog)
			found := false
			for _, raw := range array(catalog["downloadSources"]) {
				source := asObject(raw)
				if str(source["id"]) == text && boolean(source["available"]) {
					found = true
				}
			}
			if !found {
				return fail(400, "source 必须为可用的已核验下载源")
			}
		default:
			return fail(400, "未知 FFmpeg 配置字段")
		}
		next[field] = text
	}
	previous := settings["ffmpeg"]
	settings["ffmpeg"] = next
	s.config["settings"] = settings
	if err := s.persistConfig(); err != nil {
		if previous == nil {
			delete(settings, "ffmpeg")
		} else {
			settings["ffmpeg"] = previous
		}
		return err
	}
	success(w, ffmpegConfigurationState(settings))
	return nil
}
