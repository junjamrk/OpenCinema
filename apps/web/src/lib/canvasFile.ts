import axios from "axios";
import type { WorkspaceFilesClient } from "@/lib/workspaceFileClient";

type CanvasAssetNode = { id: string; data?: unknown };

export function getCanvasAssetDirectories(nodes: CanvasAssetNode[], retainedNodes: CanvasAssetNode[]) {
  const retained = new Set(retainedNodes.map(node => node.id.toLowerCase()));
  const pending = retainedNodes.map(node => node.data);
  const visited = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      const parts = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
      if (parts[0]?.toLowerCase() === "assets" && parts[1] && !parts.includes("..")) retained.add(parts[1].toLowerCase());
    } else if (value && typeof value === "object" && !visited.has(value)) {
      visited.add(value);
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  // ACT: 仅清理节点所属目录，不把引用路径当作目录归属，避免误删 assets/generated 等共享目录。
  return [...new Set(nodes.map(node => node.id))]
    .filter(id => id && !/[<>:"/\\|?*\x00-\x1f]/.test(id) && !/[. ]$/.test(id)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) && !retained.has(id.toLowerCase()))
    .map(id => `assets/${id}`);
}

export async function isCanvasFile(files: Pick<WorkspaceFilesClient, "readText">, path: string, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted();
    const headerBytes = 4096;
    const header = await files.readText(path, headerBytes, signal);
    signal?.throwIfAborted();
    if (!/^\s*\{/.test(header)) return false;
    // ACT: 自有保存格式将标记置于根对象首字段；其他顺序完整解析，避免嵌套标记误判。
    if (/^\s*\{\s*"toonflowCanvas"\s*:\s*true\s*[,}]/.test(header)) return true;
    try {
      return JSON.parse(header.trimStart())?.toonflowCanvas === true;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (new TextEncoder().encode(header).byteLength < headerBytes) return false;
    }
    const content = await files.readText(path, undefined, signal);
    signal?.throwIfAborted();
    return JSON.parse(content.trimStart())?.toonflowCanvas === true;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SyntaxError) return false;
    // ACT: 扫描期间已消失或不可作为文件读取的条目跳过，权限及其他 IO 错误继续抛出。
    if (axios.isAxiosError(error) && [400, 404].includes(error.response?.status ?? 0)) return;
    throw error;
  }
}
