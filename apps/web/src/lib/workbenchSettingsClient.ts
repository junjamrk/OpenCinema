import { z } from "zod";
import { missingCapabilityText, nodeRequirementsSchema } from "@toonflow/nodes-scaffold/nodeCapabilities";
import { ToolExecutionError, toolErrorDetailsSchema } from "@toonflow/nodes-scaffold/toolErrors";

const manifestFields = { displayName: z.string().optional(), author: z.string().optional(), license: z.string().optional(), homepage: z.string().optional(), tags: z.array(z.string()).optional(), agentGuide: z.string().optional(), requires: nodeRequirementsSchema.optional() };
export const pluginPackageSchema = z.object({ manifest: z.object({ id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/), apiVersion: z.literal(1), renderer: z.literal("react"), version: z.string().min(1), name: z.string().optional(), description: z.string().optional(), readme: z.string().optional(), providers: z.array(z.record(z.string(), z.json())).optional(), ...manifestFields }).passthrough(), source: z.string().min(1), assets: z.array(z.object({ path: z.string(), base64: z.string(), sha256: z.string(), mimeType: z.string() })).optional() });
export const pluginSchema = z.object({ id: z.string().optional(), name: z.string(), version: z.string().optional(), revision: z.string().optional(), previousVersion: z.string().optional(), scope: z.enum(["node", "workspace"]).optional(), builtin: z.boolean(), installed: z.boolean().optional(), enabled: z.boolean(), canConfigure: z.boolean().optional(), configRevision: z.string().regex(/^[a-f0-9]{64}$/), config: z.record(z.string(), z.json()).nullish(), configRules: z.array(z.record(z.string(), z.json())).optional(), loadError: z.string().optional(), category: z.string().optional().catch(undefined), description: z.string().optional().catch(undefined), icon: z.string().optional().catch(undefined), url: z.string().optional(), ...manifestFields });
// 这里的字段都由服务端写入，清单再坏也能读出来，用户才能在设置页看到并卸载。
const damagedPluginSchema = z.object({ name: z.string(), displayName: z.string().optional().catch(undefined), version: z.string().optional().catch(undefined), revision: z.string().optional().catch(undefined), builtin: z.boolean(), installed: z.boolean().optional(), enabled: z.boolean(), configRevision: pluginSchema.shape.configRevision, url: z.string().optional().catch(undefined) });
const depthSchema = z.object({ available: z.boolean(), runtimeAvailable: z.boolean(), mediaToolsAvailable: z.boolean().optional(), message: z.string(), phase: z.string().optional(), preparationProgress: z.object({ phase: z.string(), received: z.number(), total: z.number(), error: z.string().optional() }).nullable().optional() });
const providerConfigurationSchema = z.object({ providerId: z.string(), rules: z.array(z.record(z.string(), z.json())), config: z.record(z.string(), z.json()), credentialConfigured: z.record(z.string(), z.boolean()), configRevision: z.string().regex(/^[a-f0-9]{64}$/), scope: z.string() });
export const providerModelSchema = z.object({ id: z.string().min(1).max(256), label: z.string().min(1).max(200), type: z.enum(["image", "video", "audio", "text"]) }).catchall(z.json());
export const mediaProviderSchema = z.object({ id: z.string(), label: z.string(), fileName: z.string(), revision: z.string(), version: z.string().optional(), rules: z.array(z.record(z.string(), z.json())).optional(), modelsUrl: z.string().optional(), models: z.array(providerModelSchema), credentialConfigured: z.boolean().optional(), loadError: z.string().optional() }).catchall(z.json());
export const ffmpegConfigurationSchema = z.object({ config: z.object({ mode: z.enum(["auto", "download", "system"]), source: z.string() }), configRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export const ffmpegProgressSchema = z.object({ phase: z.string(), received: z.number(), total: z.number().optional(), file: z.string().optional(), error: z.string().optional() });
export const ffmpegStatusSchema = z.object({ platform: z.string(), arch: z.string(), target: z.string(), supported: z.boolean(), directory: z.string(), version: z.string().optional(), sources: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean(), description: z.string().optional(), homepage: z.string().optional() })), config: z.object({ mode: z.string().optional(), source: z.string().optional() }), tools: z.record(z.string(), z.object({ path: z.string(), source: z.string(), version: z.string().optional(), error: z.string().nullable() })), download: ffmpegProgressSchema });
const generalConfigurationSchema = z.object({ general: z.record(z.string(), z.json()), configRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export const localVideoConnectionChangesSchema = z.strictObject({ enabled: z.boolean().optional(), endpoint: z.string().trim().url().max(2048).describe("HTTP(S) 地址，显式端口；仅 localhost、环回 IP 或私有局域网 IP，可带固定路径前缀，不含凭据、查询或锚点，例如 http://127.0.0.1:8188").optional() }).refine(value => Object.keys(value).length > 0, "至少修改一项本地连接配置");
export const localVideoConnectionSchema = z.strictObject({ connectionId: z.literal("localComfy"), config: z.strictObject({ enabled: z.boolean(), endpoint: z.string(), backend: z.literal("comfyui") }), configRevision: z.string().regex(/^[a-f0-9]{64}$/), scope: z.literal("localRuntime"), executionSupported: z.literal(true) });
export const localVideoConnectionInspectionInputSchema = z.strictObject({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) });
export const localVideoConnectionInspectionSchema = localVideoConnectionSchema.extend({
  observedAt: z.string().datetime({ offset: true }), status: z.enum(["disabled", "unreachable", "incompatible", "dependenciesMissing", "ready"]), reachable: z.boolean(), ready: z.boolean(), executionLocation: z.enum(["thisMachine", "localNetwork"]).optional(),
  system: z.strictObject({ os: z.string(), comfyVersion: z.string(), pythonVersion: z.string(), pytorchVersion: z.string(), ramTotalBytes: z.number().nonnegative(), devices: z.array(z.strictObject({ name: z.string(), type: z.string(), vramTotalBytes: z.number().nonnegative() })) }).nullable(),
  workflows: z.array(z.strictObject({ modelId: z.string(), label: z.string(), type: z.enum(["image", "video", "audio"]), missingNodes: z.array(z.string()) })), message: z.string().optional(), errorCode: z.string().optional(),
});

const zodIssueText: Record<string, string> = { invalid_type: "类型不正确", invalid_key: "键名不符合规则", invalid_value: "取值不在允许范围内", invalid_format: "格式不正确", too_big: "过长或过大", too_small: "过短或过小", unrecognized_keys: "含有未声明的字段" };
export function pluginErrorText(error: unknown) {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  return `插件声明不符合要求：${error.issues.slice(0, 4).map(issue => `${issue.path.join(".") || "声明"} ${zodIssueText[issue.code] ?? issue.message}`).join("；")}`;
}
export function parsePluginPackage(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("插件包不是有效的 JSON 文件"); }
  const parsed = pluginPackageSchema.safeParse(value);
  if (!parsed.success) throw new Error(pluginErrorText(parsed.error));
  return parsed.data;
}
function parsePluginCatalog(value: unknown): z.infer<typeof pluginSchema>[] {
  return z.array(z.unknown()).parse(value).flatMap(item => {
    const parsed = pluginSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    const damaged = damagedPluginSchema.safeParse(item);
    return damaged.success ? [{ ...damaged.data, loadError: pluginErrorText(parsed.error) }] : [];
  });
}

// ACT: 按数字段比较，不处理预发布版本，1.0.0-beta 与 1.0.0 的先后不保证；市场开始发预发布版本时换成完整的 semver 解析。
export function compareVersions(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true });
}
export function missingCapabilities(requires: Record<string, number>, provided: Readonly<Record<string, number>>) {
  return Object.entries(requires).flatMap(([name, requiredVersion]) => (provided[name] ?? 0) < requiredVersion ? [{ name, requiredVersion, providedVersion: provided[name] ?? 0 }] : []);
}
/** 不能安装的原因；空数组表示兼容。读不到 hostVersion 时跳过 minHost，能力缺失仍会由运行时报告。 */
export function pluginIncompatibility(plugin: { requires?: Record<string, number>; minHost?: string }, provided: Readonly<Record<string, number>>, hostVersion?: string) {
  return [
    ...(plugin.minHost && hostVersion && compareVersions(hostVersion, plugin.minHost) < 0 ? [`需要工作台 ${plugin.minHost} 或更新，当前是 ${hostVersion}`] : []),
    ...missingCapabilities(plugin.requires ?? {}, provided).map(item => missingCapabilityText(item.name, item.requiredVersion, item.providedVersion)),
  ];
}

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
  async plugins(signal: AbortSignal) { return parsePluginCatalog(await request("nodes/get", signal)); },
  async hostVersion(signal: AbortSignal) { return z.object({ hostVersion: z.string() }).parse(await request("nodes/capabilities", signal)).hostVersion; },
  async savePlugin(name: string, config: Record<string, unknown>, expectedRevision: string, signal: AbortSignal) { return z.object({ config: z.record(z.string(), z.json()), configRevision: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await request("nodes/save", signal, { name, config, expectedRevision }, "PUT")); },
  async installPlugin(value: z.infer<typeof pluginPackageSchema>, options: { force: boolean; replaceBuiltin: boolean }, signal: AbortSignal) { return request("nodes/install", signal, { fileName: `${value.manifest.id}.js`, ...value, ...options }); },
  async uninstallPlugin(name: string, signal: AbortSignal, restoreBuiltin = false) { return request("nodes/uninstall", signal, { name, ...(restoreBuiltin ? { restoreBuiltin: true } : {}) }, "DELETE"); },
  async rollbackPlugin(name: string, signal: AbortSignal) { return request("nodes/rollback", signal, { name }); },
  async pluginPackage(name: string, revision: string, signal: AbortSignal) { return pluginPackageSchema.parse(await request(`nodes/package?${new URLSearchParams({ name, revision })}`, signal)); },
  async providers(signal: AbortSignal) { return z.array(mediaProviderSchema).parse(await request("providers/media/list", signal)); },
  async providerCatalog(signal: AbortSignal) { return z.array(mediaProviderSchema).parse(await request("providers/media/catalog", signal)); },
  async addProvider(source: string, signal: AbortSignal) { return mediaProviderSchema.parse(await request("providers/media/add", signal, { source })); },
  async validateProvider(source: string, signal: AbortSignal) { return mediaProviderSchema.parse(await request("providers/media/validate", signal, { source })); },
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
  description: z.record(z.string(), z.string().max(1000)), author: z.string().max(200), license: z.string().max(128), homepage: z.url({ protocol: /^https?$/ }).max(2048).optional(), repository: z.url({ protocol: /^https?$/ }).max(2048).optional(),
  tags: z.array(z.string().max(32)).max(16).default([]), scope: z.enum(["node", "workspace"]).default("node"), requires: z.record(z.string(), z.number().int().min(1)).default({}),
  url: z.string().min(1).max(2048), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(128 * 1024 ** 2), publishedAt: z.string().optional(), minHost: z.string().optional(), agentGuide: z.boolean().optional(),
});
// 条目逐条解析：一条坏记录只跳过它自己，不让所有人的市场失效。
export const pluginMarketIndexSchema = z.object({ schema: z.literal("openCinema-pluginMarket-v1"), generatedAt: z.string(), name: z.string().max(200).optional(), plugins: z.array(z.unknown()).max(500) });
export type PluginMarketEntry = z.infer<typeof pluginMarketEntrySchema> & { packageUrl: string };
export type PluginMarket = { url: string; generatedAt: string; name?: string; plugins: PluginMarketEntry[]; skipped: number };

export function pluginMarketUrlOf(general: Record<string, unknown> | undefined) {
  const value = general?.pluginMarketUrl;
  return typeof value === "string" && value.trim() ? value.trim() : defaultPluginMarketUrl;
}
export function parseUrl(value: string, base?: URL) {
  try { return new URL(value, base); } catch { return undefined; }
}
function requireMarketUrl(value: string, base?: URL) {
  const url = parseUrl(value, base);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url?.hostname ?? "");
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password) throw new Error("插件市场地址须为不含凭据的 https 地址；本机开发可用 http://127.0.0.1");
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
    const response = await fetch(url, { signal, cache: "no-store", headers: { Accept: "application/json" } }).catch(error => { throw signal.aborted ? error : new Error(`无法连接插件市场 ${url.host}，请检查网络后重试`); });
    if (!response.ok) throw new Error(`插件市场目录读取失败（${response.status}）`);
    const text = new TextDecoder().decode(await readLimited(response, 2 * 1024 ** 2));
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    const result = pluginMarketIndexSchema.safeParse(parsed);
    if (!result.success) throw new Error("插件市场目录格式无效");
    const index = result.data;
    const seen = new Set<string>();
    const plugins = index.plugins.flatMap(raw => {
      const parsed = pluginMarketEntrySchema.safeParse(raw);
      if (!parsed.success) return [];
      const entry = parsed.data, key = `${entry.id}@${entry.version}`;
      if (seen.has(key)) return [];
      seen.add(key);
      try { return [{ ...entry, packageUrl: requireMarketUrl(entry.url, url).href }]; } catch { return []; }
    });
    return { url: url.href, generatedAt: index.generatedAt, name: index.name, plugins, skipped: index.plugins.length - plugins.length };
  },
  /** 下载并校验：大小与 SHA-256 必须与目录一致，包内 id/version 必须与条目一致；任一不符即拒绝，不落盘。 */
  async download(entry: PluginMarketEntry, signal: AbortSignal) {
    const response = await fetch(entry.packageUrl, { signal, cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`插件包下载失败（${response.status}）`);
    const bytes = await readLimited(response, entry.size);
    if (bytes.byteLength !== entry.size) throw new Error("插件包大小与市场目录不一致，已拒绝");
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    if (sha256 !== entry.sha256) throw new Error("插件包 SHA-256 与市场目录不一致，已拒绝");
    const value = parsePluginPackage(new TextDecoder().decode(bytes));
    if (value.manifest.id !== entry.id || value.manifest.version !== entry.version) throw new Error("插件包的 id 或版本与市场目录不一致，已拒绝");
    return { value, size: bytes.byteLength, sha256 };
  },
};
