import { z } from "zod";
import { ToolExecutionError, toolErrorDetailsSchema } from "@toonflow/nodes-scaffold/toolErrors";

export const pluginPackageSchema = z.object({ manifest: z.object({ id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/), apiVersion: z.literal(1), renderer: z.literal("react"), version: z.string().min(1), name: z.string().optional() }).passthrough(), source: z.string().min(1), assets: z.array(z.object({ path: z.string(), base64: z.string(), sha256: z.string(), mimeType: z.string() })).optional() });
export const pluginSchema = z.object({ id: z.string().optional(), name: z.string(), displayName: z.string().optional(), version: z.string().optional(), revision: z.string().optional(), scope: z.enum(["node", "workspace"]).optional(), builtin: z.boolean(), installed: z.boolean().optional(), enabled: z.boolean(), canConfigure: z.boolean().optional(), configRevision: z.string().regex(/^[a-f0-9]{64}$/), config: z.record(z.string(), z.json()).nullish(), configRules: z.array(z.record(z.string(), z.json())).optional(), loadError: z.string().optional() });
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
