import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

type Launch = { session: string; directory: string | null; canvasId: string | null };
type RequestInput = { method: string; path: string; headers?: Record<string, string>; bodyBase64?: string };
type ResponseChunk = { status?: number; statusText?: string; headers?: Record<string, string>; bodyBase64: string; streamId?: string; uploadId?: string; cursor: number; done: boolean };
type Workspace = { flushSave(): Promise<void> };
const status = document.querySelector<HTMLElement>(".widgetStatus")!;
const fullscreenButton = document.querySelector<HTMLButtonElement>(".fullscreenButton")!;
const app = new App({ name: "OpenCinema Studio", version: "0.4.0" }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false });
const launch = Promise.withResolvers<Launch>();
let current: Launch | undefined;
let workspace: Workspace | undefined;
let closed = false;
let contextQueue = Promise.resolve();
let mountQueue = Promise.resolve();
let hostReady: Promise<void>;

function showError(message: string) { status.textContent = message; }
function resultMeta(result: unknown): Record<string, unknown> | undefined {
  let value = result;
  for (let depth = 0; depth < 3; depth++) {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record._meta && typeof record._meta === "object") return record._meta as Record<string, unknown>;
    const content = record.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") return;
    try { value = JSON.parse(content[0].text); } catch { return; }
  }
}
function decodeBody(value: unknown) {
  if (typeof value !== "string" || value.length > 349528) throw new Error("OpenCinema 响应分片无效");
  const text = atob(value);
  if (text.length > 256 * 1024) throw new Error("OpenCinema 响应分片超过限制");
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

async function call(action: "request" | "poll" | "cancel" | "close" | "upload", fields: Record<string, unknown> = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const target = await launch.promise;
  signal?.throwIfAborted();
  if (closed && action !== "close" && action !== "cancel") throw new Error("OpenCinema 工作台连接已关闭");
  const result = await app.callServerTool({ name: "openCinemaTransport", arguments: { session: target.session, action, ...fields } },
    { signal, timeout: action === "poll" ? 35000 : 120000 });
  if (result.isError) throw new Error("OpenCinema 服务请求失败，请保留当前工程并重试");
  return result;
}

async function cancelStream(streamId: string) { await call("cancel", { streamId }).catch(() => {}); }

function readChunk(result: Awaited<ReturnType<typeof call>>, first = false) {
  const chunk = resultMeta(result)?.openCinemaResponse as ResponseChunk | undefined;
  if (!chunk || typeof chunk.done !== "boolean" || typeof chunk.bodyBase64 !== "string" || !Number.isSafeInteger(chunk.cursor) || chunk.cursor < 0
    || first && (!Number.isInteger(chunk.status) || chunk.status! < 200 || chunk.status! > 599 || typeof chunk.statusText !== "string"
      || !chunk.headers || Array.isArray(chunk.headers) || Object.values(chunk.headers).some(value => typeof value !== "string"))
    || chunk.streamId !== undefined && (typeof chunk.streamId !== "string" || !chunk.streamId || chunk.streamId.length > 256)) {
    throw new Error("OpenCinema 服务响应无效");
  }
  return { chunk, bytes: decodeBody(chunk.bodyBase64) };
}

async function startRequest(input: RequestInput, signal?: AbortSignal) {
  let uploadId: string | undefined;
  try {
    const body = input.bodyBase64;
    if (!body || body.length <= 349528) return await call("request", { request: input }, signal);
    let cursor = 0;
    for (let offset = 0; offset < body.length; offset += 349524) {
      const { chunk } = readChunk(await call("upload", { uploadId, cursor, chunkBase64: body.slice(offset, offset + 349524) }, signal));
      if (typeof chunk.uploadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chunk.uploadId)
        || uploadId && chunk.uploadId !== uploadId || chunk.cursor !== cursor + 1 || chunk.bodyBase64 || chunk.done) throw new Error("OpenCinema 上传回执无效");
      uploadId = chunk.uploadId;
      cursor = chunk.cursor;
    }
    signal?.throwIfAborted();
    const { bodyBase64: _body, ...request } = input;
    return await call("request", { request: { ...request, bodyId: uploadId } }, signal);
  } catch (error) {
    if (uploadId) await call("cancel", { uploadId }).catch(() => {});
    throw error;
  }
}

async function fetchRequest(input: RequestInput, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  if (!input.path.startsWith("/api/") || /[\r\n#]/.test(input.path)) throw new Error("OpenCinema 请求路径无效");
  const { chunk, bytes } = readChunk(await startRequest(input, signal), true);
  const streamId = chunk.streamId;
  let cursor = chunk.cursor;
  if (cursor !== 0) throw new Error("OpenCinema 初始流位置无效");
  if (!chunk.done && !streamId) throw new Error("OpenCinema 流式响应缺少标识");
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = () => { if (finished) return; finished = true; signal?.removeEventListener("abort", abort); };
  const abort = () => {
    if (finished) return;
    finish();
    controller?.error(signal?.reason ?? new DOMException("请求已取消", "AbortError"));
    if (streamId) void cancelStream(streamId);
  };
  if (signal?.aborted) { if (streamId) await cancelStream(streamId); throw signal.reason; }
  if (input.method.toUpperCase() === "HEAD" || [204, 205, 304].includes(chunk.status!)) {
    finish();
    if (streamId) await cancelStream(streamId);
    return new Response(null, { status: chunk.status!, statusText: chunk.statusText, headers: chunk.headers });
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (bytes.length) value.enqueue(bytes);
      if (chunk.done) { finish(); value.close(); if (streamId) void cancelStream(streamId); }
      else signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(value) {
      if (finished || !streamId) return;
      try {
        const next = readChunk(await call("poll", { streamId, cursor }, signal));
        if (finished) return;
        if (next.chunk.cursor < cursor || next.bytes.length && next.chunk.cursor === cursor) throw new Error("OpenCinema 流位置无效");
        if (next.bytes.length) value.enqueue(next.bytes);
        cursor = next.chunk.cursor;
        if (next.chunk.done) { finish(); value.close(); await cancelStream(streamId); }
      } catch (error) {
        if (finished) return;
        finish(); value.error(error);
        await cancelStream(streamId);
      }
    },
    async cancel() { finish(); if (streamId) await cancelStream(streamId); },
  });
  try { return new Response(body, { status: chunk.status!, statusText: chunk.statusText, headers: chunk.headers }); }
  catch (error) { await body.cancel(); throw error; }
}

function updateContext(context: unknown) {
  const text = JSON.stringify(context);
  if (typeof text !== "string" || text.length > 256000) return Promise.reject(new Error("节点上下文过大，请减少选择范围"));
  contextQueue = contextQueue.catch(() => {}).then(async () => {
    await hostReady;
    if (closed) throw new Error("Codex 连接已关闭");
    if (!app.getHostCapabilities()?.updateModelContext) return;
    await app.updateModelContext({ content: [{ type: "text", text: "OpenCinema 当前工作台与选择：" + text
      + "。后续画布工具使用这里的 directory、connectionId 和 canvasId；复用当前工程，不直接改写画布 JSON。" }] });
  });
  return contextQueue;
}
async function sendPrompt(prompt: string, context: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) throw new Error("请输入有效的对话内容");
  const target = JSON.stringify(context);
  if (typeof target !== "string" || target.length > 256000) throw new Error("节点上下文过大，请减少选择范围");
  await hostReady;
  signal?.throwIfAborted();
  if (closed) throw new Error("Codex 连接已关闭");
  let result: Awaited<ReturnType<typeof app.sendMessage>>;
  try {
    // 完整冻结目标已随消息发送，不把独立的选择上下文同步当作发送前置条件。
    result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt + "\n\n本次 OpenCinema 操作目标（固定于发送时）："
      + target + "。修改前核对实时目标，使用画布/节点工具并保存。消息已接收不代表任务完成；生成结果按节点工具的 taskId 契约写回。" }] }, { signal, timeout: 20000 });
  } catch (error) {
    status.textContent = "消息发送状态未确认";
    throw Object.assign(new Error("宿主消息回执未确认；请保留输入，核对当前对话后再决定是否重试"), { cause: error, code: "hostRequestUnknown", outcome: "unknown", executionSettled: false });
  }
  if (result.isError) throw new Error("Codex 未接收消息，请保留输入并重试");
  status.textContent = "已发送到 Codex";
}
async function downloadFile(content: Blob, fileName: string) {
  await hostReady;
  if (closed || !app.getHostCapabilities()?.downloadFile) throw new Error("当前 Codex 宿主不支持文件下载");
  const name = fileName.split(/[\\/]/).at(-1)?.trim();
  if (!name || /[\u0000-\u001f]/.test(name)) throw new Error("下载文件名无效");
  const blob = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const data = reader.result as string; resolve(data.slice(data.indexOf(",") + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error("读取下载内容失败"));
    reader.onabort = () => reject(new DOMException("下载已取消", "AbortError"));
    reader.readAsDataURL(content);
  });
  const result = await app.downloadFile({ contents: [{ type: "resource", resource: {
    uri: "file:///" + encodeURIComponent(name), mimeType: content.type || "application/octet-stream", blob,
  } }] });
  return result.isError !== true;
}
// ACT: 同一文档加载完整 React 工作台；服务访问仅经官方 MCP Apps bridge。
Object.defineProperty(window, "openCinemaTransport", { value: {
  ready: launch.promise, fetch: fetchRequest, updateContext, sendPrompt, downloadFile,
  setWorkspace(value: Workspace | undefined) { workspace = value; if (value) status.textContent = "工作台已打开"; },
}, configurable: false, writable: false });

function applyHostContext() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  document.body.classList.toggle("fullscreen", context?.displayMode === "fullscreen");
  fullscreenButton.hidden = !context?.availableDisplayModes?.includes("fullscreen") || context.displayMode === "fullscreen";
}
app.onhostcontextchanged = applyHostContext;
app.ontoolresult = result => {
  const data = resultMeta(result)?.openCinema as Launch | undefined;
  if (!data) return;
  mountQueue = mountQueue.catch(() => {}).then(async () => {
    await hostReady;
    if (typeof data.session !== "string" || data.session.length < 32 || data.session.length > 256
      || data.directory !== null && (typeof data.directory !== "string" || !data.directory || data.directory.length > 4096)
      || data.canvasId !== null && (typeof data.canvasId !== "string" || !data.canvasId || data.canvasId.length > 256)) throw new Error("OpenCinema 工作台初始化信息无效");
    if (current) {
      if (current.session === data.session) return;
      // 已挂载工作台拥有未保存状态和订阅，禁止用另一个工具结果静默重定向。
      throw new Error("此工作台已连接工程，请保留当前草稿并打开新的工作台");
    }
    current = { session: data.session, directory: data.directory, canvasId: data.canvasId };
    status.textContent = "正在打开工程";
    launch.resolve(current);
  });
  void mountQueue.catch(error => { if (!current) launch.reject(error); showError(error instanceof Error ? error.message : "OpenCinema 无法打开工作台"); });
};
app.onteardown = async () => {
  await mountQueue.catch(() => {});
  await workspace?.flushSave();
  await contextQueue.catch(() => {});
  if (current) await call("close");
  closed = true;
  return {};
};
fullscreenButton.onclick = () => { void app.requestDisplayMode({ mode: "fullscreen" }).then(applyHostContext).catch(() => showError("当前宿主未允许全屏")); };
hostReady = app.connect(undefined, { timeout: 15000 }).then(() => {
  applyHostContext(); status.textContent = "等待 OpenCinema 工程";
  return app.sendSizeChanged({ height: 760, width: Math.max(480, window.innerWidth) });
});
void hostReady.catch(error => { launch.reject(error); showError("Codex Widget 连接失败，请保留当前工程后重试"); });
void launch.promise.catch(() => {});
