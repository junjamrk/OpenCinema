import { z } from "zod";
import { ToolExecutionError, toolErrorDetailsSchema } from "@toonflow/nodes-scaffold/toolErrors";

export const pluginPackageSchema = z.object({ manifest: z.object({ id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/), apiVersion: z.literal(1), renderer: z.literal("react"), version: z.string().min(1), name: z.string().optional() }).passthrough(), source: z.string().min(1), assets: z.array(z.object({ path: z.string(), base64: z.string(), sha256: z.string(), mimeType: z.string() })).optional() });
export const pluginSchema = z.object({ id: z.string().optional(), name: z.string(), displayName: z.string().optional(), version: z.string().optional(), revision: z.string().optional(), scope: z.enum(["node", "workspace"]).optional(), builtin: z.boolean(), installed: z.boolean().optional(), enabled: z.boolean(), canConfigure: z.boolean().optional(), configRevision: z.string().regex(/^[a-f0-9]{64}$/), config: z.record(z.string(), z.json()).nullish(), configRules: z.array(z.record(z.string(), z.json())).optional(), loadError: z.string().optional(), description: z.string().optional(), author: z.string().optional(), license: z.string().optional(), homepage: z.string().optional(), tags: z.array(z.string()).optional(), agentGuide: z.string().optional(), requires: z.record(z.string(), z.number()).optional() });
const depthSchema = z.object({ available: z.boolean(), runtimeAvailable: z.boolean(), mediaToolsAvailable: z.boolean().optional(), message: z.string(), phase: z.string().optional(), preparationProgress: z.object({ phase: z.string(), received: z.number(), total: z.number(), error: z.string().optional() }).nullable().optional() });
const providerConfigurationSchema = z.object({ providerId: z.string(), rules: z.array(z.record(z.string(), z.json())), config: z.record(z.string(), z.json()), credentialConfigured: z.record(z.string(), z.boolean()), configRevision: z.string().regex(/^[a-f0-9]{64}$/), scope: z.string() });
export const providerModelSchema = z.object({ id: z.string().min(1).max(256), label: z.string().min(1).max(200), type: z.enum(["image", "video", "audio", "text"]) }).catchall(z.json());
export const mediaProviderSchema = z.object({ id: z.string(), label: z.string(), fileName: z.string(), revision: z.string(), version: z.string().optional(), rules: z.array(z.record(z.string(), z.json())).optional(), modelsUrl: z.string().optional(), models: z.array(providerModelSchema), credentialConfigured: z.boolean().optional(), loadError: z.string().optional() }).catchall(z.json());
export const ffmpegConfigurationSchema = z.object({ config: z.object({ mode: z.enum(["auto", "download", "system"]), source: z.string() }), configRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export const ffmpegProgressSchema = z.object({ phase: z.string(), received: z.number(), total: z.number().optional(), file: z.string().optional(), error: z.string().optional() });
export const ffmpegStatusSchema = z.object({ platform: z.string(), arch: z.string(), target: z.string(), supported: z.boolean(), directory: z.string(), version: z.string().optional(), sources: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean(), description: z.string().optional(), homepage: z.string().optional() })), config: z.object({ mode: z.string().optional(), source: z.string().optional() }), tools: z.record(z.string(), z.object({ path: z.string(), source: z.string(), version: z.string().optional(), error: z.string().nullable() })), download: ffmpegProgressSchema });
const generalConfigurationSchema = z.object({ general: z.record(z.string(), z.json()), configRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export const localVideoConnectionChangesSchema = z.strictObject({ enabled: z.boolean().optional(), endpoint: z.string().trim().url().max(2048).describe("HTTP(S) 地址，显式端口；仅 localhost、环回 IP 或私有局域网 IP，可带固定路径前缀，不含凭据、查询或锚点，例如 http://127.0.0.1:8188").optional() }).refine(value => Object.keys(value).length > 0, "至少修改一项本地连接配置");
export const localVideoConnectionSchema = z.strictObject({ connectionId: z.literal("localComfy"), config: z.strictObject({ enabled: z.boolean(), endpoint: z.string(), backend: z.literal("comfyui"), modelFamily: z.literal("minimaxH3") }), configRevision: z.string().regex(/^[a-f0-9]{64}$/), scope: z.literal("localRuntime"), executionSupported: z.literal(false) });
export const localVideoConnectionInspectionInputSchema = z.strictObject({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(30), inspectionRevision: z.string().regex(/^[a-f0-9]{64}$/).describe("继续模型目录分页时必填；使用上一页原值，变化后从 offset 0 重读").optional() });
export const localVideoConnectionInspectionSchema = localVideoConnectionSchema.extend({
  inspectionRevision: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.string().datetime({ offset: true }), status: z.enum(["disabled", "unreachable", "incompatible", "dependenciesMissing", "dependenciesAvailable"]), reachable: z.boolean(), ready: z.boolean(), generationVerified: z.literal(false), modelLoadState: z.literal("unknown"), executionLocation: z.enum(["thisMachine", "localNetwork"]).optional(),
  system: z.strictObject({ os: z.string(), comfyVersion: z.string(), pythonVersion: z.string(), pytorchVersion: z.string(), ramTotalBytes: z.number().nonnegative(), devices: z.array(z.strictObject({ name: z.string(), type: z.string(), vramTotalBytes: z.number().nonnegative() })) }).nullable(),
  capabilities: z.array(z.strictObject({ id: z.enum(["h3Fl2va", "h3Ref2va"]), available: z.boolean(), requiredNodes: z.array(z.string()), missingNodes: z.array(z.string()), missingModelRoles: z.array(z.string()), schemaCompatible: z.boolean(), workflowBound: z.literal(false), generationVerified: z.literal(false) })),
  modelCandidates: z.array(z.strictObject({ role: z.enum(["diffusionModel", "textEncoder", "videoVae", "audioVae"]), name: z.string(), mode: z.enum(["h3Fl2va", "h3Ref2va"]).optional() })), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), hasMore: z.boolean(), nextOffset: z.number().int().nonnegative().nullable(), message: z.string().optional(), errorCode: z.string().optional(),
});

async function request(path: string, signal: AbortSignal, body?: unknown, method = "POST"): Promise<unknown> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : method, signal, headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok || value.code !== 200) {
    const details = toolErrorDetailsSchema.safeParse(value.data?.errorDetails);
    if (details.success) throw new ToolExecutionError(details.data);
    if (value.data?.code === "ESTALE") throw new ToolExecutionError({ code: "revisionConflict", message: value.message || "资源已变化", phase: "target", executionState: "notDispatched", recovery: { action: "readState", message: "重新读取对应资源的版本后提交" } });
    throw new Error(value.message || `请求失败（${response.status}）`);
  }
  return value.data;
}

export const workbenchSettingsClient = {
  async generalConfiguration(signal: AbortSignal) { return generalConfigurationSchema.parse(await request("settings/general", signal)); },
  async saveGeneralConfiguration(changes: Record<string, unknown>, expectedRevision: string, signal: AbortSignal) { return generalConfigurationSchema.parse(await request("settings/general", signal, { changes, expectedRevision }, "PUT")); },
  async plugins(signal: AbortSignal) { return z.array(pluginSchema).parse(await request("nodes/get", signal)); },
  async savePlugin(name: string, config: Record<string, unknown>, expectedRevision: string, signal: AbortSignal) { return z.object({ config: z.record(z.string(), z.json()), configRevision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await request("nodes/save", signal, { name, config, expectedRevision }, "PUT")); },
  async installPlugin(value: z.infer<typeof pluginPackageSchema>, options: { force: boolean; replaceBuiltin: boolean }, signal: AbortSignal) { return request("nodes/install", signal, { fileName: `${value.manifest.id}.js`, ...value, ...options }); },
  async uninstallPlugin(name: string, signal: AbortSignal, restoreBuiltin = false) { return request("nodes/uninstall", signal, { name, ...(restoreBuiltin ? { restoreBuiltin: true } : {}) }, "DELETE"); },
  async pluginPackage(name: string, revision: string, signal: AbortSignal) { return pluginPackageSchema.parse(await request(`nodes/package?${new URLSearchParams({ name, revision })}`, signal)); },
  async providers(signal: AbortSignal) { return z.array(mediaProviderSchema).parse(await request("providers/media/list", signal)); },
  async providerCatalog(signal: AbortSignal) { return z.array(mediaProviderSchema).parse(await request("providers/media/catalog", signal)); },
  async addProvider(source: string, signal: AbortSignal) { return mediaProviderSchema.parse(await request("providers/media/add", signal, { source })); },
  async addBuiltinProvider(builtinId: string, signal: AbortSignal) { return mediaProviderSchema.parse(await request("providers/media/add", signal, { builtinId })); },
  async fetchProviderModels(providerId: string, revision: string, signal: AbortSignal) { return mediaProviderSchema.parse(await request("providers/media/models", signal, { fileName: `${providerId}.json`, revision })); },
  async saveProviderModels(providerId: string, models: z.infer<typeof providerModelSchema>[], revision: string, signal: AbortSignal) { return mediaProviderSchema.parse(await request("providers/media/save", signal, { fileName: `${providerId}.json`, models, revision }, "PUT")); },
  async removeProvider(providerId: string, revision: string, signal: AbortSignal) { return request("providers/media/delete", signal, { fileName: `${providerId}.json`, revision }, "DELETE"); },
  async models(signal: AbortSignal) {
    const providers = await workbenchSettingsClient.providers(signal);
    return providers.map(provider => ({ id: provider.id, label: provider.label, revision: provider.revision, credentialConfigured: provider.credentialConfigured ?? null,
      models: provider.models.filter((model): model is typeof model & { type: "image" | "video" | "audio" } => model.type !== "text").map(model => ({ id: model.id, label: model.label, type: model.type })) }));
  },
  async providerConfiguration(providerId: string, signal: AbortSignal) { return providerConfigurationSchema.parse(await request(`providers/media/configuration?${new URLSearchParams({ providerId })}`, signal)); },
  async saveProviderConfiguration(providerId: string, changes: Record<string, string | number | boolean>, expectedRevision: string, signal: AbortSignal) { return providerConfigurationSchema.parse(await request("providers/media/configuration", signal, { providerId, changes, expectedRevision }, "PUT")); },
  async localVideoConnection(signal: AbortSignal) { return localVideoConnectionSchema.parse(await request("media/localConnection/get", signal)); },
  async saveLocalVideoConnection(changes: z.infer<typeof localVideoConnectionChangesSchema>, expectedRevision: string, signal: AbortSignal) { return localVideoConnectionSchema.parse(await request("media/localConnection/save", signal, { changes, expectedRevision }, "PUT")); },
  async inspectLocalVideoConnection(input: z.infer<typeof localVideoConnectionInspectionInputSchema>, signal: AbortSignal) { return localVideoConnectionInspectionSchema.parse(await request("media/localConnection/inspect", signal, input)); },
  async ffmpegStatus(signal: AbortSignal) { return ffmpegStatusSchema.parse(await request("ffmpeg/status", signal)); },
  async ffmpegConfiguration(signal: AbortSignal) { return ffmpegConfigurationSchema.parse(await request("ffmpeg/configuration", signal)); },
  async saveFfmpegConfiguration(changes: { mode?: "auto" | "download" | "system"; source?: string }, expectedRevision: string, signal: AbortSignal) { return ffmpegConfigurationSchema.parse(await request("ffmpeg/configuration", signal, { changes, expectedRevision }, "PUT")); },
  async downloadFfmpeg(source: string, signal: AbortSignal) { return ffmpegProgressSchema.parse(await request("ffmpeg/download", signal, { source })); },
  async cancelFfmpeg(signal: AbortSignal) { return ffmpegProgressSchema.parse(await request("ffmpeg/cancel", signal, {})); },
  async depthStatus(directory: string, signal: AbortSignal) { return depthSchema.parse(await request(`media/referenceDepth/modelStatus?${new URLSearchParams({ directory })}`, signal)); },
  async prepareDepth(directory: string, signal: AbortSignal) { return request("media/referenceDepth/prepareModel", signal, { directory }); },
  async cancelDepth(directory: string, signal: AbortSignal) { return request("media/referenceDepth/cancelModelPreparation", signal, { directory }); },
};

// 插件市场：静态目录 index.json 加按 SHA-256 校验的 install.json。浏览器直接下载，安装仍经本机 Go 服务完成。
export const defaultPluginMarketUrl = "https://opencinema.site/market/index.json";
export const pluginMarketEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/), name: z.string().min(1).max(200), displayName: z.record(z.string(), z.string().max(200)).optional(), version: z.string().min(1).max(64),
  description: z.record(z.string(), z.string().max(1000)), author: z.string().max(200), license: z.string().max(128), homepage: z.string().url().max(2048).optional(), repository: z.string().url().max(2048).optional(),
  tags: z.array(z.string().max(32)).max(16).default([]), scope: z.enum(["node", "workspace"]).default("node"), requires: z.record(z.string(), z.number().int().min(1)).default({}),
  url: z.string().min(1).max(2048), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(128 * 1024 ** 2), publishedAt: z.string().optional(), minHost: z.string().optional(), agentGuide: z.boolean().optional(),
});
export const pluginMarketIndexSchema = z.object({ schema: z.literal("openCinema-pluginMarket-v1"), generatedAt: z.string(), name: z.string().max(200).optional(), plugins: z.array(pluginMarketEntrySchema).max(500) });
export type PluginMarketEntry = z.infer<typeof pluginMarketEntrySchema> & { packageUrl: string };
export type PluginMarket = { url: string; generatedAt: string; name?: string; plugins: PluginMarketEntry[] };

export function pluginMarketUrlOf(general: Record<string, unknown> | undefined) {
  const value = general?.pluginMarketUrl;
  return typeof value === "string" && value.trim() ? value.trim() : defaultPluginMarketUrl;
}
function requireMarketUrl(value: string, base?: URL) {
  const url = new URL(value, base);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password) throw new Error("插件市场地址须为不含凭据的 https 地址；本机开发可用 http://127.0.0.1");
  return url;
}
async function readLimited(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("响应超过大小限制");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("响应没有正文");
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new Error("响应超过大小限制"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
const hex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");

export const pluginMarketClient = {
  async index(marketUrl: string, signal: AbortSignal): Promise<PluginMarket> {
    const url = requireMarketUrl(marketUrl);
    const response = await fetch(url, { signal, cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`插件市场目录读取失败（${response.status}）`);
    const index = pluginMarketIndexSchema.parse(JSON.parse(new TextDecoder().decode(await readLimited(response, 2 * 1024 ** 2))));
    const seen = new Set<string>();
    const plugins = index.plugins.map(entry => {
      const key = `${entry.id}@${entry.version}`;
      if (seen.has(key)) throw new Error(`插件市场目录重复：${key}`);
      seen.add(key);
      return { ...entry, packageUrl: requireMarketUrl(entry.url, url).href };
    });
    return { url: url.href, generatedAt: index.generatedAt, name: index.name, plugins };
  },
  /** 下载并校验：大小与 SHA-256 必须与目录一致，包内 id/version 必须与条目一致；任一不符即拒绝，不落盘。 */
  async download(entry: PluginMarketEntry, signal: AbortSignal) {
    const response = await fetch(entry.packageUrl, { signal, cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`插件包下载失败（${response.status}）`);
    const bytes = await readLimited(response, entry.size);
    if (bytes.byteLength !== entry.size) throw new Error("插件包大小与市场目录不一致，已拒绝");
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (sha256 !== entry.sha256) throw new Error("插件包 SHA-256 与市场目录不一致，已拒绝");
    const value = pluginPackageSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (value.manifest.id !== entry.id || value.manifest.version !== entry.version) throw new Error("插件包的 id 或版本与市场目录不一致，已拒绝");
    return { value, size: bytes.byteLength, sha256 };
  },
};
