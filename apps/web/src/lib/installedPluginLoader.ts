import { z } from "zod";
import * as sdk from "../pluginSdk";
import type { PluginModule } from "@toonflow/nodes-scaffold/contracts";
import { localApiUrl } from "./openCinemaTransport";

const packageSchema = z.object({
  manifest: z.object({ id: z.string(), renderer: z.literal("react") }),
  source: z.string().max(20 * 1024 ** 2),
  assets: z.array(z.object({
    path: z.string().min(1).max(512), base64: z.string().max(45 * 1024 ** 2),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.string().max(128), size: z.number().int().min(1).max(32 * 1024 ** 2),
  })).max(1000),
});

// ACT: 发行构建输出 ESM、字面量资产路径及内联 worker；原生 import map 保留分块与循环依赖。
export function createInstalledPluginLoader(lifetime: AbortSignal) {
  const key = `openCinemaPluginModules${crypto.randomUUID()}`;
  const assets = new Map<string, string>();
  const urls = new Set<string>();
  const pending = new Map<string, Promise<PluginModule>>();
  const scripts = new Set<HTMLScriptElement>();
  Object.defineProperty(globalThis, key, { value: { sdk, assets }, configurable: true });
  const urlFor = (content: BlobPart, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    urls.add(url); return url;
  };
  const sdkUrl = urlFor(`const sdk=globalThis[${JSON.stringify(key)}].sdk;${Object.keys(sdk).filter(name => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)).map(name => `export const ${name}=sdk[${JSON.stringify(name)}];`).join("")}`, "text/javascript");
  lifetime.addEventListener("abort", () => {
    for (const url of urls) URL.revokeObjectURL(url);
    for (const script of scripts) script.remove();
    Reflect.deleteProperty(globalThis, key); pending.clear(); assets.clear();
  }, { once: true });

  async function prepare(source: string): Promise<PluginModule> {
    lifetime.throwIfAborted();
    if (typeof HTMLScriptElement.supports !== "function" || !HTMLScriptElement.supports("importmap")) throw new Error("当前宿主浏览器不支持安装插件所需的模块映射");
    const moduleUrl = localApiUrl(source);
    const identity = moduleUrl?.pathname.match(/^\/api\/nodes\/modules\/([a-z][a-zA-Z0-9]{0,95})\/([a-f0-9]{64})\/index\.js$/);
    if (!moduleUrl || !identity) throw new Error("安装插件必须来自当前已授权的版本目录");
    const [, id, revision] = identity;
    const response = await fetch(`/api/nodes/package?${new URLSearchParams({ name: id!, revision: revision! })}`, { headers: { "x-toonflow-workspace": "1" }, signal: lifetime });
    const result = await response.json();
    if (!response.ok || result.code !== 200) throw new Error(result.message || "插件包读取失败");
    const content = packageSchema.parse(result.data);
    if (content.manifest.id !== id || new TextEncoder().encode(content.source).byteLength > 20 * 1024 ** 2) throw new Error("插件包 ID 或源码大小无效");
    const root = new URL(".", moduleUrl);
    const records = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string; logical: string; url?: string }>();
    let total = 0;
    for (const asset of content.assets) {
      if (/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(asset.path) || asset.path.split("/").some(part => !part || part === "." || part === "..") || /[\\\0?#]/.test(asset.path)) throw new Error("插件资产路径无效");
      const target = new URL(asset.path, root).href;
      if (records.has(target) || target === moduleUrl.href) throw new Error("插件资产路径重复");
      const bytes = Uint8Array.from(atob(asset.base64), value => value.charCodeAt(0));
      total += bytes.byteLength;
      if (bytes.byteLength !== asset.size || total > 64 * 1024 ** 2) throw new Error("插件资产大小无效");
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
      if (digest !== asset.sha256) throw new Error("插件资产 SHA 不符");
      records.set(target, { bytes, type: asset.mimeType, logical: `opencinema-plugin:${key}/${revision}/${asset.path}` });
    }
    const entry = { bytes: new TextEncoder().encode(content.source), type: "text/javascript", logical: `opencinema-plugin:${key}/${revision}/index.js`, url: undefined as string | undefined };
    records.set(moduleUrl.href, entry);
    const javascript = (path: string) => /\.(?:m?js)$/.test(new URL(path).pathname);
    const css = (path: string) => new URL(path).pathname.endsWith(".css");
    for (const [path, record] of records) if (!javascript(path) && !css(path)) record.url = urlFor(record.bytes, record.type);
    function resource(value: string, from: string) {
      try { return records.get(new URL(value, from).href); } catch { return; }
    }
    function rewrite(text: string, from: string) {
      return text.replace(/(["'])([^"'\n\\]+)\1/g, (match, _quote: string, value: string) => {
        if (value === "/pluginSdk.js") return JSON.stringify(sdkUrl);
        const record = resource(value, from);
        return record ? JSON.stringify(javascript(new URL(value, from).href) ? record.logical : record.url ?? record.logical) : match;
      });
    }
    const decoder = new TextDecoder();
    for (const [path, record] of records) if (css(path)) {
      const text = decoder.decode(record.bytes).replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/g, (match, _quote: string, value: string) => {
        const target = resource(value.trim(), path);
        return target?.url ? `url(${JSON.stringify(target.url)})` : match;
      });
      record.url = urlFor(rewrite(text, path), "text/css");
    }
    const imports: Record<string, string> = {};
    for (const [path, record] of records) if (javascript(path)) {
      let text = decoder.decode(record.bytes).replace(/new URL\(\s*(["'])([^"'\n\\]+)\1\s*,\s*import\.meta\.url\s*\)/g, (match, _quote: string, value: string) => {
        const target = resource(value, path);
        return target ? `new URL(globalThis[${JSON.stringify(key)}].assets.get(${JSON.stringify(target.logical)}))` : match;
      });
      text = rewrite(text, path);
      record.url = urlFor(text, "text/javascript"); imports[record.logical] = record.url;
    }
    lifetime.throwIfAborted();
    for (const record of records.values()) assets.set(record.logical, record.url!);
    const script = document.createElement("script");
    script.type = "importmap"; script.textContent = JSON.stringify({ imports });
    document.head.append(script); scripts.add(script);
    return import(/* @vite-ignore */ entry.logical) as Promise<PluginModule>;
  }

  return function loadModule(source: string): Promise<PluginModule> {
    if (!window.openCinemaTransport) return import(/* @vite-ignore */ source) as Promise<PluginModule>;
    let module = pending.get(source);
    if (!module) {
      module = prepare(source).catch(error => { pending.delete(source); throw error; });
      pending.set(source, module);
    }
    return module;
  };
}
