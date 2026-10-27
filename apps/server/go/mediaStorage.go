package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Field order is part of the existing signer's SHA-bound identity contract.
type mediaStorageIdentity struct {
	ProjectID    string `json:"projectId"`
	NodeID       string `json:"nodeId"`
	Path         string `json:"path"`
	SHA256       string `json:"sha256"`
	Bytes        int    `json:"bytes"`
	MIMEType     string `json:"mimeType"`
	StorageType  string `json:"storageType,omitempty"`
	ObjectOrigin string `json:"objectOrigin"`
	ObjectKey    string `json:"objectKey"`
}

func mediaStorageClient() *http.Client {
	client := *safeClient()
	client.Timeout = 30 * time.Second
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("素材传输禁止重定向") }
	return &client
}

func mediaStorageSign(ctx context.Context, config, request object) (object, error) {
	endpoint, err := url.Parse(str(config["storageSignerUrl"]))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, fail(400, "素材签名服务须为已授权的HTTPS地址")
	}
	token := str(config["storageAccessToken"])
	if len(token) < 32 || len(token) > 256 || !regexp.MustCompile(`^[a-zA-Z0-9._~+/\-]+=*$`).MatchString(token) {
		return nil, fail(400, "素材签名服务的独立访问令牌未安全配置")
	}
	data, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(data))
	if err != nil {
		return nil, fail(400, "素材签名请求格式无效")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := mediaStorageClient().Do(req)
	if err != nil {
		return nil, fail(502, "素材签名服务连接未完成；未记录访问地址")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fail(502, fmt.Sprintf("素材签名服务HTTP %d；未读取可能含凭据的正文", response.StatusCode))
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil || len(data) > 32768 {
		return nil, fail(502, "素材签名响应超过限制或读取失败")
	}
	var value object
	if json.Unmarshal(data, &value) != nil || value == nil {
		return nil, fail(502, "素材签名响应格式无效")
	}
	return value, nil
}

func mediaStorageSignedURL(value string, identity mediaStorageIdentity, operation string, declared time.Time) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || len(value) > 8192 {
		return "", fail(502, "素材签名地址格式无效；地址未记录")
	}
	query, now := u.Query(), time.Now()
	for _, values := range query {
		if len(values) != 1 {
			return "", fail(502, "素材签名查询字段重复")
		}
	}
	if identity.StorageType == "vercelBlob" {
		allowed := map[string]bool{"vercel-blob-delegation": true, "vercel-blob-signature": true, "vercel-blob-valid-until": true}
		if operation == "put" {
			for _, key := range []string{"pathname", "vercel-blob-allowed-content-types", "vercel-blob-maximum-size-in-bytes", "vercel-blob-add-random-suffix", "vercel-blob-allow-overwrite"} {
				allowed[key] = true
			}
		} else {
			allowed["cache"] = true
		}
		for key := range query {
			if !allowed[key] {
				return "", fail(502, "Blob签名含未声明参数")
			}
		}
		parts := strings.Split(query.Get("vercel-blob-delegation"), ".")
		if len(parts) != 2 || !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(query.Get("vercel-blob-signature")) {
			return "", fail(502, "Blob委托签名格式无效")
		}
		data, err := base64.RawURLEncoding.DecodeString(parts[0])
		var scope object
		if err != nil || json.Unmarshal(data, &scope) != nil {
			return "", fail(502, "Blob委托范围格式无效")
		}
		store := strings.ToLower(strings.TrimPrefix(str(scope["storeId"]), "store_"))
		expires := number(scope["validUntil"])
		if value := query.Get("vercel-blob-valid-until"); value != "" {
			expires, err = strconv.ParseFloat(value, 64)
			if err != nil {
				return "", fail(502, "Blob签名期限格式无效")
			}
		}
		operations := array(scope["operations"])
		if "https://"+store+".private.blob.vercel-storage.com" != identity.ObjectOrigin || scope["pathname"] != identity.ObjectKey || len(operations) != 1 || operations[0] != operation || expires > number(scope["validUntil"]) || number(scope["validUntil"]) > float64(now.Add(7*24*time.Hour).UnixMilli()) || expires < float64(declared.Add(-time.Second).UnixMilli()) {
			return "", fail(502, "Blob委托的对象、操作或期限不符")
		}
		if operation == "put" {
			contentTypes := array(scope["allowedContentTypes"])
			if u.Host != "vercel.com" || u.Path != "/api/blob/" || query.Get("pathname") != identity.ObjectKey || len(contentTypes) != 1 || contentTypes[0] != identity.MIMEType || number(scope["maximumSizeInBytes"]) != float64(identity.Bytes) || query.Get("vercel-blob-allowed-content-types") != identity.MIMEType || query.Get("vercel-blob-maximum-size-in-bytes") != strconv.Itoa(identity.Bytes) || query.Get("vercel-blob-add-random-suffix") != "false" || query.Get("vercel-blob-allow-overwrite") != "false" {
				return "", fail(502, "Blob上传签名须固定当前素材类型、大小且禁止覆盖")
			}
		} else if u.Scheme+"://"+u.Host != identity.ObjectOrigin || strings.TrimPrefix(u.Path, "/") != identity.ObjectKey || query.Get("cache") != "0" {
			return "", fail(502, "Blob读取签名与当前私有对象不符")
		}
		return u.String(), nil
	}
	issued, err := time.Parse("20060102T150405Z", query.Get("X-Tos-Date"))
	seconds, secondsErr := strconv.Atoi(query.Get("X-Tos-Expires"))
	signedHeaders := "host"
	if operation == "put" {
		signedHeaders = "content-type;host;x-tos-meta-sha256"
	}
	if err != nil || secondsErr != nil || seconds < 1 || seconds > 604800 || issued.After(now.Add(time.Minute)) || issued.Add(time.Duration(seconds)*time.Second).Before(declared.Add(-time.Second)) || !regexp.MustCompile(`^[a-fA-F0-9]{64}$`).MatchString(query.Get("X-Tos-Signature")) || query.Get("X-Tos-SignedHeaders") != signedHeaders || u.Scheme+"://"+u.Host != identity.ObjectOrigin || strings.TrimPrefix(u.Path, "/") != identity.ObjectKey {
		return "", fail(502, "TOS签名的对象、请求头或期限无效")
	}
	return u.String(), nil
}

// Only the returned binding may be persisted. The URL is a temporary bearer
// credential for this one generation request and must stay in memory.
func publishMediaStorageReference(ctx context.Context, config object, projectID, nodeID, path string, data []byte, mimeType string, executionExpiresAfter int) (string, object, error) {
	kind, prefix := str(config["storageType"]), str(config["storagePrefix"])
	if kind != "tos" && kind != "vercelBlob" {
		return "", nil, fail(400, "请选择已授权的私有素材存储")
	}
	origin, err := url.Parse(str(config["storageObjectOrigin"]))
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return "", nil, fail(400, "私有素材原点格式无效")
	}
	objectOrigin := origin.Scheme + "://" + origin.Host
	if kind == "vercelBlob" && (origin.Port() != "" || !regexp.MustCompile(`^[a-z0-9]+\.private\.blob\.vercel-storage\.com$`).MatchString(origin.Host)) {
		return "", nil, fail(400, "Blob素材只允许私有存储原生域名")
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,150}/$`).MatchString(prefix) || strings.Contains(prefix, "//") {
		return "", nil, fail(400, "素材存储专用前缀无效")
	}
	for _, part := range strings.Split(prefix, "/") {
		if part == "." || part == ".." {
			return "", nil, fail(400, "素材存储前缀不能跨目录")
		}
	}
	extension := map[string]string{"video/mp4": ".mp4", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mimeType]
	if !uuidValue.MatchString(projectID) || len(nodeID) < 1 || len(nodeID) > 128 || len(path) < 1 || len(path) > 2048 || len(data) == 0 || len(data) > 100*1024*1024 || extension == "" {
		return "", nil, fail(400, "素材存储身份、类型或大小无效")
	}
	identity := mediaStorageIdentity{ProjectID: projectID, NodeID: nodeID, Path: path, SHA256: hash(data), Bytes: len(data), MIMEType: mimeType, ObjectOrigin: objectOrigin, ObjectKey: prefix + projectID + "/" + hash(data) + extension}
	if kind == "vercelBlob" {
		identity.StorageType = kind
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(identity); err != nil {
		return "", nil, err
	}
	bindingID := hash(bytes.TrimSuffix(encoded.Bytes(), []byte("\n")))
	if executionExpiresAfter < 3600 || executionExpiresAfter > 259200 {
		return "", nil, fail(400, "素材读取期限须绑定1至72小时的实际生成任务预算")
	}
	minimum := time.Now().Add(time.Duration(executionExpiresAfter+3900) * time.Second)
	request := object{"projectId": projectID, "nodeId": nodeID, "objectKey": identity.ObjectKey, "sha256": identity.SHA256, "bytes": len(data), "mimeType": mimeType, "minimumReadExpiresAt": minimum.UTC().Format(time.RFC3339Nano), "idempotencyKey": bindingID}
	request["action"] = "complete"
	grant, err := mediaStorageSign(ctx, config, request)
	if err != nil {
		return "", nil, err
	}
	if grant["state"] == "missing" && len(grant) == 1 {
		request["action"] = "prepare"
		grant, err = mediaStorageSign(ctx, config, request)
		if err != nil {
			return "", nil, err
		}
		uploadExpires, expiryErr := time.Parse(time.RFC3339Nano, str(grant["uploadExpiresAt"]))
		if expiryErr != nil || uploadExpires.Before(time.Now().Add(time.Minute)) || grant["method"] != "PUT" || grant["objectKey"] != identity.ObjectKey {
			return "", nil, fail(502, "素材上传授权的对象或剩余期限无效")
		}
		if err := mediaStorageCredentialExpiry(grant, uploadExpires); err != nil {
			return "", nil, err
		}
		uploadURL, err := mediaStorageSignedURL(str(grant["uploadUrl"]), identity, "put", uploadExpires)
		if err != nil {
			return "", nil, err
		}
		headers := asObject(grant["requiredHeaders"])
		expectedHeaders := 2
		if kind == "vercelBlob" {
			expectedHeaders = 1
		}
		if len(headers) != expectedHeaders || headers["content-type"] != mimeType || kind == "tos" && headers["x-tos-meta-sha256"] != identity.SHA256 {
			return "", nil, fail(502, "素材PUT须限定Content-Type与SHA，不能请求额外凭据")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, bytes.NewReader(data))
		if err != nil {
			return "", nil, fail(400, "素材PUT请求格式无效")
		}
		for key, value := range headers {
			req.Header.Set(key, str(value))
		}
		client := mediaStorageClient()
		client.Timeout = 15 * time.Minute
		response, err := client.Do(req)
		if err != nil {
			return "", nil, fail(502, "素材PUT结果未知；恢复时先核对同一SHA对象，不重复覆盖")
		}
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return "", nil, fail(502, fmt.Sprintf("素材PUT返回HTTP %d；恢复时先核对原对象", response.StatusCode))
		}
		request["action"] = "complete"
		grant, err = mediaStorageSign(ctx, config, request)
		if err != nil {
			return "", nil, err
		}
	}
	readExpires, err := time.Parse(time.RFC3339Nano, str(grant["readExpiresAt"]))
	if err != nil || readExpires.Before(minimum) || grant["verified"] != true || grant["objectKey"] != identity.ObjectKey || grant["sha256"] != identity.SHA256 || number(grant["bytes"]) != float64(len(data)) || grant["method"] != nil && grant["method"] != "GET" {
		return "", nil, fail(502, "素材读取绑定未验证SHA、大小、对象或任务期限；未提交生成")
	}
	if kind == "vercelBlob" && (grant["method"] != "GET" || grant["credentialExpiresAt"] != nil) {
		return "", nil, fail(502, "Blob读取须使用独立GET签名与固定委托期限")
	}
	if err := mediaStorageCredentialExpiry(grant, readExpires); err != nil {
		return "", nil, err
	}
	readURL, err := mediaStorageSignedURL(str(grant["readUrl"]), identity, "get", readExpires)
	if err != nil {
		return "", nil, err
	}
	binding := object{"bindingId": bindingID, "projectId": projectID, "nodeId": nodeID, "path": path, "sha256": identity.SHA256, "bytes": len(data), "mimeType": mimeType, "storageType": kind, "objectOrigin": objectOrigin, "objectKey": identity.ObjectKey, "readExpiresAt": readExpires.UTC().Format(time.RFC3339Nano)}
	return readURL, binding, nil
}

func mediaStorageCredentialExpiry(grant object, minimum time.Time) error {
	value, exists := grant["credentialExpiresAt"]
	if !exists {
		return fail(502, "素材签名未声明底层凭据期限")
	}
	if value != nil {
		expires, err := time.Parse(time.RFC3339Nano, str(value))
		if err != nil || expires.Before(minimum) || expires.After(time.Now().Add(12*time.Hour)) {
			return fail(502, "素材临时凭据期限不足或超过STS上限")
		}
	}
	for _, key := range []string{"uploadUrl", "readUrl"} {
		if u, err := url.Parse(str(grant[key])); err == nil && u.Query().Has("X-Tos-Security-Token") && value == nil {
			return fail(502, "STS签名必须声明实际凭据到期时间")
		}
	}
	return nil
}
