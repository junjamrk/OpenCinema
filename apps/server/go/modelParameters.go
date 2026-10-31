package main

import (
	"math"
	"regexp"
	"strings"
)

// 模型 parameters 是 JSON Schema 的子集：{ "type": "object", "properties": { 字段: 声明 } }。
// 只认下面列出的关键字，其余直接拒绝，避免作者以为写了 required 之类的约束就会生效。

var parameterName = regexp.MustCompile("^[a-zA-Z][a-zA-Z0-9_]{0,95}$")

func parameterTypeMatches(kind string, value any) bool {
	switch typed := value.(type) {
	case string:
		return kind == "string" || kind == ""
	case bool:
		return kind == "boolean" || kind == ""
	case float64:
		// 超出 2^53 的整数经 JSON 传递会丢精度，写进工作流的不再是用户填的值。
		return kind == "number" || kind == "" || kind == "integer" && typed == math.Trunc(typed) && math.Abs(typed) <= 1<<53
	}
	return false
}

func validateParameterValue(name string, field object, value any) error {
	if !parameterTypeMatches(str(field["type"]), value) {
		return fail(400, "模型参数类型不符: "+name)
	}
	// openaiVideo 的 multipart 把 data: 开头的文本当文件上传，参数不能走这条路。
	if text, ok := value.(string); ok && (len(text) > 10000 || strings.HasPrefix(text, "data:")) {
		return fail(400, "模型参数文本过长或为内联数据: "+name)
	}
	if amount, ok := value.(float64); ok {
		if minimum, ok := field["minimum"].(float64); ok && amount < minimum {
			return fail(400, "模型参数超出范围: "+name)
		}
		if maximum, ok := field["maximum"].(float64); ok && amount > maximum {
			return fail(400, "模型参数超出范围: "+name)
		}
	}
	if options, ok := field["enum"].([]any); ok {
		for _, option := range options {
			if option == value {
				return nil
			}
		}
		return fail(400, "模型参数不在可选范围内: "+name)
	}
	return nil
}

func validateModelParameters(model object) error {
	raw, declared := model["parameters"]
	if !declared {
		return nil
	}
	schema, valid := raw.(map[string]any)
	properties, listed := schema["properties"].(map[string]any)
	if !valid || !listed || schema["type"] != "object" || len(schema) != 2 || len(properties) == 0 || len(properties) > 64 {
		return fail(400, "parameters 须为 { type: \"object\", properties } 且声明1至64个字段")
	}
	for name, rawField := range properties {
		field, valid := rawField.(map[string]any)
		if !valid || !parameterName.MatchString(name) || secretField.MatchString(name) {
			return fail(400, "模型参数字段名无效: "+name)
		}
		for key := range field {
			switch key {
			case "type", "title", "default", "minimum", "maximum", "enum":
			default:
				return fail(400, "模型参数不支持的关键字: "+key)
			}
		}
		kind := str(field["type"])
		options, enumerated := field["enum"].([]any)
		if field["enum"] != nil && (!enumerated || len(options) == 0 || len(options) > 100) {
			return fail(400, "模型参数 enum 须为1至100项: "+name)
		}
		if kind != "string" && kind != "number" && kind != "integer" && kind != "boolean" && (field["type"] != nil || !enumerated) {
			return fail(400, "模型参数类型无效: "+name)
		}
		if title, exists := field["title"]; exists {
			if text, ok := title.(string); !ok || len(text) > 200 {
				return fail(400, "模型参数 title 须为200字节内文本: "+name)
			}
		}
		minimum, hasMinimum := field["minimum"].(float64)
		maximum, hasMaximum := field["maximum"].(float64)
		if field["minimum"] != nil && !hasMinimum || field["maximum"] != nil && !hasMaximum || hasMinimum && hasMaximum && minimum > maximum {
			return fail(400, "模型参数范围无效: "+name)
		}
		if (hasMinimum || hasMaximum) && kind != "number" && kind != "integer" {
			return fail(400, "只有数字参数能声明范围: "+name)
		}
		for _, option := range options {
			if !parameterTypeMatches(kind, option) {
				return fail(400, "模型参数 enum 与类型不符: "+name)
			}
		}
		if value, exists := field["default"]; exists {
			if err := validateParameterValue(name, field, value); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateMediaParameters(provider, model, input object) error {
	raw, exists := input["parameters"]
	if !exists {
		return nil
	}
	values, valid := raw.(map[string]any)
	if !valid || videoProtocol(provider) == "" || model["parameters"] == nil {
		return fail(400, "此模型未声明 parameters")
	}
	properties := asObject(asObject(model["parameters"])["properties"])
	for name, value := range values {
		field, declared := properties[name]
		if !declared {
			return fail(400, "模型未声明参数: "+name)
		}
		if err := validateParameterValue(name, asObject(field), value); err != nil {
			return err
		}
	}
	return nil
}
