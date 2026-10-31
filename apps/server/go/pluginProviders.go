package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// 串行化冲突检查与插件发布，避免两个插件同时占用同一个供应商 ID。
var pluginProviderChange sync.Mutex

// 插件声明的供应商与用户添加的走同一个 parseHTTPProvider，凭据与地址限制不另写一份。
func parsePluginProviders(manifest object) ([]object, error) {
	declared, exists := manifest["providers"]
	if !exists {
		return nil, nil
	}
	items, valid := declared.([]any)
	if !valid || len(items) > 32 {
		return nil, fail(400, "插件 providers 须为最多 32 项的数组")
	}
	providers := []object{}
	seen := map[string]bool{}
	for _, item := range items {
		source, err := json.Marshal(item)
		if err != nil {
			return nil, err
		}
		provider, err := parseHTTPProvider(string(source))
		if err != nil {
			return nil, err
		}
		id := str(provider["id"])
		if seen[id] {
			return nil, fail(400, "插件 providers 的 id 不能重复："+id)
		}
		seen[id] = true
		providers = append(providers, provider)
	}
	return providers, nil
}

// ACT: 每次读盘并重新校验全部插件清单，开销随已安装插件数线性增长；providers() 成为热点时改为安装、启停时刷新的内存快照。
func (s *server) installedPluginProviders(includeDisabled bool) []object {
	directory := filepath.Join(s.dataDirectory, "nodes")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	providers := []object{}
	for _, entry := range entries {
		name := strings.TrimSuffix(entry.Name(), ".json")
		if entry.IsDir() || name == entry.Name() || !pluginName.MatchString(name) {
			continue
		}
		if _, err = os.Stat(filepath.Join(directory, name+".disabled")); err == nil && !includeDisabled {
			continue
		}
		data, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			continue
		}
		var manifest object
		if json.Unmarshal(data, &manifest) != nil {
			continue
		}
		// 校验不过的清单不暴露供应商，插件本身的加载错误由 nodeList 报告。
		declared, err := parsePluginProviders(manifest)
		if err != nil {
			continue
		}
		for _, provider := range declared {
			provider["pluginId"] = name
			providers = append(providers, provider)
		}
	}
	return providers
}

func (s *server) pluginOwnProviders(name string) []object {
	owned := []object{}
	for _, provider := range s.installedPluginProviders(true) {
		if str(provider["pluginId"]) == name {
			owned = append(owned, provider)
		}
	}
	return owned
}

// 用户自建与内置供应商优先；同 ID 只可能来自手工改动，这里跳过插件版本而不是覆盖。
func (s *server) withPluginProviders(providers []any) []any {
	present := map[string]bool{}
	for _, raw := range providers {
		present[str(asObject(raw)["id"])] = true
	}
	for _, provider := range s.installedPluginProviders(false) {
		if id := str(provider["id"]); !present[id] {
			present[id] = true
			providers = append(providers, providerSnapshot(provider))
		}
	}
	return providers
}

func (s *server) configurableProvider(settings object, id string) (object, error) {
	provider, err := configuredProvider(settings, id)
	if err == nil {
		return provider, nil
	}
	for _, candidate := range s.installedPluginProviders(false) {
		if str(candidate["id"]) == id {
			return candidate, nil
		}
	}
	return nil, err
}

func (s *server) checkPluginProviders(name string, providers []object) error {
	if len(providers) == 0 {
		return nil
	}
	owners := map[string]string{}
	for _, raw := range builtinMediaProviders() {
		owners[str(asObject(raw)["id"])] = "内置供应商"
	}
	for id, raw := range asObject(s.settings()["mediaProviders"]) {
		if raw != nil {
			owners[id] = "用户自建供应商"
		}
	}
	for _, provider := range s.installedPluginProviders(true) {
		if owner := str(provider["pluginId"]); owner != name {
			owners[str(provider["id"])] = "插件 " + owner
		}
	}
	for _, provider := range providers {
		if owner := owners[str(provider["id"])]; owner != "" {
			return fail(409, fmt.Sprintf("插件 %s 的供应商 %s 已被%s占用；请更换供应商 ID 或先移除占用方", name, str(provider["id"]), owner))
		}
	}
	return nil
}

// 地址变化或声明移除时凭据不能留给新地址或下一个声明同 ID 的插件。
func staleProviderIDs(previous, next []object) []string {
	addresses := map[string]string{}
	for _, provider := range next {
		addresses[str(provider["id"])] = str(provider["apiUrl"]) + "\n" + str(provider["modelsUrl"])
	}
	stale := []string{}
	for _, provider := range previous {
		if address, kept := addresses[str(provider["id"])]; !kept || address != str(provider["apiUrl"])+"\n"+str(provider["modelsUrl"]) {
			stale = append(stale, str(provider["id"]))
		}
	}
	return stale
}

func (s *server) forgetProviderConfigs(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	s.configMu.Lock()
	defer s.configMu.Unlock()
	previous := s.config["settings"]
	settings := asObject(clone(previous))
	configs := asObject(settings["mediaProviderConfigs"])
	for _, id := range ids {
		if asObject(settings["mediaProviders"])[id] == nil {
			delete(configs, id)
		}
	}
	settings["mediaProviderConfigs"] = configs
	s.config["settings"] = settings
	if err := s.persistConfig(); err != nil {
		s.config["settings"] = previous
		return err
	}
	return nil
}
