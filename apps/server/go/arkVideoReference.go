package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Files API URLs contain temporary credentials. Keep them in this request only;
// the durable media job retains the official file id and content hash instead.
func arkReferenceURL(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return "", fail(502, "方舟参考文件未返回有效的 HTTPS 下载地址；未提交生成")
	}
	return u.String(), nil
}

func (s *server) validateArkReferenceVideos(ctx context.Context, directory string, input object) error {
	if len(array(input["videos"])) == 0 {
		return nil
	}
	totalDuration := 0.0
	for _, raw := range array(input["videos"]) {
		reference := asObject(raw)
		if reference["mimeType"] != "video/mp4" && reference["mimeType"] != "video/quicktime" {
			return fail(400, "Seedance 视频参考须为 MP4 或 MOV；未上传或生成")
		}
		path, err := workspacePath(directory, str(reference["path"]), false)
		if err != nil {
			return err
		}
		deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
		metadata, err := s.probeVideo(deadline, path)
		cancel()
		if err != nil {
			return fail(400, "Seedance 参考视频无法解码；未上传或生成")
		}
		width, height, duration := number(metadata["width"]), number(metadata["height"]), number(metadata["duration"])
		fps, codec := number(metadata["fps"]), str(metadata["codec"])
		if width < 300 || width > 6000 || height < 300 || height > 6000 || width/height < 0.4 || width/height > 2.5 || width*height < 407696 || width*height > 8295044 || fps < 24 || fps > 60 || duration < 2 || duration > 15 || (codec != "h264" && codec != "hevc") {
			return fail(400, "Seedance 2.0 视频参考需2–15秒、24–60fps、H.264/HEVC、边长300–6000px且像素407696–8295044；请先转换白模视频，未上传或生成")
		}
		totalDuration += duration
	}
	if totalDuration > 15.001 {
		return fail(400, "Seedance 2.0 参考视频总时长不能超过15秒；未上传或生成")
	}
	return nil
}

func prepareArkVideoReferences(ctx context.Context, provider, config, input, refs object) (object, error) {
	job := currentVideoJob(ctx)
	if job["phase"] == nil {
		job = object{"phase": "preparingReferences", "status": "preparingReferences", "providerId": provider["id"], "modelId": input["modelId"], "providerRevision": provider["revision"], "configRevision": videoConfigRevision(config)}
		if err := updateVideoJob(ctx, job); err != nil {
			return nil, err
		}
	}
	files := array(job["referenceFiles"])
	urls := []any{}
	bindings := []any{}
	var earliestExpiry time.Time
	for index, raw := range array(refs["videos"]) {
		parts := strings.SplitN(str(raw), ",", 2)
		if len(parts) != 2 || (parts[0] != "data:video/mp4;base64" && parts[0] != "data:video/quicktime;base64") {
			return nil, fail(400, "方舟参考视频数据格式无效；未提交生成")
		}
		data, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil || len(data) == 0 || len(data) > 100*1024*1024 {
			return nil, fail(413, "参考视频须为100MiB以内的有效文件；未提交生成")
		}
		digest, id := hash(data), ""
		boundURL, binding, found, err := resolveArkBoundVideoReference(ctx, input, index, digest)
		if err != nil {
			return nil, err
		}
		if found {
			urls = append(urls, boundURL)
			bindings = append(bindings, binding)
			deadline, _ := time.Parse(time.RFC3339Nano, str(binding["readExpiresAt"]))
			if earliestExpiry.IsZero() || deadline.Before(earliestExpiry) {
				earliestExpiry = deadline
			}
			continue
		}
		if index < len(files) {
			file := asObject(files[index])
			if file["sha256"] != digest {
				return nil, fail(409, "参考视频内容已变化；保留原任务，未提交生成")
			}
			id = str(file["id"])
		}
		if id == "" {
			var buffer bytes.Buffer
			writer := multipart.NewWriter(&buffer)
			if err = writer.WriteField("purpose", "user_data"); err != nil {
				return nil, err
			}
			if err = writer.WriteField("expire_at", strconv.FormatInt(time.Now().Add(24*time.Hour).Unix()+60, 10)); err != nil {
				return nil, err
			}
			name := "reference.mp4"
			if strings.Contains(parts[0], "quicktime") {
				name = "reference.mov"
			}
			part, err := writer.CreateFormFile("file", name)
			if err != nil {
				return nil, err
			}
			if _, err = part.Write(data); err != nil {
				return nil, err
			}
			if err = writer.Close(); err != nil {
				return nil, err
			}
			response, err := videoRequest(ctx, provider, config, http.MethodPost, "files", &buffer, writer.FormDataContentType())
			if err != nil {
				return nil, err
			}
			var file object
			err = json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(&file)
			response.Body.Close()
			if err != nil || !regexp.MustCompile("^file-[a-zA-Z0-9_-]{1,240}$").MatchString(str(file["id"])) {
				return nil, fail(502, "方舟上传未返回有效文件ID；未提交视频生成")
			}
			id = str(file["id"])
			for len(files) <= index {
				files = append(files, nil)
			}
			files[index] = object{"id": id, "sha256": digest, "sizeBytes": len(data)}
			job["referenceFiles"] = files
			if err = updateVideoJob(ctx, job); err != nil {
				return nil, err
			}
		}
		for {
			file, err := videoJSON(ctx, provider, config, http.MethodGet, "files/"+id, nil)
			if err != nil {
				return nil, err
			}
			if file["id"] != id {
				return nil, fail(502, "方舟参考文件ID不一致；未提交视频生成")
			}
			switch str(file["status"]) {
			case "active":
				if str(file["download_url"]) == "" {
					return nil, fail(422, "方舟 Files 已完成上传，但当前账号未返回 download_url；File ID 不能代替 Seedance 视频参考 URL。已保留文件ID，未提交视频生成")
				}
				value, err := arkReferenceURL(str(file["download_url"]))
				if err != nil {
					return nil, err
				}
				urls = append(urls, value)
			case "processing":
				if err := waitContext(ctx); err != nil {
					return nil, err
				}
				continue
			case "failed":
				return nil, fail(502, "方舟参考文件处理失败；保留文件ID，未提交视频生成")
			default:
				return nil, fail(502, "方舟参考文件状态未知；保留文件ID，未提交视频生成")
			}
			break
		}
	}
	prepared := object{}
	for key, value := range refs {
		prepared[key] = value
	}
	prepared["videos"] = urls
	if len(bindings) > 0 {
		job["referenceBindings"], job["executionExpiresAfter"] = bindings, 3600
		if err := updateVideoJob(ctx, job); err != nil {
			return nil, err
		}
		prepared["executionExpiresAfter"] = 3600
		prepared["referenceExpiresAt"] = earliestExpiry.UTC().Format(time.RFC3339Nano)
	}
	return prepared, nil
}
