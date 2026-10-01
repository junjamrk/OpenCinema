import { z } from "zod";
import { nodeRequirementsSchema } from "./nodeCapabilities";
import { createNodeResources, nodeResourceManifestSchema } from "./nodeResources";
import { ToolExecutionError, serializeToolError, toolAnnotationsSchema } from "./toolErrors";
import type {
  NodePluginDefinition, PluginActivation, PluginActivationContext, PluginInstance, PluginModule, PluginRenderer,
  PluginSource, PluginToolCall, PluginToolDefinition, PluginToolInfo, RuntimeCapabilities,
} from "./contracts";

export type PluginRuntimeOptions<View = unknown> = {
  capabilities: RuntimeCapabilities;
  renderer?: PluginRenderer;
  services?: Readonly<Record<string, unknown>>;
  loadModule?(url: string): Promise<PluginModule<View>>;
  toolTimeoutMs?: number;
};

type InstanceRecord<View> = {
  value: PluginInstance<View>;
  definition: NodePluginDefinition<View>;
  controller: AbortController;
  tools: Map<string, { definition: PluginToolDefinition; info: PluginToolInfo }>;
  cleanups: Set<() => void | Promise<void>>;
  preflights: Set<(operation: "history" | "delete") => void | Promise<void>>;
};

const pluginIdentitySchema = z.strictObject({
  apiVersion: z.literal(1),
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  version: z.string().min(1).max(128),
});
const toolNameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/);
const composerStateSchema = z.strictObject({ requiresHost: z.boolean().default(true), disabledReason: z.string().trim().min(1).max(512).optional() });

export function getComposerState(composer: NodePluginDefinition["composer"], data: Readonly<Record<string, unknown>>) {
  try {
    return composerStateSchema.parse(composer?.getState ? composer.getState(Object.freeze(structuredClone(data))) : {});
  } catch {
    return { requiresHost: true, disabledReason: "节点创作状态暂不可用，请重新选择节点" };
  }
}

async function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createPluginRuntime<View = unknown>(options: PluginRuntimeOptions<View>) {
  const capabilities = Object.freeze(nodeRequirementsSchema.parse(options.capabilities));
  const definitions = new Map<string, NodePluginDefinition<View>>();
  const instances = new Map<string, InstanceRecord<View>>();
  const pending = new Map<string, { pluginId: string; controller: AbortController; done: Promise<void> }>();
  const disabled = new Set<string>();
  const lifetime = new AbortController();
  let version = 0;
  const toolTimeoutMs = options.toolTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs <= 0) throw new Error("工具超时必须为正整数");

  function validateDefinition(definition: NodePluginDefinition<View>) {
    if (!definition || typeof definition !== "object") throw new Error("插件模块缺少 default 导出");
    pluginIdentitySchema.parse({ apiVersion: definition.apiVersion, id: definition.id, name: definition.name, version: definition.version });
    const requires = nodeRequirementsSchema.parse(definition.requires ?? {});
    z.enum(["node", "workspace"]).optional().parse(definition.scope);
    z.strictObject({ label: z.string().trim().min(1).max(80), placeholder: z.string().trim().min(1).max(256), tool: toolNameSchema, maxLength: z.number().int().min(1).max(100000).optional(), defaultAction: z.boolean().optional(), getState: z.custom<NonNullable<NodePluginDefinition["composer"]>["getState"]>(value => typeof value === "function").optional() }).optional().parse(definition.composer);
    for (const [name, version] of Object.entries(requires)) {
      if ((capabilities[name] ?? 0) < version) throw new Error(`插件 ${definition.id} 需要能力 ${name}@${version}`);
    }
    if (definition.view !== undefined && (!definition.renderer || !options.renderer || definition.renderer !== options.renderer)) {
      throw new Error(`插件 ${definition.id} 的 ${definition.renderer ?? "未声明"} 视图不能由 ${options.renderer ?? "无视图"} 运行时加载`);
    }
    if (definition.activate !== undefined && typeof definition.activate !== "function") throw new Error("插件 activate 必须是函数");
    if (definition.createData !== undefined && typeof definition.createData !== "function") throw new Error("插件 createData 必须是函数");
    if (definition.cloneData !== undefined && typeof definition.cloneData !== "function") throw new Error("插件 cloneData 必须是函数");
    if (definition.canConnect !== undefined && typeof definition.canConnect !== "function") throw new Error("插件 canConnect 必须是函数");
    if (definition.resources) {
      const manifest = nodeResourceManifestSchema.parse(definition.resources.manifest);
      if (!definition.resources.content || typeof definition.resources.content !== "object") throw new Error("插件资源缺少内容");
      if (Object.keys(definition.resources.content).some(name => !Object.hasOwn(manifest, name))) throw new Error("插件资源包含未声明内容");
      for (const name of Object.keys(manifest)) {
        const content = definition.resources.content[name];
        if (typeof content !== "string" || content.length > 20 * 1024 ** 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error(`插件资源内容无效：${name}`);
      }
    }
    const names = new Set<string>();
    for (const tool of definition.tools ?? []) {
      validateTool(tool);
      if (names.has(tool.name)) throw new Error(`插件工具重名：${tool.name}`);
      names.add(tool.name);
    }
    return definition;
  }

  function validateTool(definition: PluginToolDefinition) {
    toolNameSchema.parse(definition.name);
    if (!definition.description?.trim() || typeof definition.execute !== "function") throw new Error("插件工具需要描述和 execute");
    const inputSchema = z.toJSONSchema(definition.parameters, { io: "input", target: "draft-07" });
    if (inputSchema.type !== "object") throw new Error("插件工具必须使用 Zod 对象参数");
    const outputSchema = definition.outputSchema ? z.toJSONSchema(definition.outputSchema, { io: "output", target: "draft-07" }) : undefined;
    const annotations = definition.annotations ? toolAnnotationsSchema.parse(definition.annotations) : undefined;
    return { inputSchema, ...(outputSchema ? { outputSchema } : {}), ...(annotations ? { annotations } : {}) };
  }

  function register(definition: NodePluginDefinition<View>) {
    lifetime.signal.throwIfAborted();
    validateDefinition(definition);
    // ACT: 更新先登记候选版本，旧实例持有原定义；新实例激活成功后才替换，失败不破坏旧工程。
    definitions.set(definition.id, definition);
    disabled.delete(definition.id);
    version++;
    return definition;
  }

  async function load(source: PluginSource<View>, signal?: AbortSignal, expectedId?: string) {
    const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const module = await waitFor(Promise.resolve().then(() => {
      if (typeof source === "function") return source();
      const url = String(source);
      if (!url.trim()) throw new Error("插件模块地址不能为空");
      return options.loadModule ? options.loadModule(url) : import(/* @vite-ignore */ url) as Promise<PluginModule<View>>;
    }), combined);
    if (expectedId && module.default?.id !== expectedId) throw new Error("插件模块 ID 与节点类型不一致");
    return register(module.default);
  }

  async function cleanup(record: InstanceRecord<View>, reason: unknown) {
    record.controller.abort(reason);
    record.tools.clear();
    version++;
    const errors: unknown[] = [];
    for (const dispose of [...record.cleanups].reverse()) {
      record.cleanups.delete(dispose);
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `插件实例 ${record.value.instanceId} 清理失败`);
  }

  async function activate(pluginId: string, input: { instanceId: string; nodeId?: string; config?: Record<string, unknown>; services?: Readonly<Record<string, unknown>>; signal?: AbortSignal }) {
    lifetime.signal.throwIfAborted();
    if (!input.instanceId?.trim()) throw new Error("插件实例 ID 不能为空");
    const definition = definitions.get(pluginId);
    if (!definition || disabled.has(pluginId)) throw new Error(`插件未加载或已停用：${pluginId}`);
    if (pending.has(input.instanceId)) throw new Error(`插件实例正在激活：${input.instanceId}`);
    const existing = instances.get(input.instanceId);
    if (existing && existing.value.pluginId !== pluginId) throw new Error("插件实例 ID 已被其他插件使用");
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const record: InstanceRecord<View> = {
      value: { pluginId, instanceId: input.instanceId, nodeId: input.nodeId, version: definition.version, renderer: definition.renderer, view: definition.view, service: undefined, signal },
      definition, controller, tools: new Map(), cleanups: new Set(), preflights: new Set(),
    };
    const resources = createNodeResources(definition.resources, signal);
    const config = Object.freeze(z.record(z.string(), z.unknown()).parse(input.config ?? {}));
    let finish = () => {};
    const done = new Promise<void>(resolve => { finish = resolve; });
    pending.set(input.instanceId, { pluginId, controller, done });
    const cancelActivation = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", cancelActivation, { once: true });
    if (input.signal?.aborted) cancelActivation();
    const context: PluginActivationContext = {
      signal, instanceId: input.instanceId, nodeId: input.nodeId,
      config, capabilities, resources,
      getService<T>(name: string) {
        signal.throwIfAborted();
        if (Object.hasOwn(input.services ?? {}, name)) return input.services![name] as T;
        if (!Object.hasOwn(options.services ?? {}, name)) throw new Error(`宿主未提供服务：${name}`);
        return options.services![name] as T;
      },
      registerTool(tool) {
        signal.throwIfAborted();
        const metadata = validateTool(tool);
        if (record.tools.has(tool.name)) throw new Error(`插件工具重名：${tool.name}`);
        const entry = { definition: Object.freeze({ ...tool }) as PluginToolDefinition, info: {
          pluginId, instanceId: input.instanceId, nodeId: input.nodeId, name: tool.name, description: tool.description.trim(), ...(definition.requires ? { requires: { ...definition.requires } } : {}), ...metadata,
        } };
        record.tools.set(tool.name, entry);
        version++;
        return () => { if (record.tools.get(tool.name) === entry) { record.tools.delete(tool.name); version++; } };
      },
      onDispose(dispose) {
        signal.throwIfAborted();
        record.cleanups.add(dispose);
        return () => { record.cleanups.delete(dispose); };
      },
      onBeforeChange(prepare) {
        signal.throwIfAborted(); record.preflights.add(prepare);
        return () => { record.preflights.delete(prepare); };
      },
    };
    let activation: PluginActivation | void;
    try {
      signal.throwIfAborted();
      for (const tool of definition.tools ?? []) context.registerTool(tool);
      const started = Promise.resolve().then(() => definition.activate?.(context));
      // 不遵守 signal 的第三方激活仍需在迟到完成后释放服务，不能遗留 Worker 或监听器。
      void started.then(result => {
        if (signal.aborted && result?.dispose) return result.dispose();
      }).catch(() => {});
      activation = await waitFor(started, signal);
      if (activation?.dispose) record.cleanups.add(activation.dispose.bind(activation));
      record.value = Object.freeze({ ...record.value, service: activation?.service });
      signal.throwIfAborted();
      if (definitions.get(pluginId) !== definition || disabled.has(pluginId)) throw new Error("插件在激活期间已更新或停用");
      instances.set(input.instanceId, record);
      version++;
      if (existing) await cleanup(existing, new Error("插件实例已更新"));
      return record.value;
    } catch (error) {
      // 新实例已就绪后，旧实例清理错误不能回滚到已取消的旧服务。
      if (instances.get(input.instanceId) === record) throw error;
      await cleanup(record, error).catch(cleanupError => { throw new AggregateError([error, cleanupError], "插件激活与清理失败"); });
      throw error;
    } finally {
      pending.delete(input.instanceId);
      input.signal?.removeEventListener("abort", cancelActivation);
      finish();
    }
  }

  function listTools(instanceIds?: readonly string[]): PluginToolInfo[] {
    const records = instanceIds ? [...new Set(instanceIds)].flatMap(id => instances.get(id) ?? []) : [...instances.values()];
    return records.flatMap(record => [...record.tools.values()].map(entry => structuredClone(entry.info)));
  }

  async function callTool(call: PluginToolCall, signal?: AbortSignal) {
    const record = instances.get(call.instanceId);
    const entry = record?.tools.get(call.name);
    const target = { instanceId: call.instanceId, toolName: call.name, ...(record ? { pluginId: record.value.pluginId, nodeId: record.value.nodeId } : {}) };
    if (!record || !entry) throw new ToolExecutionError({ code: "toolUnavailable", message: "工具不存在或插件已停用，请重新发现工具", phase: "target", target,
      executionState: "notDispatched", toolCatalogVersion: version, recovery: { action: "rediscoverTools", message: "重新发现当前节点或工作区插件工具" } });
    const combined = AbortSignal.any([record.value.signal, AbortSignal.timeout(toolTimeoutMs), ...(signal ? [signal] : [])]);
    let dispatched = false;
    try {
      return await waitFor(Promise.resolve().then(async () => {
        let args: unknown;
        try { args = await entry.definition.parameters.parseAsync(call.args); }
        catch (error) { throw new ToolExecutionError(serializeToolError(error, { target, phase: "validation", executionState: "notDispatched" })); }
        combined.throwIfAborted();
        if (instances.get(call.instanceId) !== record || record.tools.get(call.name) !== entry) throw new ToolExecutionError({ code: "toolCatalogChanged", message: "插件工具已变更，请重新发现工具", phase: "target", target,
          executionState: "notDispatched", toolCatalogVersion: version, recovery: { action: "rediscoverTools", message: "重新发现工具目录后使用最新 Schema 调用" } });
        dispatched = true;
        const result = await entry.definition.execute(args, { signal: combined, instanceId: call.instanceId, nodeId: record.value.nodeId });
        combined.throwIfAborted();
        if (!entry.definition.outputSchema) return result ?? null;
        try { return await entry.definition.outputSchema.parseAsync(result); }
        catch { throw new ToolExecutionError({ code: "invalidToolResult", message: "插件工具结果不符合公布的输出 Schema", phase: "result", target,
          executionState: "completed", recovery: { action: "readState", message: "执行已返回，请读取当前目标与任务产物；不要自动重复有副作用的调用" } }); }
      }), combined);
    } catch (error) {
      throw new ToolExecutionError(serializeToolError(error, { target, executionState: dispatched ? "unknown" : "notDispatched" }));
    }
  }

  async function deactivate(instanceId: string) {
    const activating = pending.get(instanceId);
    activating?.controller.abort(new Error("插件实例已停用"));
    const record = instances.get(instanceId);
    if (record) instances.delete(instanceId);
    try { if (record) await cleanup(record, new Error("插件实例已停用")); }
    finally { await activating?.done; }
  }

  async function disable(pluginId: string) {
    disabled.add(pluginId);
    version++;
    const ids = new Set([
      ...[...pending].filter(([, entry]) => entry.pluginId === pluginId).map(([id]) => id),
      ...[...instances.values()].filter(record => record.value.pluginId === pluginId).map(record => record.value.instanceId),
    ]);
    const results = await Promise.allSettled([...ids].map(deactivate));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, `插件 ${pluginId} 停用失败`);
  }

  async function unload(pluginId: string) {
    try { await disable(pluginId); } finally { definitions.delete(pluginId); version++; }
  }

  async function dispose() {
    lifetime.abort(new Error("插件运行时已关闭"));
    const results = await Promise.allSettled([...new Set([...instances.keys(), ...pending.keys()])].map(deactivate));
    definitions.clear();
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "插件运行时清理失败");
  }

  return {
    register, load, activate, deactivate, disable, unload, dispose, listTools, callTool,
    async prepareChange(instanceId: string, operation: "history" | "delete") {
      const record = instances.get(instanceId);
      if (!record) return;
      for (const prepare of record.preflights) {
        record.value.signal.throwIfAborted(); await prepare(operation);
        if (instances.get(instanceId) !== record) throw new Error("插件实例已切换，请重新提交操作");
      }
    },
    getVersion: () => version,
    getCapabilities: () => capabilities,
    getToolCount: () => [...instances.values()].reduce((total, record) => total + record.tools.size, 0),
    getInstance: (instanceId: string) => instances.get(instanceId)?.value,
    list: () => [...definitions.values()].map(definition => ({ id: definition.id, name: definition.name, version: definition.version, renderer: definition.renderer, enabled: !disabled.has(definition.id) })),
  };
}
