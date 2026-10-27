import axios, { AxiosError, AxiosHeaders, CanceledError, type AxiosAdapter } from "axios";

export type OpenCinemaTransport = {
  ready: Promise<{ session: string; directory: string | null; canvasId: string | null }>;
  fetch(input: { method: string; path: string; headers?: Record<string, string>; bodyBase64?: string }, signal?: AbortSignal): Promise<Response>;
  updateContext(context: unknown): Promise<void>;
  sendPrompt(prompt: string, context: unknown, signal?: AbortSignal): Promise<void>;
  downloadFile(content: Blob, fileName: string): Promise<boolean>;
  setWorkspace(workspace: { flushSave(): Promise<void> } | undefined): void;
};

declare global { interface Window { openCinemaTransport?: OpenCinemaTransport } }

const nativeFetch = window.fetch.bind(window);
const originalAdapter = axios.getAdapter(axios.defaults.adapter);
const apiBase = "https://open-cinema.invalid";

export function localApiUrl(input: string) {
  if (/[\\\0\r\n#]/.test(input) || !input.startsWith("/api/") && !URL.canParse(input)) return;
  const origin = window.openCinemaTransport ? apiBase : window.location.origin;
  try {
    const url = new URL(input, origin);
    if (url.origin === origin && !url.username && !url.password && url.pathname.startsWith("/api/")) return url;
  } catch { /* 原生 srcdoc 没有可用的页面 origin，始终以固定逻辑 API 地址解析。 */ }
}

export function localApiPath(input: string) {
  const url = localApiUrl(input);
  if (url) return `${url.pathname}${url.search}`;
}

function encodeBody(content: ArrayBuffer) {
  const bytes = new Uint8Array(content);
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(encoded);
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = input instanceof Request ? input.url : String(input);
  const path = localApiPath(source);
  const transport = window.openCinemaTransport;
  if (!transport || !path) return nativeFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
  signal?.throwIfAborted();
  let bodyBase64: string | undefined;
  const body = init?.body;
  if (method !== "GET" && method !== "HEAD" && (body !== undefined && body !== null || input instanceof Request && input.body)) {
    // 浏览器负责 FormData boundary 和原生 BodyInit 编码，桥只传输字节，不重写业务请求。
    const request = input instanceof Request ? new Request(input, init) : new Request(`${apiBase}${path}`, { ...init, method, headers });
    for (const [key, value] of request.headers) headers.set(key, value);
    bodyBase64 = encodeBody(await request.arrayBuffer());
  }
  signal?.throwIfAborted();
  return transport.fetch({ method, path, headers: Object.fromEntries(headers), ...(bodyBase64 === undefined ? {} : { bodyBase64 }) }, signal);
}

const transportAdapter: AxiosAdapter = async config => {
  const path = localApiPath(axios.getUri(config));
  if (!window.openCinemaTransport || !path) return originalAdapter(config);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  config.cancelToken?.subscribe(cancel);
  const timeout = config.timeout ? setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), config.timeout) : undefined;
  const signal = AbortSignal.any([controller.signal, ...(config.signal ? [config.signal as AbortSignal] : [])]);
  try {
    config.cancelToken?.throwIfRequested();
    signal.throwIfAborted();
    const headers = Object.fromEntries(Object.entries(config.headers.toJSON()).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
    if (config.data instanceof FormData) for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key];
    const response = await transportFetch(path, { method: config.method, headers, body: config.data, signal });
    const data = config.responseType === "arraybuffer" ? await response.arrayBuffer() : config.responseType === "blob" ? await response.blob()
      : config.responseType === "stream" ? response.body : await response.text();
    const result = { data, status: response.status, statusText: response.statusText, headers: AxiosHeaders.from(Object.fromEntries(response.headers)), config };
    if (config.validateStatus && !config.validateStatus(response.status)) throw new AxiosError(`Request failed with status code ${response.status}`, response.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST, config, undefined, result);
    return result;
  } catch (error) {
    if (signal.aborted) {
      if (controller.signal.reason?.name === "TimeoutError") throw new AxiosError("请求超时", AxiosError.ECONNABORTED, config);
      throw new CanceledError("请求已取消", config);
    }
    throw error instanceof AxiosError ? error : AxiosError.from(error, AxiosError.ERR_NETWORK, config);
  } finally {
    if (timeout) clearTimeout(timeout);
    config.cancelToken?.unsubscribe(cancel);
  }
};

// ACT: 仅原生 Widget 提供此能力；普通网页保留原生网络栈，已安装插件继续使用原来的 fetch/axios。
if (window.openCinemaTransport) {
  window.fetch = Object.assign(transportFetch, window.fetch);
  axios.defaults.adapter = transportAdapter;
}
