// 复用控制器维护的工程缓存；这里只负责读取和移除列表项，不触碰磁盘上的工程目录。
const storageKey = "toonflow.projectList";
const recentLimit = 6;

function readCache() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function readRecentProjects() {
  const projects = readCache().projectList;
  return (Array.isArray(projects) ? projects as { directory?: unknown; name?: unknown }[] : []).flatMap(item => typeof item?.directory === "string" ? [{ directory: item.directory, name: typeof item.name === "string" && item.name.trim() ? item.name : item.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? item.directory }] : []).slice(0, recentLimit);
}

export function forgetRecentProject(directory: string) {
  const cache = readCache();
  try { localStorage.setItem(storageKey, JSON.stringify({ ...cache, projectList: (Array.isArray(cache.projectList) ? cache.projectList as { directory?: unknown }[] : []).filter(item => item?.directory !== directory) })); }
  catch { /* 无痕窗口或宿主禁用存储时，列表项保留到下次读取。 */ }
  return readRecentProjects();
}
