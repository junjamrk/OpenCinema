import axios from "axios";
import { isMobile, isRemoteConnection } from "./platform";
import { ToolExecutionError, toolErrorDetailsSchema } from "@toonflow/nodes-scaffold/toolErrors";

type WorkspaceEntry = { name: string; path: string; type: "file" | "directory" };
export type TextSnapshot = { text: string; revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" };
export const workspaceFileClient = axios.create({ baseURL: "/api/workspaces/files", headers: { "x-toonflow-workspace": "1" } });
// 只替换 Axios 的英文占位文案；错误对象不变，调用方仍按状态码和响应 code 分支。
export function explainRequestError(error: unknown) {
  if (!axios.isAxiosError(error) || axios.isCancel(error)) throw error;
  let body = error.response?.data;
  if (body instanceof ArrayBuffer) try { body = JSON.parse(new TextDecoder().decode(body)); } catch { /* 非 JSON 响应保留状态码提示。 */ }
  const message: unknown = body?.message;
  if (typeof message === "string" && message.trim()) error.message = message;
  else if (!error.response) error.message = "无法连接 OpenCinema 服务，请确认服务仍在运行";
  else error.message = `服务请求失败（${error.response.status}）`;
  throw error;
}
workspaceFileClient.interceptors.response.use(undefined, explainRequestError);
const client = workspaceFileClient;
const fileUrls = new Map<string, { directory: string; path: string; url: Promise<string>; users: number }>();

function cachePath(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/").toLowerCase();
}

function invalidateUrls(directory: string, path: string) {
  // ACT: 仅失效时保守合并路径写法；实际读取仍交服务端校验，区分大小写的文件最多多读一次。
  directory = cachePath(directory);
  path = cachePath(path);
  for (const [key, entry] of fileUrls) {
    const entryPath = cachePath(entry.path);
    if (cachePath(entry.directory) === directory && (entryPath === path || entryPath.startsWith(`${path}/`))) fileUrls.delete(key);
  }
}

export function createWorkspaceFiles(directory: string | (() => string | undefined)) {
  function getDirectory() {
    const path = typeof directory === "function" ? directory() : directory;
    if (!path) throw new Error("请先选择工作目录");
    return path;
  }

  async function list(path = "", signal?: AbortSignal) {
    const { data } = await client.get<{ data: { directory: string; empty: boolean; entries: WorkspaceEntry[] } }>("/list", { params: { directory: getDirectory(), path }, signal });
    return data.data;
  }
  async function resourceRequest<T>(request: Promise<T>): Promise<T> {
    try { return await request; }
    catch (error) {
      if (axios.isAxiosError(error)) {
        let response = error.response?.data;
        if (response instanceof ArrayBuffer) try { response = JSON.parse(new TextDecoder().decode(response)); } catch { /* 非JSON失败保留原HTTP错误。 */ }
        const details = toolErrorDetailsSchema.safeParse(response?.data?.errorDetails);
        if (details.success) throw new ToolExecutionError(details.data);
        if (error.response?.status === 409 && response?.data?.code === "EBUSY") throw new ToolExecutionError({ code: "EBUSY", message: "工程文件或目录正在使用，本次操作未执行", phase: "execution", executionState: "failed", recovery: { action: "readState", message: "等待当前媒体或文件操作收尾，读取节点任务状态和目标文件后再决定是否重试", tool: "workspaceFiles" } });
        if (response?.data?.code === "ESTALE") throw new ToolExecutionError({ code: "revisionConflict", message: "工程文件已变化，未执行写入", phase: "target", executionState: "notDispatched", recovery: { action: "readState", message: "重新读取源文件fileRevision并确认操作", tool: "workspaceFiles" } });
      }
      throw error;
    }
  }
  async function stat(path: string, signal?: AbortSignal) {
    const { data } = await resourceRequest(client.get<{ data: { directory: string; path: string; fileRevision: string; size: number; isDirectory: boolean } }>("/stat", { params: { directory: getDirectory(), path }, signal }));
    const info = data.data;
    if (!/^[a-f0-9]{64}$/.test(info.fileRevision) || !Number.isSafeInteger(info.size) || typeof info.isDirectory !== "boolean") throw new Error("服务端未提供有效的工程文件版本，请更新应用");
    return info;
  }

  async function read(path: string, maxBytes?: number, signal?: AbortSignal) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    try {
      const { data } = await client.get<ArrayBuffer>("/read", {
        params: { directory: getDirectory(), path }, responseType: "arraybuffer", signal,
        // 多读一个字节区分完整文件与被截断的参考，不让插件把半个文件当成成功读取。
        headers: maxBytes === undefined ? undefined : { Range: `bytes=0-${maxBytes}` },
      });
      if (maxBytes !== undefined && data.byteLength > maxBytes) throw new Error("文件超过本次读取的大小限制");
      return data;
    } catch (error) {
      if (maxBytes !== undefined && axios.isAxiosError(error) && error.response?.status === 416 && error.response.headers["content-range"] === "bytes */0") return new ArrayBuffer(0);
      throw error;
    }
  }

  async function importImage(url: string) {
    const { data } = await client.post<{ data: { path: string; mimeType: string } }>("/importImage", { directory: getDirectory(), url });
    return data.data;
  }

  async function readRange(path: string, offset: number, length: number, revision?: string, signal?: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 8 * 1024 * 1024) throw new Error("分段读取范围无效，每段最多8MiB");
    const response = await resourceRequest(client.get<ArrayBuffer>("/range", {
      params: { directory: getDirectory(), path, offset, length, revision }, responseType: "arraybuffer", signal,
    }));
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers["content-range"] ?? ""));
    const currentRevision = String(response.headers["x-toonflow-file-revision"] ?? "");
    if (response.status !== 206 || !range || !/^[0-9a-f]{64}$/.test(currentRevision)) throw new Error("服务端未提供有效的文件分段，请更新应用");
    const start = Number(range[1]), end = Number(range[2]), size = Number(range[3]);
    if (!Number.isSafeInteger(size) || start !== offset || end < start || end >= size || end - start + 1 !== response.data.byteLength || response.data.byteLength > length) throw new Error("文件分段响应不完整");
    if (revision && revision !== currentRevision) throw new Error("文件已变化，请重新检查素材");
    return { content: response.data, size, revision: currentRevision };
  }

  async function cloneProject(project: { url: string; name: string }, signal?: AbortSignal) {
    const { data } = await client.post<{ data: { directory: string } }>("/clone", { directory: getDirectory(), ...project }, { baseURL: "/api/workspaces", signal });
    return data.data;
  }

  async function exportProject(signal?: AbortSignal) {
    const { data } = await client.get<Blob>("/exportProject", {
      baseURL: "/api/workspaces", params: { directory: getDirectory() }, responseType: "blob", signal,
    });
    return data;
  }

  async function saveProjectArchive(path: string, signal?: AbortSignal) {
    const directory = getDirectory();
    // 归档可能在落盘后的复验失败，不能把通用ESTALE解释为未执行写入。
    const { data } = await client.post<{ data: { path: string; size: number; fileRevision: string; sourceRevision: string; mimeType: "application/zip" } }>("/exportProject", { directory, path }, { baseURL: "/api/workspaces", signal }).catch(error => {
      if (axios.isAxiosError(error) && error.response?.status === 409 && error.response.data?.data?.code === "EEXIST") throw new ToolExecutionError({ code: "artifactAlreadyExists", message: "归档目标已存在，未覆盖文件", phase: "validation", executionState: "notDispatched", target: { directory, path }, recovery: { action: "readState", message: "读取已有归档的大小与fileRevision，确认采用已有产物或显式选择新的目标路径", tool: "workspaceFiles", args: { action: "stat", path } } });
      throw error;
    });
    const artifact = data.data;
    if (artifact.path !== path || !Number.isSafeInteger(artifact.size) || artifact.size < 22 || !/^[a-f0-9]{64}$/.test(artifact.fileRevision) || !/^[a-f0-9]{64}$/.test(artifact.sourceRevision) || artifact.mimeType !== "application/zip") throw new Error("服务端未提供有效的工程ZIP产物回执");
    invalidateUrls(directory, path);
    return artifact;
  }

  function acquireUrl(path: string, mimeType?: string) {
    const directory = getDirectory();
    const key = JSON.stringify([directory, path, mimeType]);
    let entry = fileUrls.get(key);
    if (!entry) {
      const url = client.get<Blob>("/read", { params: { directory, path }, responseType: "blob" })
        .then(({ data }) => URL.createObjectURL(mimeType ? new Blob([data], { type: mimeType }) : data));
      entry = { directory, path, url, users: 0 };
      fileUrls.set(key, entry);
      const current = entry;
      void url.catch(() => { if (fileUrls.get(key) === current) fileUrls.delete(key); });
    }
    const current = entry;
    current.users++;
    let released = false;
    return {
      url: current.url,
      release() {
        if (released) return;
        released = true;
        if (--current.users) return;
        if (fileUrls.get(key) === current) fileUrls.delete(key);
        // 等待中的读取也要在最后一个使用者离开后释放，不撤销其他节点仍使用的 URL。
        void current.url.then(url => URL.revokeObjectURL(url), () => {});
      },
    };
  }

  async function readText(path: string, maxBytes?: number, signal?: AbortSignal) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    try {
      const { data } = await client.get<string>("/read", {
        params: { directory: getDirectory(), path }, responseType: "text", transformResponse: [], signal,
        headers: maxBytes === undefined ? undefined : { Range: `bytes=0-${maxBytes - 1}` },
      });
      return data;
    } catch (error) {
      if (maxBytes !== undefined && axios.isAxiosError(error) && error.response?.status === 416 && error.response.headers["content-range"] === "bytes */0") return "";
      throw error;
    }
  }

  async function readJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    const text = await readText(path, undefined, signal);
    signal?.throwIfAborted();
    return JSON.parse(text);
  }

  async function readTextSnapshot(path: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<TextSnapshot> {
    if (options?.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    const { data } = await client.get<{ data: TextSnapshot }>("/read", {
      params: { directory: getDirectory(), path, snapshot: true, maxBytes: options?.maxBytes }, signal: options?.signal,
    });
    return data.data;
  }

  async function writeTextSnapshot(path: string, text: string, snapshot: Pick<TextSnapshot, "revision" | "encoding">) {
    const directory = getDirectory();
    const { data } = await resourceRequest(client.put<{ data: { revision: string } }>("/write", text, {
      params: { directory, path, expectedRevision: snapshot.revision, encoding: snapshot.encoding },
      headers: { "Content-Type": "application/octet-stream" },
    }));
    invalidateUrls(directory, path);
    return data.data.revision;
  }

  async function write(path: string, content: string | Blob | ArrayBuffer, exclusive = false, signal?: AbortSignal) {
    const directory = getDirectory();
    await resourceRequest(client.put("/write", content, { params: { directory, path, exclusive }, signal, headers: { "Content-Type": "application/octet-stream" } }));
    invalidateUrls(directory, path);
  }

  function writeJson(path: string, data: unknown, exclusive = false) {
    return write(path, `${JSON.stringify(data, null, 2)}\n`, exclusive);
  }

  async function rename(path: string, target: string, expectedRevision?: string) {
    const directory = getDirectory();
    const revision = expectedRevision ?? (await createWorkspaceFiles(directory).stat(path)).fileRevision;
    await resourceRequest(client.post("/rename", { directory, path, target, expectedRevision: revision }));
    invalidateUrls(directory, path);
    invalidateUrls(directory, target);
  }

  async function copy(path: string, target: string, expectedRevision?: string) {
    const directory = getDirectory();
    const revision = expectedRevision ?? (await createWorkspaceFiles(directory).stat(path)).fileRevision;
    await resourceRequest(client.post("/copy", { directory, path, target, expectedRevision: revision }));
    invalidateUrls(directory, target);
  }

  async function reveal(path: string) {
    if (isRemoteConnection) throw new Error("远程项目文件无法在本机文件管理器中定位，请下载或导出后查看。");
    if (isMobile) throw new Error("移动端暂不支持在文件管理器中定位项目文件，请使用下载或导出保存文件。");
    await client.post("/reveal", { directory: getDirectory(), path });
  }

  async function remove(path: string, recursive = false, expectedRevision?: string) {
    const directory = getDirectory();
    const revision = expectedRevision ?? (await createWorkspaceFiles(directory).stat(path)).fileRevision;
    await resourceRequest(client.delete("/remove", { data: { directory, path, recursive, expectedRevision: revision } }));
    invalidateUrls(directory, path);
  }

  async function mkdir(path: string) {
    await resourceRequest(client.post("/mkdir", { directory: getDirectory(), path }));
  }

  // ACT: 当前目录逐次读取；跨 await 或防抖的操作传入目录字符串，固定本次目标。
  return { list, stat, read, readRange, importImage, cloneProject, exportProject, saveProjectArchive, acquireUrl, readText, readJson, readTextSnapshot, writeTextSnapshot, write, writeJson, rename, copy, reveal, remove, mkdir };
}

export type WorkspaceFilesClient = ReturnType<typeof createWorkspaceFiles>;
