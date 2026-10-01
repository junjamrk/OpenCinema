package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func mediaReferenceBindingKey(directory, nodeID, path, digest string) string {
	data, _ := json.Marshal([]string{directory, nodeID, path, digest})
	return hash(data)
}

func (s *server) mediaReferenceBindingPath(key string) string {
	return filepath.Join(s.dataDirectory, "mediaReferenceBindings", key+".json")
}

func (s *server) readMediaReferenceBinding(key string) (object, error) {
	data, err := readBoundedFile(s.mediaReferenceBindingPath(key), 16384)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var value object
	if json.Unmarshal(data, &value) != nil || value["scopeKey"] != key || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(str(value["bindingId"])) {
		return nil, fail(409, "临时参考绑定记录无效，禁止回退到其他传输")
	}
	return value, nil
}

func mediaReferenceExpiry(value any) (time.Time, error) {
	deadline, err := time.Parse(time.RFC3339Nano, str(value))
	if err != nil || deadline.Before(time.Now().Add(10*time.Minute)) || deadline.After(time.Now().Add(7*24*time.Hour)) {
		return time.Time{}, fail(409, "临时参考链接须在提交时至少剩10分钟，最多7天；不保证覆盖完整排队预算")
	}
	return deadline, nil
}

func (s *server) mediaReferenceBindingsRoute(w http.ResponseWriter, r *http.Request) error {
	if err := s.appRequest(r); err != nil {
		return err
	}
	if !s.localRequest(r) {
		return fail(403, "临时参考链接只允许本机工作台登记")
	}
	if r.Method != "GET" && r.Method != "POST" {
		return fail(405, "临时参考绑定仅支持GET和POST")
	}
	input := object{}
	if r.Method == "GET" {
		for key, values := range r.URL.Query() {
			if len(values) != 1 {
				return fail(400, "临时参考查询字段重复")
			}
			input[key] = values[0]
		}
	} else {
		if r.ContentLength > 16384 {
			return fail(413, "临时参考登记超过16KiB")
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16384)
		var err error
		input, err = decode(r)
		if err != nil {
			return err
		}
	}
	allowed := map[string]bool{"directory": true, "canvasId": true, "nodeId": true, "path": true, "sha256": true}
	if r.Method == "POST" {
		for _, key := range []string{"readUrl", "readExpiresAt", "credentialExpiresAt", "operationId"} {
			allowed[key] = true
		}
	}
	for key := range input {
		if !allowed[key] {
			return fail(400, "临时参考登记含未知字段")
		}
	}
	directory, err := s.workspace(r, str(input["directory"]))
	if err != nil {
		return err
	}
	nodeID, path, digest := str(input["nodeId"]), str(input["path"]), str(input["sha256"])
	if !uuidValue.MatchString(nodeID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(digest) {
		return fail(400, "消费节点UUID或文件SHA256无效")
	}
	canvasPath, err := workspacePath(directory, str(input["canvasId"]), false)
	if err != nil {
		return err
	}
	canvasData, err := readBoundedFile(canvasPath, 32*1024*1024)
	if err != nil {
		return err
	}
	var canvas object
	if json.Unmarshal(canvasData, &canvas) != nil || canvas["toonflowCanvas"] == nil {
		return fail(400, "请先保存当前画布后登记临时参考")
	}
	consumerFound := false
	for _, raw := range array(canvas["nodes"]) {
		node := asObject(raw)
		if node["id"] != nodeID || node["type"] != "remote-videoGenerationNode" {
			continue
		}
		var model []string
		consumerFound = json.Unmarshal([]byte(str(asObject(node["data"])["model"])), &model) == nil && len(model) == 2 && model[0] == "ark"
	}
	if !consumerFound {
		return fail(409, "当前已保存画布中未找到使用方舟的消费视频生成节点")
	}
	file, err := workspacePath(directory, path, false)
	if err != nil {
		return err
	}
	localData, err := readBoundedFile(file, 100*1024*1024)
	if err != nil {
		return err
	}
	if len(localData) == 0 || hash(localData) != digest {
		return stale("本地参考视频SHA已变化，未登记外部链接")
	}
	key := mediaReferenceBindingKey(directory, nodeID, path, digest)
	if r.Method == "GET" {
		s.referenceBindingsMu.Lock()
		defer s.referenceBindingsMu.Unlock()
		binding, err := s.readMediaReferenceBinding(key)
		if err != nil {
			return err
		}
		if binding == nil {
			success(w, object{"configured": false, "status": "missing"})
			return nil
		}
		state := "ready"
		if _, err := mediaReferenceExpiry(binding["readExpiresAt"]); err != nil {
			state = "expired"
		} else if s.referenceBindingURLs[key] == "" {
			state = "needsRebind"
		}
		success(w, object{"configured": state == "ready", "status": state, "binding": binding})
		return nil
	}
	if !uuidValue.MatchString(str(input["operationId"])) {
		return fail(400, "登记临时参考需要稳定operationId UUID")
	}
	deadline, err := mediaReferenceExpiry(input["readExpiresAt"])
	if err != nil {
		return err
	}
	readURL, err := arkReferenceURL(str(input["readUrl"]))
	if err != nil || len(readURL) > 8192 {
		return fail(400, "临时参考必须是有效HTTPS读取地址")
	}
	u, _ := url.Parse(readURL)
	if u.Query().Has("X-Tos-Date") {
		identity := mediaStorageIdentity{ObjectOrigin: u.Scheme + "://" + u.Host, ObjectKey: strings.TrimPrefix(u.Path, "/")}
		if _, err := mediaStorageSignedURL(readURL, identity, "get", deadline); err != nil {
			return err
		}
	}
	credentialExpiry, exists := input["credentialExpiresAt"]
	if !exists {
		return fail(400, "请声明底层凭据期限；STS期限未知时显式传null，不能声称长期有效")
	}
	credentialExpiryKnown := !(u.Query().Has("X-Tos-Security-Token") && credentialExpiry == nil)
	if credentialExpiryKnown {
		if err := mediaStorageCredentialExpiry(object{"readUrl": readURL, "credentialExpiresAt": credentialExpiry}, deadline); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, readURL, nil)
	if err != nil {
		return fail(400, "临时参考读取请求格式无效")
	}
	client := mediaStorageClient()
	client.Timeout = 2 * time.Minute
	response, err := client.Do(req)
	if err != nil {
		return fail(502, "无法核对临时参考原始字节；地址未记录")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fail(502, fmt.Sprintf("临时参考读取HTTP %d；地址未记录", response.StatusCode))
	}
	remoteHash := sha256.New()
	remoteSize, err := io.Copy(remoteHash, io.LimitReader(response.Body, int64(len(localData))+1))
	if err != nil || remoteSize != int64(len(localData)) || hex.EncodeToString(remoteHash.Sum(nil)) != digest {
		return fail(409, "临时链接远端原始字节与当前工程视频SHA或大小不一致")
	}
	if current, err := hashFile(ctx, file); err != nil || current != digest {
		return stale("登记期间本地视频已变化，未保存绑定")
	}
	if _, err := mediaReferenceExpiry(deadline.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	urlHash := hash([]byte(readURL))
	bindingID := hash([]byte(key + urlHash + deadline.UTC().Format(time.RFC3339Nano)))
	binding := object{"bindingId": bindingID, "scopeKey": key, "operationId": input["operationId"], "directory": directory, "canvasId": input["canvasId"], "nodeId": nodeID, "path": path, "sha256": digest, "bytes": len(localData), "providerId": "ark", "readExpiresAt": deadline.UTC().Format(time.RFC3339Nano), "credentialExpiresAt": credentialExpiry, "credentialExpiryKnown": credentialExpiryKnown, "queueExpiryCovered": credentialExpiryKnown && deadline.After(time.Now().Add(70*time.Minute)), "urlHash": urlHash, "verified": true, "executionExpiresAfter": 3600}
	s.referenceBindingsMu.Lock()
	defer s.referenceBindingsMu.Unlock()
	operationPath := filepath.Join(s.dataDirectory, "mediaReferenceOperations", str(input["operationId"])+".json")
	operationData, _ := json.Marshal(object{"scopeKey": key, "canvasId": input["canvasId"], "readExpiresAt": deadline.UTC().Format(time.RFC3339Nano), "credentialExpiresAt": credentialExpiry, "urlHash": urlHash})
	requestHash := hash(operationData)
	if previous, err := readBoundedFile(operationPath, 1024); err == nil {
		var operation object
		if json.Unmarshal(previous, &operation) != nil || operation["requestHash"] != requestHash {
			return fail(409, "此operationId已用于不同临时参考请求，请保留原请求")
		}
	} else if os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(operationPath), 0700); err != nil {
			return err
		}
		operationData, _ := json.Marshal(object{"requestHash": requestHash, "scopeKey": key, "bindingId": bindingID})
		if err := atomicWrite(operationPath, operationData, true, 0600); err != nil {
			return err
		}
	} else {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.mediaReferenceBindingPath(key)), 0700); err != nil {
		return err
	}
	encoded, _ := json.Marshal(binding)
	if err := atomicWrite(s.mediaReferenceBindingPath(key), encoded, false, 0600); err != nil {
		return err
	}
	if s.referenceBindingURLs == nil {
		s.referenceBindingURLs = map[string]string{}
	}
	s.referenceBindingURLs[key] = readURL
	success(w, object{"configured": true, "status": "ready", "binding": binding})
	return nil
}

func resolveArkBoundVideoReference(ctx context.Context, input object, index int, digest string) (string, object, bool, error) {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil {
		return "", nil, false, fail(400, "临时视频参考必须绑定真实媒体任务上下文")
	}
	output := str(input["outputDirectory"])
	nodeID := strings.TrimPrefix(output, "assets/")
	if !uuidValue.MatchString(nodeID) || output != "assets/"+nodeID {
		return "", nil, false, nil
	}
	references := array(input["videos"])
	if index >= len(references) {
		return "", nil, false, fail(400, "临时参考索引与实际输入不一致")
	}
	path := str(asObject(references[index])["path"])
	key := mediaReferenceBindingKey(value.task.directory, nodeID, path, digest)
	s := value.server
	s.referenceBindingsMu.Lock()
	defer s.referenceBindingsMu.Unlock()
	binding, err := s.readMediaReferenceBinding(key)
	if err != nil || binding == nil {
		return "", nil, false, err
	}
	if binding["directory"] != value.task.directory || binding["nodeId"] != nodeID || binding["path"] != path || binding["sha256"] != digest || binding["providerId"] != "ark" || binding["verified"] != true {
		return "", nil, true, fail(409, "临时参考绑定身份与实际生成输入不符")
	}
	if _, err := mediaReferenceExpiry(binding["readExpiresAt"]); err != nil {
		return "", nil, true, err
	}
	readURL := s.referenceBindingURLs[key]
	if readURL == "" {
		return "", nil, true, fail(409, "服务重启已清除临时参考凭证，请重新登记同一视频；不会改用Files或重新提交已有任务")
	}
	return readURL, asObject(clone(binding)), true, nil
}
