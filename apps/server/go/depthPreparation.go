package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type depthPreparation struct {
	phase    string
	received int64
	total    int64
	error    string
	cancel   context.CancelFunc
}

var preparationMu sync.Mutex
var preparations = map[string]*depthPreparation{}

func depthDownloadSize() int64 {
	return int64(number(asObject(array(depthModel()["files"])[0])["size"]) + number(depthModel()["sourceArchiveSize"]))
}
func preparationSnapshot(record *depthPreparation) object {
	if record == nil {
		return object{"phase": "missing", "received": 0, "total": depthDownloadSize()}
	}
	result := object{"phase": record.phase, "received": record.received, "total": record.total}
	if record.error != "" {
		result["error"] = record.error
	}
	return result
}
func (s *server) prepareDepthModel(w http.ResponseWriter, r *http.Request, input object, cancelRequested bool) error {
	if _, err := s.authorizeDepth(r, str(input["directory"])); err != nil {
		return err
	}
	preparationMu.Lock()
	record := preparations[s.dataDirectory]
	if cancelRequested {
		if record != nil && record.cancel != nil && record.phase == "preparing" {
			record.phase = "cancelling"
			record.cancel()
		}
		snapshot := preparationSnapshot(record)
		preparationMu.Unlock()
		success(w, snapshot)
		return nil
	}
	if record != nil && (record.phase == "preparing" || record.phase == "cancelling" || record.phase == "committing") {
		snapshot := preparationSnapshot(record)
		preparationMu.Unlock()
		success(w, snapshot)
		return nil
	}
	preparationMu.Unlock()
	depthMu.Lock()
	for _, task := range depthTasks {
		if !task.settled {
			depthMu.Unlock()
			return fail(409, "请先等待或取消正在运行的视频深度任务，再准备模型")
		}
	}
	preparationMu.Lock()
	record = preparations[s.dataDirectory]
	if record != nil && (record.phase == "preparing" || record.phase == "cancelling" || record.phase == "committing") {
		snapshot := preparationSnapshot(record)
		preparationMu.Unlock()
		depthMu.Unlock()
		success(w, snapshot)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	record = &depthPreparation{phase: "preparing", total: depthDownloadSize(), cancel: cancel}
	preparations[s.dataDirectory] = record
	preparationMu.Unlock()
	depthMu.Unlock()
	go func() {
		err := s.downloadDepthModel(ctx, record)
		preparationMu.Lock()
		defer preparationMu.Unlock()
		record.cancel = nil
		if err != nil {
			record.error = err.Error()
			record.phase = "failed"
			if ctx.Err() != nil {
				record.phase = "cancelled"
			}
		} else {
			record.phase = "ready"
		}
		cancel()
	}()
	success(w, object{"phase": "preparing", "received": 0, "total": depthDownloadSize()})
	return nil
}
func downloadDepthAsset(ctx context.Context, url, target string, size int64, expectedHash string, record *depthPreparation) error {
	request, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	response, err := safeClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("固定视频深度资源下载 HTTP %d", response.StatusCode)
	}
	if response.ContentLength > size {
		return fail(413, "固定视频深度资源下载超过预期尺寸")
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	buffer := make([]byte, 256*1024)
	var received int64
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		n, readErr := response.Body.Read(buffer)
		if n > 0 {
			received += int64(n)
			if received > size {
				return fail(413, "固定视频深度资源下载超过预期尺寸")
			}
			if _, err = file.Write(buffer[:n]); err != nil {
				return err
			}
			_, _ = digest.Write(buffer[:n])
			preparationMu.Lock()
			record.received += int64(n)
			preparationMu.Unlock()
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if received != size || hex.EncodeToString(digest.Sum(nil)) != expectedHash {
		return fail(400, "固定视频深度资源大小或 SHA256 不匹配，保留原模型")
	}
	return file.Sync()
}
func extractDepthSource(ctx context.Context, archive, target string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	prefix := "Video-Depth-Anything-" + str(depthModel()["sourceRevision"]) + "/"
	expected := map[string]object{}
	for _, value := range array(depthModel()["files"]) {
		entry := asObject(value)
		if strings.HasPrefix(str(entry["name"]), "source/") {
			expected[prefix+strings.TrimPrefix(str(entry["name"]), "source/")] = entry
		}
	}
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		entry, wanted := expected[header.Name]
		if !wanted {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size != int64(number(entry["size"])) || header.Size > 1024*1024 {
			return fail(400, "视频深度固定源码归档无效")
		}
		data, err := io.ReadAll(io.LimitReader(reader, header.Size+1))
		if err != nil {
			return err
		}
		if int64(len(data)) != header.Size || hash(data) != str(entry["sha256"]) {
			return fail(400, "视频深度固定源码摘要无效")
		}
		path, err := workspacePath(target, str(entry["name"]), true)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = atomicWrite(path, data, true, 0600); err != nil {
			return err
		}
		delete(expected, header.Name)
	}
	if len(expected) != 0 {
		return fail(400, "视频深度固定源码归档不完整")
	}
	return nil
}
func depthPython(ctx context.Context) (string, error) {
	candidates := []string{"python3.12", "python3.11", "python3.10", "python3"}
	if value := os.Getenv("OPEN_CINEMA_DEPTH_PYTHON"); value != "" {
		if !filepath.IsAbs(value) {
			return "", fail(424, "OPEN_CINEMA_DEPTH_PYTHON 须为受信 Python 解释器绝对路径")
		}
		candidates = []string{value}
	}
	for _, candidate := range candidates {
		path, err := exec.LookPath(candidate)
		if err != nil {
			continue
		}
		if err = exec.CommandContext(ctx, path, "-I", "-c", "import sys; assert sys.version_info.major==3 and 10<=sys.version_info.minor<=12").Run(); err == nil {
			return path, nil
		}
	}
	return "", fail(424, "视频深度需要 Python 3.10–3.12；可通过 OPEN_CINEMA_DEPTH_PYTHON 指定绝对路径，再显式准备模型")
}
func (s *server) prepareDepthRuntime(ctx context.Context) error {
	python, err := depthPython(ctx)
	if err != nil {
		return err
	}
	root, err := workspacePath(s.dataDirectory, ".models/videoDepthRuntime", true)
	if err != nil {
		return err
	}
	managed := filepath.Join(root, "bin/python")
	if runtime.GOOS == "windows" {
		managed = filepath.Join(root, "Scripts/python.exe")
	}
	if _, err = os.Stat(managed); os.IsNotExist(err) {
		if out, err := exec.CommandContext(ctx, python, "-I", "-m", "venv", root).CombinedOutput(); err != nil {
			return fmt.Errorf("创建视频深度独立运行环境失败: %s", out)
		}
	}
	packages := []string{"torch==2.6.0", "torchvision==0.21.0", "numpy==1.26.4", "opencv-python-headless==4.11.0.86", "einops==0.8.1", "easydict==1.13", "tqdm==4.67.1"}
	args := append([]string{"-I", "-m", "pip", "--isolated", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:", "--index-url", "https://pypi.org/simple"}, packages...)
	if out, err := exec.CommandContext(ctx, managed, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("准备固定视频深度 PyTorch 依赖失败: %s", out)
	}
	if _, _, err = s.depthRuntime(ctx); err != nil {
		return err
	}
	manifest, _ := json.MarshalIndent(object{"python": managed, "packages": packages, "modelFingerprint": depthModel()["fingerprint"]}, "", "  ")
	return atomicWrite(filepath.Join(root, "manifest.json"), manifest, false, 0600)
}
func (s *server) downloadDepthModel(ctx context.Context, record *depthPreparation) error {
	if _, modelErr := s.depthModelPath(ctx); modelErr == nil {
		if _, _, runtimeErr := s.depthRuntime(ctx); runtimeErr == nil {
			preparationMu.Lock()
			record.received = record.total
			preparationMu.Unlock()
			return nil
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := depthPython(ctx); err != nil {
		return err
	}
	root, err := workspacePath(s.dataDirectory, ".models", true)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(root, ".videoDepthPrepare")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	model := depthModel()
	expected := asObject(array(model["files"])[0])
	archive := filepath.Join(staging, "source.tar.gz")
	archiveURL := "https://codeload.github.com/DepthAnything/Video-Depth-Anything/tar.gz/" + str(model["sourceRevision"])
	if err = downloadDepthAsset(ctx, archiveURL, archive, int64(number(model["sourceArchiveSize"])), str(model["sourceArchiveSha256"]), record); err != nil {
		return err
	}
	if err = extractDepthSource(ctx, archive, staging); err != nil {
		return err
	}
	url := "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/" + str(model["revision"]) + "/video_depth_anything_vits.pth"
	if err = downloadDepthAsset(ctx, url, filepath.Join(staging, str(expected["name"])), int64(number(expected["size"])), str(expected["sha256"]), record); err != nil {
		return err
	}
	if err = os.Remove(archive); err != nil {
		return err
	}
	if err = s.prepareDepthRuntime(ctx); err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(staging, "manifest.json"), append(append([]byte{}, depthModelBytes...), '\n'), true, 0600); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	preparationMu.Lock()
	record.phase = "committing"
	preparationMu.Unlock()
	target, err := workspacePath(s.dataDirectory, ".models/videoDepthAnythingSmall", true)
	if err != nil {
		return err
	}
	backup := target + ".previous"
	if _, statErr := os.Stat(target); statErr == nil {
		if _, backupErr := os.Stat(backup); !os.IsNotExist(backupErr) {
			return fail(409, "上次模型备份仍存在，保留新旧模型，请检查后重试")
		}
		if err = os.Rename(target, backup); err != nil {
			return err
		}
	}
	if err = os.Rename(staging, target); err != nil {
		if _, backupErr := os.Stat(backup); backupErr == nil {
			_ = os.Rename(backup, target)
		}
		return err
	}
	_ = os.RemoveAll(backup)
	if directory, err := os.Open(root); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
