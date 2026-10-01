package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

//go:embed mediaSizeCatalog.json
var mediaSizeCatalog []byte
var pixelSize = regexp.MustCompile(`^(\d+)[xX*](\d+)$`)

func resolveProviderImageSize(model, size, ratio string) (string, error) {
	var catalog object
	_ = json.Unmarshal(mediaSizeCatalog, &catalog)
	lower := strings.ToLower(model)
	size = strings.TrimSpace(size)
	ratio = strings.TrimSpace(ratio)
	if strings.Contains(lower, "gpt-image") {
		gpt := asObject(catalog["gpt"])
		tier := strings.ToUpper(size)
		if _, ok := gpt[tier]; ok {
			if ratio == "" {
				ratio = "1:1"
			}
			result := str(asObject(gpt[tier])[ratio])
			if result == "" {
				return "", fail(400, "GPT Image 不支持所选比例")
			}
			return result, nil
		}
		if pixelSize.MatchString(size) {
			return strings.ReplaceAll(size, "*", "x"), nil
		}
		if ratio == "" {
			ratio = size
		}
		if ratio == "" {
			return "", nil
		}
		result := str(asObject(gpt["1K"])[ratio])
		if result == "" {
			return "", fail(400, "GPT Image 尺寸或画幅比例无效")
		}
		return result, nil
	}
	if strings.Contains(lower, "qwen-image-3") {
		if pixelSize.MatchString(size) {
			return strings.ReplaceAll(strings.ToLower(size), "x", "*"), nil
		}
		if ratio == "" {
			ratio = size
		}
		if ratio == "" {
			return "", nil
		}
		result := str(asObject(asObject(catalog["gpt"])["1K"])[ratio])
		if result == "" {
			return "", fail(400, "Qwen Image 尺寸或比例无效")
		}
		return strings.ReplaceAll(result, "x", "*"), nil
	}
	if strings.Contains(lower, "seedream") {
		for _, raw := range array(catalog["seedream"]) {
			table := asObject(raw)
			matched, _ := regexp.MatchString(str(table["pattern"]), lower)
			if !matched {
				continue
			}
			tiers := asObject(table["tiers"])
			tier := strings.ToUpper(size)
			if _, ok := tiers[tier]; !ok {
				tier = str(table["defaultTier"])
			}
			if pixels := pixelSize.FindStringSubmatch(size); len(pixels) == 3 {
				a, _ := strconv.ParseFloat(pixels[1], 64)
				b, _ := strconv.ParseFloat(pixels[2], 64)
				gap := math.Inf(1)
				for key, rawTier := range tiers {
					square := pixelSize.FindStringSubmatch(str(asObject(rawTier)["1:1"]))
					if len(square) == 3 {
						x, _ := strconv.ParseFloat(square[1], 64)
						y, _ := strconv.ParseFloat(square[2], 64)
						if current := math.Abs(x*y - a*b); current < gap {
							gap = current
							tier = key
						}
					}
				}
			}
			if ratio == "" {
				if size == "" {
					return "", nil
				}
				return size, nil
			}
			resolved := str(asObject(tiers[tier])[ratio])
			if resolved == "" {
				return "", fail(400, "Seedream 不支持所选画幅比例")
			}
			return resolved, nil
		}
	}
	return size, nil
}
func generateGptImage(ctx context.Context, base string, config, v, refs object) ([]string, error) {
	images := array(refs["images"])
	if len(images) > 1 {
		return nil, fail(400, "GPT Image 目前只接受1张参考图")
	}
	size, err := resolveProviderImageSize(str(v["modelId"]), str(v["size"]), str(v["ratio"]))
	if err != nil {
		return nil, err
	}
	fields := object{"model": v["modelId"], "prompt": v["prompt"], "quality": "medium", "output_format": "png"}
	if size != "" {
		fields["size"] = size
	}
	if len(images) == 0 {
		result, err := providerJSON(ctx, base, "v1/images/generations", config, fields)
		if err != nil {
			return nil, err
		}
		return imageResultURLs(result), nil
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	dataURL := str(images[0])
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 {
		return nil, fail(400, "GPT Image 参考数据无效")
	}
	data, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	part, err := writer.CreateFormFile("image", "reference.png")
	if err != nil {
		return nil, err
	}
	if _, err = part.Write(data); err != nil {
		return nil, err
	}
	for key, value := range fields {
		if err = writer.WriteField(key, fmt.Sprint(value)); err != nil {
			return nil, err
		}
	}
	if err = writer.Close(); err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(base, "/") + "/v1/images/edits"
	request, err := http.NewRequestWithContext(ctx, "POST", endpoint, &body)
	if err != nil {
		return nil, err
	}
	key := str(config["apiKey"])
	if strings.TrimSpace(key) == "" {
		return nil, fail(400, "请先配置供应商 API Key")
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	markMediaSubmitted(ctx)
	response, err := safeClient().Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fail(502, fmt.Sprintf("GPT Image 编辑 HTTP %d", response.StatusCode))
	}
	var result object
	if err = json.NewDecoder(io.LimitReader(response.Body, 100*1024*1024)).Decode(&result); err != nil {
		return nil, err
	}
	return imageResultURLs(result), nil
}
func imageResultURLs(result object) []string {
	urls := extractURLs(result)
	for _, raw := range array(result["data"]) {
		if data := str(asObject(raw)["b64_json"]); data != "" {
			urls = append(urls, "data:image/png;base64,"+data)
		}
	}
	return urls
}
func reviewApiMartImages(ctx context.Context, base string, config object, images []any) ([]any, error) {
	assets := []any{}
	for i, image := range images {
		assets = append(assets, object{"url": image, "name": fmt.Sprintf("reference%d", i)})
	}
	submitted, err := providerJSON(ctx, base, "seedance2/private-avatar", config, object{"assets": assets})
	if err != nil {
		return nil, err
	}
	id := str(asObject(submitted["data"])["id"])
	if id == "" {
		return nil, fail(502, "APIMart 参考素材审核未返回任务 ID")
	}
	for {
		result, err := providerJSON(ctx, base, "tasks/"+url.PathEscape(id), config, nil)
		if err != nil {
			return nil, err
		}
		task := asObject(result["data"])
		status := str(task["status"])
		if status == "completed" || status == "failed" {
			usable := array(asObject(task["result"])["usable_assets"])
			urls := []any{}
			for _, raw := range usable {
				if value := str(asObject(raw)["asset_url"]); value != "" {
					urls = append(urls, value)
				}
			}
			if len(urls) == 0 {
				return nil, fail(502, "APIMart 参考素材未通过审核")
			}
			return urls, nil
		}
		if err = waitContext(ctx); err != nil {
			return nil, err
		}
	}
}
