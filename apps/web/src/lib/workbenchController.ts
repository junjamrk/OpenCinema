import { createElement, type ComponentType } from "react";
import { z } from "zod";
import { graphlib, layout } from "@dagrejs/dagre";
import { createDocumentSession, parseCanvasDocument, parseDocumentCommand, type CanvasDocument, type CanvasNode, type DocumentSession } from "@toonflow/workbench-core";
import { createPluginRuntime, getComposerState } from "@toonflow/nodes-scaffold/pluginRuntime";
import { ToolExecutionError } from "@toonflow/nodes-scaffold/toolErrors";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";
import { hostCapabilityVersions, nodeRequirementsSchema } from "@toonflow/nodes-scaffold/nodeCapabilities";
import type { HostAdapter, HostContext, HostToolProvider, NodePluginDefinition, PluginInstance, PluginModule, PluginSource } from "@toonflow/nodes-scaffold/contracts";
import type { NodeDocumentService } from "@toonflow/nodes-scaffold/react";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import type { WorkspaceCanvas } from "@toonflow/nodes-scaffold/workspaceDocuments";
import { getSourceValue, getTargetValues, type PortNode, type PortEdge } from "@toonflow/nodes-scaffold/nodePortValues";
import { canvasOperations, canvasSchemas } from "@toonflow/tool-canvas/runtime";
import { nodeId, revisionSchema, textSchema, connectionSchema, connectionEndpointSchema, workspaceToolSchemas, peripheralToolSchemas, uiSchemas, additionalCanvasOperations, listWorkbenchTools, validateWorkbenchToolResult } from "./workbenchTools";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { createWorkspaceFiles } from "./workspaceFileClient";
import { createNodeWorkbench } from "./nodeWorkbench";
import { createWorkspaceSession, type WorkspaceSession } from "./workspaceSession";
import { createCanvasManager, discoverWorkspaceCanvases } from "./workspaceCanvasManager";
import { inferMediaFileType } from "./mediaFileTypes";
import { createInstalledPluginLoader } from "./installedPluginLoader";
import { localApiUrl } from "./openCinemaTransport";
import { assetLibraryClient, assetMediaKind, type AssetLibraryEntry } from "./assetLibraryClient";
import { builtinNodes } from "./builtinNodes";
import { pluginMarketClient, pluginMarketUrlOf, pluginPackageSchema, workbenchSettingsClient } from "./workbenchSettingsClient";
import { isNodeOutput } from "@toonflow/nodes-scaffold/values";
import { canvasNodePosition, createCanvasQueries, isCanvasRead, type CanvasQueryAvailability, type CanvasQueryRuntime } from "@/lib/canvasQueries";
import { copyNodesToClipboard, readClipboardNodes } from "@/lib/nodeClipboard";
import { writeClipboardImage } from "@/lib/clipboard";
import type { WorkbenchController, WorkbenchNodeViewProps, WorkbenchSnapshot } from "@/workbench/types";

type View = ComponentType<WorkbenchNodeViewProps>;
type TextDraft = { text: string; session: DocumentSession };
type PluginDetails = { category?: string; description?: string; icon?: string };
type NodePluginError = { pluginId: string; message: string; definition?: NodePluginDefinition<View> };
const builtinPlugins = builtinNodes as unknown as Record<string, PluginDetails & { displayName: string; scope: "node" | "workspace"; load(): Promise<PluginModule<View>> }>;
const relativePath = z.string().min(1).max(4096).refine(value => !/^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(value)
  && !value.includes("\0") && value.replaceAll("\\", "/").split("/").every(part => !!part && part !== "." && part !== ".."), "路径必须位于工作区内");

function installedPluginUrl(source: string) {
  const url = localApiUrl(source);
  if (!url || !(url.pathname === "/api/nodes/files" || /^\/api\/nodes\/modules\/[a-z][a-zA-Z0-9]{0,95}\/[a-f0-9]{64}\/index\.js$/.test(url.pathname))) throw new Error("已安装插件地址必须来自本机插件目录");
  return url;
}
const { webAssembly, worker, ...alwaysProvided } = hostCapabilityVersions;
const supportedCanvas = new Set<string>([...canvasOperations, ...additionalCanvasOperations].map(tool => tool.name));

export function createWorkbenchController() {
  const listeners = new Set<() => void>();
  const composerListeners = new Set<Parameters<WorkbenchController["attachComposer"]>[0]>();
  const drafts = new Map<string, TextDraft>();
  const pendingText = new Map<TextDraft, Promise<void>>();
  const pendingSaves = new Map<DocumentSession, Promise<void>>();
  const views = new Map<string, View>();
  const activated = new Map<string, NodePluginDefinition<View>>();
  const activatedConfigs = new Map<string, string>();
  const definitions = new Map<string, NodePluginDefinition<View>>();
  const pluginLabels = new Map(Object.entries(builtinPlugins).map(([id, item]) => [id, item.displayName]));
  const pluginDetails = new Map<string, PluginDetails>(Object.entries(builtinPlugins));
  const disabledPlugins = new Set<string>();
  const loadingPlugins = new Map<string, Promise<NodePluginDefinition<View>>>();
  const pluginSources = new Map<string, string>();
  const pluginConfigs = new Map<string, Record<string, unknown>>();
  const pluginRequirements = new Map<string, Record<string, number>>();
  const pluginScopes = new Map<string, "node" | "workspace">();
  const moduleErrors = new Map<string, string>();
  const nodeErrors = new Map<string, NodePluginError>();
  const workbenches = new Map<string, NodeWorkbenchService>();
  const workspacePlugins = new Map<string, NodePluginDefinition<View>>();
  const workspaceStates = new Map<string, Map<string, unknown>>();
  const workspaceSubscriptions = new Map<string, () => void>();
  const preflighting = new Set<string>();
  const controllerLifetime = new AbortController();
  let session: DocumentSession | undefined;
  let workspace: WorkspaceSession | undefined;
  let releaseDocument: (() => void) | undefined;
  let releaseSession: (() => void) | undefined;
  let host: HostAdapter | undefined;
  let releaseHost: (() => void) | undefined;
  let transition = Promise.resolve();
  let pluginQueue = Promise.resolve();
  let catalogQueue = Promise.resolve();
  let textQueue = Promise.resolve();
  let lifetime = new AbortController();
  let disposed = false;
  let transitioning = false;
  let readOnly = false;
  let queryRevision = 0;
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let ready: Promise<void>;
  let canvasView: Parameters<WorkbenchController["attachCanvasView"]>[0] | undefined;
  const nodeEditorViews = new Map<string, { adapter: Parameters<WorkbenchController["attachNodeEditorView"]>[1]; session: DocumentSession }>();
  let snapshot: WorkbenchSnapshot = {
    document: null, directory: null, canvasId: null, revision: 0, dirty: false, saving: false, error: null,
    canUndo: false, canRedo: false, readOnly: false, transitioning: false, projectName: "", canvasFiles: [], canvasFolders: [], plugins: [],
    host: { name: "未连接宿主", connected: false, canSend: false }, selectedIds: [], workspacePlugins: [],
  };
  const runtime = createPluginRuntime<View>({ loadModule: createInstalledPluginLoader(controllerLifetime.signal) as (source: string) => Promise<PluginModule<View>>, capabilities: { ...alwaysProvided, ...(typeof WebAssembly === "object" ? { webAssembly } : {}), ...(typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function" ? { worker } : {}) }, renderer: "react" });

  function publish(patch: Partial<WorkbenchSnapshot> = {}) {
    const current = session?.getSnapshot();
    if (current && snapshot.document !== current.document) queryRevision++;
    const ids = new Set(current?.document.nodes.map(node => node.id) ?? []);
    snapshot = { ...snapshot, ...(current ? {
      document: current.document, revision: current.revision, dirty: current.dirty || [...drafts.values()].some(draft => draft.session === session),
      saving: current.saving || pendingText.size > 0,
      canUndo: workspace?.provider ? workspace.provider.canHistory(current.canvasId, "undo") : current.canUndo,
      canRedo: workspace?.provider ? workspace.provider.canHistory(current.canvasId, "redo") : current.canRedo,
      readOnly: current.readOnly, selectedIds: snapshot.selectedIds.filter(id => ids.has(id)),
      error: current.saveError ?? snapshot.error,
    } : { readOnly }), transitioning, ...patch };
    for (const listener of listeners) listener();
  }
  function report(error: unknown) { publish({ error: error instanceof Error ? error.message : String(error) }); }
  async function waitForNode<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort = () => {};
    try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); })]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  async function prepareNodes(ids: string[], operation: "beforeHistory" | "beforeDelete") {
    for (const id of ids) {
      const service = runtime.getInstance(id)?.service as Partial<Record<typeof operation, () => Promise<void>>> | undefined;
      preflighting.add(id);
      try { await service?.[operation]?.(); await runtime.prepareChange(id, operation === "beforeHistory" ? "history" : "delete"); }
      finally { preflighting.delete(id); }
    }
  }
  async function prepareCanvasSwitch(target: DocumentSession) {
    requireSession(target);
    if (!target.getSnapshot().readOnly) await prepareNodes(target.getSnapshot().document.nodes.map(node => node.id), "beforeHistory");
    await saveSession(target); requireSession(target);
  }
  function scheduleSave(target: DocumentSession) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      if (!disposed && session === target && !transitioning && !target.getSnapshot().readOnly) void saveSession(target).catch(() => {});
    }, 800);
  }
  function assertAlive() { if (disposed) throw new Error("工作台已关闭"); }
  function currentSession() {
    assertAlive();
    if (!session) throw new Error("请先打开工程画布");
    return session;
  }
  function requireSession(target: DocumentSession) {
    assertAlive();
    if (session !== target || target.getSnapshot().disposed) throw new Error("工程或画布已切换，请重新读取目标");
  }
  function requireWritable(target: DocumentSession, expectedRevision?: number, allowTransition = false) {
    requireSession(target);
    if (!allowTransition && transitioning) throw new Error("工程正在切换或恢复历史，请稍后编辑");
    const current = target.getSnapshot();
    if (current.readOnly) throw new Error("当前画布只读");
    if (expectedRevision !== undefined && revisionSchema.parse(expectedRevision) !== current.revision) throw new Error("画布已变化，请读取最新修订后重新提交");
  }
  function toolTarget(target = session) {
    const state = target?.getSnapshot();
    return { directory: state?.directory ?? snapshot.directory ?? undefined, canvasId: state?.canvasId ?? snapshot.canvasId ?? undefined };
  }
  function requireToolRevision(target: DocumentSession, value: unknown) {
    if (value === undefined) throw new ToolExecutionError({ code: "revisionRequired", message: "画布写入缺少读取到的 documentRevision", phase: "validation", target: toolTarget(target), executionState: "notDispatched", actualRevision: target.getSnapshot().revision, recovery: { action: "readState", message: "读取当前画布，将 documentRevision 作为 expectedRevision 重试", tool: "getCanvas" } });
    const expectedRevision = revisionSchema.parse(value), actualRevision = target.getSnapshot().revision;
    if (expectedRevision !== actualRevision) throw new ToolExecutionError({ code: "revisionConflict", message: "画布已变化，请读取最新修订后重新提交", phase: "target", target: toolTarget(target), executionState: "notDispatched", expectedRevision, actualRevision, recovery: { action: "readState", message: "重新读取目标画布并确认修改仍适用", tool: "getCanvas" } });
    return expectedRevision;
  }
  function requireToolWriteAccess(target: DocumentSession) {
    requireSession(target);
    if (target.getSnapshot().readOnly) throw new ToolExecutionError({ code: "readOnly", message: "当前画布只读，未派发编辑操作", phase: "authorization", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "使用只读查询；需要编辑时先取得可编辑的协作连接，再重新读取目标与修订", tool: "getAppState" } });
  }
  function requireToolCatalog(value: unknown) {
    const toolCatalogVersion = runtime.getVersion();
    if (value === undefined || revisionSchema.parse(value) !== toolCatalogVersion) throw new ToolExecutionError({ code: value === undefined ? "toolCatalogVersionRequired" : "toolCatalogChanged", message: "请先发现当前插件工具并绑定 toolCatalogVersion", phase: "validation", target: toolTarget(), executionState: "notDispatched", toolCatalogVersion, recovery: { action: "rediscoverTools", message: "重新调用 getNodeTools 或 getWorkspaceTools，使用回执中的 toolCatalogVersion" } });
  }
  function requireToolCanvas(target: DocumentSession, canvasId: unknown) {
    if (canvasId === undefined || nodeId.parse(canvasId) !== target.getSnapshot().canvasId) throw new ToolExecutionError({ code: canvasId === undefined ? "targetRequired" : "targetChanged", message: "画布写入必须固定当前 canvasId", phase: "target", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "读取当前画布并明确指定 canvasId", tool: "getCanvas" } });
  }
  function findNode(id: string, target = currentSession()) {
    requireSession(target);
    const node = target.getSnapshot().document.nodes.find(node => node.id === id);
    if (!node) throw new Error(`节点不存在：${id}`);
    return node;
  }
  function absolutePosition(node: CanvasNode, nodes: CanvasNode[]) {
    const point = { ...node.position };
    let parent = node.parentId ?? node.parentNode;
    while (parent) {
      const ancestor = nodes.find(item => item.id === parent);
      if (!ancestor) throw new Error(`父分组不存在：${parent}`);
      point.x += ancestor.position.x; point.y += ancestor.position.y;
      parent = ancestor.parentId ?? ancestor.parentNode;
    }
    return point;
  }
  function selectionRoots(ids: string[], nodes: CanvasNode[]) {
    const selected = new Set(ids);
    return ids.map(id => {
      const node = nodes.find(item => item.id === id);
      if (!node) throw new Error(`节点不存在：${id}`);
      return node;
    }).filter(node => {
      let parent = node.parentId ?? node.parentNode;
      while (parent) { if (selected.has(parent)) return false; const ancestor = nodes.find(item => item.id === parent); parent = ancestor?.parentId ?? ancestor?.parentNode; }
      return true;
    });
  }
  function serialize(action: () => Promise<void>, signal?: AbortSignal) {
    const next = transition.then(async () => {
      signal?.throwIfAborted();
      assertAlive(); transitioning = true; publish();
      try { await action(); }
      finally { transitioning = false; publish(); }
    });
    transition = next.catch(() => {});
    return next.catch(error => { report(error); throw error; });
  }
  function queuePlugins(action: () => Promise<void>) {
    const next = pluginQueue.then(action);
    pluginQueue = next.catch(() => {});
    return next;
  }
  function queueCatalog<T>(action: () => Promise<T>): Promise<T> {
    const next = catalogQueue.then(action);
    catalogQueue = next.then(() => {}, () => {});
    return next;
  }
  function publishPlugins() {
    publish({ plugins: [...pluginLabels].filter(([id]) => (definitions.get(id)?.scope ?? pluginScopes.get(id) ?? builtinPlugins[id]?.scope) !== "workspace").map(([id, label]) => {
      const details = { ...pluginDetails.get(id), ...definitions.get(id) };
      return { type: `remote-${id}`, label, description: details.description, icon: details.icon, composer: details.composer, category: details.category, supported: !disabledPlugins.has(id) };
    }),
      workspacePlugins: [...pluginLabels].filter(([id]) => (definitions.get(id)?.scope ?? pluginScopes.get(id) ?? builtinPlugins[id]?.scope) === "workspace").map(([id, label]) => ({ id, label, enabled: !disabledPlugins.has(id) })) });
  }
  function pluginAvailability(pluginId: string, id?: string): CanvasQueryAvailability {
    const definition = definitions.get(pluginId), declared = pluginRequirements.get(pluginId);
    const requires = { ...declared, ...definition?.requires }, capabilities = runtime.getCapabilities();
    const missingCapabilities = Object.entries(requires).flatMap(([name, requiredVersion]) => (capabilities[name] ?? 0) < requiredVersion ? [{ name, requiredVersion, providedVersion: capabilities[name] ?? 0 }] : []);
    const base = { requires, requirementsDeclared: declared !== undefined || definition?.requires !== undefined, missingCapabilities };
    if (["group", "canvasGroup"].includes(pluginId)) return { ...base, status: "available", code: "groupNode", reason: "画布分组不注册插件函数", recovery: { action: "none", message: "通过画布分组工具操作此节点" } };
    if (disabledPlugins.has(pluginId)) return { ...base, status: "unavailable", code: "pluginDisabled", reason: "插件已停用，节点与素材仍保留", recovery: { action: "readState", message: "启用该插件后重新发现工具", tool: "setPluginEnabled", args: { pluginId, enabled: true, toolCatalogVersion: runtime.getVersion() } } };
    if (missingCapabilities.length) return { ...base, status: "unavailable", code: "missingCapabilities", reason: "当前React provider未声明满足插件要求的服务版本", recovery: { action: "readState", message: "在提供所列服务版本的React provider中打开现有工程，再重新发现工具；不要盲目重试" } };
    const activationError = id ? nodeErrors.get(id)?.message : undefined, moduleError = moduleErrors.get(pluginId);
    if (activationError || moduleError) return { ...base, status: "unavailable", code: activationError ? "activationFailed" : "moduleLoadFailed", reason: (activationError ?? moduleError)!.slice(0, 1024), recovery: { action: "readState", message: "读取插件配置与错误，修复依赖或插件后重新加载同一工程并发现工具", tool: "getPluginConfiguration", args: { pluginId } } };
    if (!pluginLabels.has(pluginId)) return { ...base, status: "unavailable", code: "pluginNotInstalled", reason: "节点所需插件未登记，当前无法注册其函数", recovery: { action: "readState", message: "从可信插件包复核并安装缺失插件，然后重新发现工具", tool: "getPluginConfiguration", args: { pluginId } } };
    const failedNode = id ? undefined : [...nodeErrors].find(([, error]) => error.pluginId === pluginId);
    if (failedNode) return { ...base, status: "unknown", code: "nodeActivationFailed", reason: `当前工程存在激活失败的此类节点：${failedNode[1].message.slice(0, 900)}`, recovery: { action: "rediscoverTools", message: "按失败节点读取具体可用性，不能据单个节点失败推断所有实例均不可用", tool: "getNodeTools", args: { nodeIds: [failedNode[0]] } } };
    if (id ? runtime.getInstance(id) : [...activated].some(([nodeId, definition]) => definition.id === pluginId && runtime.getInstance(nodeId))) return { ...base, status: "available", code: "activated", reason: "节点插件已激活并注册实际函数；WebGL、模型、FFmpeg及供应商的具体执行条件仍需专项状态确认", recovery: { action: "rediscoverTools", message: "使用本次发现的函数Schema；涉及模型或媒体工具时先读取专项状态", tool: "getModelStatus" } };
    return { ...base, status: "unknown", code: loadingPlugins.has(pluginId) ? "loading" : definition ? "notActivated" : "notLoaded", reason: "插件尚未在此目标完成激活，不能据此宣称具体渲染或模型可用", recovery: { action: "rediscoverTools", message: "节点激活完成后重新查询；新建节点会通过同一插件加载链验证要求" } };
  }
  function runtimeSummary(): CanvasQueryRuntime {
    return { renderer: "react", provider: window.openCinemaTransport ? "nativeWidget" : "reactWeb", declaredCapabilities: runtime.getCapabilities(), scope: "仅表示已注册的宿主服务接口版本，不证明FFmpeg二进制、WebGL、模型或供应商可执行", executionDependencies: { webGl: "unknown", models: "unknown", mediaTools: "unknown", observeTool: "getModelStatus" } };
  }
  function loadDefinition(source: PluginSource<View>, expectedId?: string) {
    return queueCatalog(async () => {
      assertAlive();
      const definition = await runtime.load(source, controllerLifetime.signal, expectedId);
      definitions.set(definition.id, definition);
      moduleErrors.delete(definition.id);
      for (const [id, error] of nodeErrors) if (error.pluginId === definition.id) nodeErrors.delete(id);
      disabledPlugins.delete(definition.id);
      pluginLabels.set(definition.id, definition.name);
      const previousView = views.get(definition.id);
      views.delete(definition.id); views.delete(`remote-${definition.id}`);
      if (definition.view || previousView) {
        const view: View = props => {
          const instance = runtime.getInstance(props.node.id);
          if (instance?.pluginId === definition.id && instance.view) return createElement(instance.view, props);
          const error = nodeErrors.get(props.node.id);
          if (error) throw new Error(error.message);
          return null;
        };
        views.set(definition.id, view); views.set(`remote-${definition.id}`, view);
      }
      publishPlugins();
      return definition;
    });
  }
  function ensurePlugin(id: string) {
    if (disabledPlugins.has(id)) return Promise.reject(new Error(`插件已卸载：${id}`));
    const failure = moduleErrors.get(id);
    if (failure) return Promise.reject(new Error(failure));
    const definition = definitions.get(id);
    if (definition) return Promise.resolve(definition);
    const existing = loadingPlugins.get(id);
    if (existing) return existing;
    const builtin = builtinPlugins[id], source = pluginSources.get(id);
    if (!builtin && !source) return Promise.reject(new Error(`插件尚未加载：${id}`));
    const pending = loadDefinition(source ?? builtin!.load, id).catch(error => {
      moduleErrors.set(id, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { loadingPlugins.delete(id); });
    loadingPlugins.set(id, pending);
    return pending;
  }
  function documentService(target: DocumentSession, boundNodeId: string, pluginId: string, activation: { signal: AbortSignal; instance?: PluginInstance<View> }): NodeDocumentService {
    function requireNode(id = boundNodeId) {
      activation.signal.throwIfAborted();
      if (activation.instance && runtime.getInstance(boundNodeId) !== activation.instance) throw new Error("插件实例已变化，请重新发现工具");
      if (id !== boundNodeId) throw new Error("节点服务不能访问其他节点");
      const node = findNode(id, target);
      if (node.type?.replace(/^remote-/, "") !== pluginId) throw new Error("节点插件已变化，请重新发现工具");
      return node;
    }
    return {
      readNode: id => requireNode(id),
      getRevision() { requireNode(); return target.getSnapshot().revision; },
      async readText(id) { requireNode(id); const text = await waitForNode(readText(id, target), activation.signal); requireNode(id); return text; },
      async writeText(id, text, expectedRevision, signal) {
        requireNode(id); requireWritable(target, expectedRevision); signal?.throwIfAborted();
        const draft = drafts.get(id);
        if (draft?.session === target && draft.text !== text) throw new Error("节点存在尚未保存的新草稿，请读取并协调后重新提交");
        const combined = AbortSignal.any([activation.signal, ...(activation.instance ? [activation.instance.signal] : []), ...(signal ? [signal] : [])]);
        const submitted = stageText(id, text, target);
        try {
          await persistText(id, submitted, expectedRevision, combined);
          requireNode(id); signal?.throwIfAborted();
        } catch (error) {
          if (draft !== submitted && drafts.get(id) === submitted) { drafts.delete(id); publish(); }
          throw error;
        }
      },
      async updateData(data, expectedRevision, signal) {
        requireNode(); requireWritable(target, expectedRevision, preflighting.has(boundNodeId)); signal?.throwIfAborted();
        const draft = drafts.get(boundNodeId);
        if (draft?.session === target) throw new Error("节点存在尚未保存的新草稿，请读取并协调后重新提交");
        const parsed = z.record(z.string(), z.json()).parse(data);
        activation.signal.throwIfAborted(); activation.instance?.signal.throwIfAborted();
        target.execute(parseDocumentCommand({ name: "updateNodes", expectedRevision, args: { updates: [{ id: boundNodeId, changes: { data: parsed } }] } }));
      },
      async updateRuntimeData(data, signal) {
        requireNode(); requireWritable(target, undefined, preflighting.has(boundNodeId)); signal?.throwIfAborted();
        const parsed = z.record(z.string(), z.json()).parse(data);
        target.execute(parseDocumentCommand({ name: "updateRuntimeData", args: { updates: [{ id: boundNodeId, data: parsed }] } }));
      },
      save() { requireNode(); return waitForNode(saveSession(target), activation.signal); },
    };
  }
  function nodeServices(target: DocumentSession, id: string, pluginId: string, activation: { signal: AbortSignal; instance?: PluginInstance<View> }) {
    const document = documentService(target, id, pluginId, activation);
    const readCanvas = () => { document.readNode(id); return target.getSnapshot().document; };
    const assertWritable = (revision?: number) => { document.readNode(id); requireWritable(target, revision, preflighting.has(id)); activation.instance?.signal.throwIfAborted(); };
    const workbench = createNodeWorkbench({ directory: target.getSnapshot().directory, canvasId: target.getSnapshot().canvasId, nodeId: id, signal: activation.signal, document, readCanvas, assertWritable,
      selectNodes(ids) { assertWritable(); controller.select(ids); },
      getLayout() {
        document.readNode(id);
        const measured = (nodeId: string) => {
          const node = findNode(nodeId, target), size = canvasView?.measure(nodeId);
          return { ...node, width: typeof node.width === "number" ? node.width : size?.width, height: typeof node.height === "number" ? node.height : size?.height };
        };
        const node = measured(id);
        return { position: canvasNodePosition(node, measured), width: node.width ?? 360 };
      },
      focusComposer(input = {}) {
        assertWritable(); activation.signal.throwIfAborted(); activation.instance?.signal.throwIfAborted();
        const request = z.strictObject({ prompt: z.string().max(100000).optional(), insertText: z.string().max(4000).optional(), action: z.boolean().optional() }).parse(input);
        if (!composerListeners.size) throw new Error("当前工作台尚未提供统一创作入口");
        controller.select([id]);
        for (const listener of composerListeners) listener({ nodeId: id, ...request });
      },
      async updateNodes(updates, expectedRevision, signal) {
        assertWritable(expectedRevision); signal?.throwIfAborted();
        const parsed = z.array(z.strictObject({ id: nodeId, data: z.record(z.string(), z.json()) })).min(1).max(10000).parse(updates);
        if (new TextEncoder().encode(JSON.stringify(parsed)).length > 1024 * 1024) throw new Error("单次节点更新超过 1 MiB");
        if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new Error("更新节点 ID 不能重复");
        for (const item of parsed) { findNode(item.id, target); if (drafts.get(item.id)?.session === target) throw new Error("目标节点存在未保存的正文草稿"); }
        target.execute(parseDocumentCommand({ name: "updateNodes", expectedRevision, args: { updates: parsed.map(item => ({ id: item.id, changes: { data: item.data } })) } }));
        await waitForNode(saveSession(target), AbortSignal.any([activation.signal, ...(signal ? [signal] : [])])); document.readNode(id);
      },
      async disconnectInput(input, handleId, signal) {
        assertWritable(); signal?.throwIfAborted();
        const source = z.strictObject({ source: nodeId, sourceHandle: nodeId }).parse(input);
        const edges = readCanvas().edges.filter(edge => edge.target === id && edge.source === source.source && edge.sourceHandle === source.sourceHandle && (!handleId || edge.targetHandle === handleId));
        if (edges.some(edge => edge.deletable === false)) throw new Error("此参考连线不允许断开");
        if (!edges.length) return;
        target.execute(parseDocumentCommand({ name: "removeEdges", args: { ids: edges.map(edge => edge.id) } }));
        await waitForNode(saveSession(target), AbortSignal.any([activation.signal, ...(signal ? [signal] : [])])); document.readNode(id);
      },
      async createNodes(nodes, edges = [], signal) {
        assertWritable(); signal?.throwIfAborted();
        const current = readCanvas(), revision = target.getSnapshot().revision;
        const proposed = parseCanvasDocument({ ...current, nodes: [...current.nodes, ...nodes], edges: [...current.edges, ...edges] });
        for (const type of new Set(nodes.map(node => node.type))) {
          if (typeof type !== "string" || ["group", "canvasGroup"].includes(type)) continue;
          const definition = await ensurePlugin(type.replace(/^remote-/, ""));
          if (definition.scope === "workspace") throw new Error("工作区插件不能添加为画布节点");
        }
        assertWritable(revision); signal?.throwIfAborted();
        for (const edge of edges) {
          const parsed = connectionSchema.parse({ source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle });
          const source = proposed.nodes.find(node => node.id === parsed.source), destination = proposed.nodes.find(node => node.id === parsed.target);
          const ports = (node?: CanvasNode) => Array.isArray(node?.data?.handles) ? node.data.handles : [];
          const out = ports(source).find(port => !!port && typeof port === "object" && !Array.isArray(port) && port.id === parsed.sourceHandle && port.type === "source");
          const input = ports(destination).find(port => !!port && typeof port === "object" && !Array.isArray(port) && port.id === parsed.targetHandle && port.type === "target");
          if (source === destination || !out || !input || typeof out !== "object" || Array.isArray(out) || typeof input !== "object" || Array.isArray(input)
            || !isTypeCompatible(out.dataType as string | string[], input.dataType as string | string[])) throw new Error("新节点连线的端口或类型无效");
        }
        const commands = [];
        if (nodes.length) commands.push({ name: "addNodes", args: { nodes } });
        if (edges.length) commands.push({ name: "addEdges", args: { edges } });
        if (!commands.length) return;
        target.execute(parseDocumentCommand({ name: "batch", expectedRevision: revision, args: { commands } }));
        await waitForNode(syncPlugins(target), AbortSignal.any([activation.signal, ...(signal ? [signal] : [])])); document.readNode(id); signal?.throwIfAborted(); await waitForNode(saveSession(target), activation.signal);
      },
      async hostRequest(input, signal) {
        assertWritable(); signal?.throwIfAborted();
        const adapter = host;
        if (!adapter || adapter.getState() !== "connected") throw new Error("请连接提供此能力的宿主 Agent");
        const requested = input.kind ?? "edit";
        const kind = adapter.capabilities.requests.includes(requested) ? requested : "edit";
        if (!adapter.capabilities.requests.includes(kind)) throw new Error(`宿主尚未提供 ${requested} 能力`);
        await saveSession(target); assertWritable();
        if (host !== adapter || adapter.getState() !== "connected") throw new Error("宿主 Agent 已切换，请重新提交节点请求");
        const sourceReferences = z.array(z.json()).max(1000).parse(input.references ?? []);
        const references = sourceReferences.flatMap(value => {
          if (!value || typeof value !== "object") return [];
          const source = value as { value?: unknown; source?: unknown; label?: unknown };
          const entry = source.value && typeof source.value === "object" ? source.value as { path?: unknown; url?: unknown; mimeType?: unknown; label?: unknown } : value as { path?: unknown; url?: unknown; mimeType?: unknown; label?: unknown };
          const path = typeof entry.path === "string" ? entry.path : typeof entry.url === "string" ? entry.url : undefined;
          const label = entry.label ?? source.label ?? source.source;
          return path ? [{ path, ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}), ...(typeof label === "string" ? { label } : {}) }] : [];
        });
        if (new TextEncoder().encode(JSON.stringify(sourceReferences)).length > 1024 * 1024) throw new Error("宿主引用超过 1 MiB，请减少本轮连线参考");
        return adapter.sendRequest({ kind, prompt: z.string().trim().min(1).max(16000).parse(input.prompt),
          context: { workspaceId: target.getSnapshot().directory, documentId: target.getSnapshot().canvasId, revision: target.getSnapshot().revision, selectedNodeIds: [id], references, data: { references: sourceReferences } },
          metadata: { ...input.metadata, operation: requested, nodeId: id, pluginId } },
        { signal: AbortSignal.any([activation.signal, ...(activation.instance ? [activation.instance.signal] : []), ...(signal ? [signal] : [])]) });
      },
    });
    const inputs = {
      getTargetValues(targetId: string, handleId: string) { const canvas = readCanvas(); return getTargetValues(targetId, handleId, canvas.nodes as unknown as PortNode[], canvas.edges as unknown as PortEdge[]); },
      getSourceValue(sourceId: string, handleId: string) { return getSourceValue(sourceId, handleId, readCanvas().nodes as unknown as PortNode[]); },
    };
    return { document, workbench, files: workbench.files, inputs, workspaceDocuments: workspace?.documents, state: workspace?.state };
  }
  function syncPlugins(target = session) {
    return queuePlugins(async () => {
      if (!target || target !== session || disposed) return;
      const nodes = target.getSnapshot().document.nodes;
      const types = new Map(nodes.map(node => [node.id, node.type?.replace(/^remote-/, "") ?? ""]));
      for (const [id, error] of nodeErrors) if (types.get(id) !== error.pluginId) nodeErrors.delete(id);
      for (const [id, definition] of activated) if (types.get(id) !== definition.id || disabledPlugins.has(definition.id)) {
        try { await runtime.deactivate(id); }
        catch (error) { console.warn(`节点 ${id} 的插件清理失败`, error); }
        finally { activated.delete(id); activatedConfigs.delete(id); workbenches.delete(id); }
      }
      for (const node of nodes) {
        requireSession(target);
        const name = node.type?.replace(/^remote-/, "") ?? "";
        if (disabledPlugins.has(name) || !pluginLabels.has(name)) continue;
        const current = target.getSnapshot().document.nodes.find(item => item.id === node.id);
        if (current?.type !== node.type) continue;
        const known = definitions.get(name), failure = nodeErrors.get(node.id);
        if (failure && (moduleErrors.has(name) || (known && failure.definition === known))) continue;
        try {
          const definition = await ensurePlugin(name);
          if (definition.scope === "workspace") continue;
          requireSession(target);
          const latest = target.getSnapshot().document.nodes.find(item => item.id === node.id);
          const configKey = JSON.stringify(pluginConfigs.get(name) ?? {});
          if (disabledPlugins.has(name) || latest?.type !== node.type || (activated.get(node.id) === definition && activatedConfigs.get(node.id) === configKey && runtime.getInstance(node.id))) continue;
          const activationLifetime = new AbortController();
          const activation: { signal: AbortSignal; instance?: PluginInstance<View> } = { signal: activationLifetime.signal };
          try {
            const services = nodeServices(target, node.id, name, activation);
            activation.instance = await runtime.activate(name, { instanceId: node.id, nodeId: node.id, config: pluginConfigs.get(name), signal: activationLifetime.signal, services });
            activation.instance.signal.addEventListener("abort", () => activationLifetime.abort(activation.instance?.signal.reason), { once: true });
            workbenches.set(node.id, services.workbench);
          } catch (error) { activationLifetime.abort(error); throw error; }
          const after = target.getSnapshot().document.nodes.find(item => item.id === node.id);
          if (after?.type !== node.type) { await runtime.deactivate(node.id); continue; }
          activated.set(node.id, definition); activatedConfigs.set(node.id, configKey); nodeErrors.delete(node.id);
        } catch (error) {
          if (disposed || session !== target) return;
          nodeErrors.set(node.id, { pluginId: name, definition: definitions.get(name), message: error instanceof Error ? error.message : String(error) });
        }
      }
      publish();
    });
  }
  async function initializePlugins() {
    publishPlugins();
    await refreshPlugins();
  }
  async function refreshPlugins(allowTransition = false): Promise<void> {
    if (session && !allowTransition) return serialize(() => refreshPlugins(true));
    const response = await fetch("/api/nodes/get", { headers: { "x-toonflow-workspace": "1" }, signal: controllerLifetime.signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body.code !== 200) throw new Error(body.message || "插件目录读取失败");
    const catalog = z.array(z.object({ name: nodeId, id: nodeId.optional(), displayName: z.string().optional(), version: z.string().optional(), builtin: z.boolean(), installed: z.boolean().optional(), enabled: z.boolean(), requires: nodeRequirementsSchema.optional(), scope: z.enum(["node", "workspace"]).optional(), category: z.string().optional().catch(undefined), description: z.string().optional().catch(undefined), icon: z.string().optional().catch(undefined), url: z.string().optional(), config: z.record(z.string(), z.json()).nullish() })).parse(body.data);
    const installedIds = new Set(catalog.map(entry => entry.id ?? entry.name));
    const changedIds = new Set([...pluginSources.keys()].filter(id => !installedIds.has(id)));
    for (const entry of catalog) {
      const id = entry.id ?? entry.name;
      const source = (!entry.builtin || entry.installed) && entry.url ? installedPluginUrl(entry.url).href : undefined;
      if ((!entry.enabled && !disabledPlugins.has(id)) || pluginSources.get(id) !== source || JSON.stringify(pluginConfigs.get(id) ?? {}) !== JSON.stringify(entry.config ?? {})) changedIds.add(id);
    }
    if (session && changedIds.size) {
      await prepareNodes(session.getSnapshot().document.nodes.filter(node => changedIds.has(node.type?.replace(/^remote-/, "") ?? "")).map(node => node.id), "beforeHistory");
      await saveSession(session);
    }
    const failures: string[] = [];
    for (const id of pluginSources.keys()) if (!installedIds.has(id)) {
      await runtime.unload(id); pluginSources.delete(id); definitions.delete(id); views.delete(id); views.delete(`remote-${id}`);
      pluginLabels.delete(id); pluginDetails.delete(id); pluginScopes.delete(id); pluginRequirements.delete(id); workspaceSubscriptions.get(id)?.(); workspaceSubscriptions.delete(id); workspacePlugins.delete(id);
    }
    for (const entry of catalog) {
      const id = entry.id ?? entry.name;
      if (entry.builtin && !builtinPlugins[id]) continue;
      pluginLabels.set(id, entry.displayName ?? builtinPlugins[id]?.displayName ?? id);
      pluginDetails.set(id, { category: entry.category, description: entry.description, icon: entry.icon });
      pluginScopes.set(id, entry.scope ?? builtinPlugins[id]?.scope ?? "node");
      pluginConfigs.set(id, entry.config ?? {});
      if (entry.requires) pluginRequirements.set(id, entry.requires); else pluginRequirements.delete(id);
      if ((!entry.builtin || entry.installed) && entry.url) {
        const url = installedPluginUrl(entry.url);
        const previous = pluginSources.get(id);
        if (previous !== url.href && definitions.has(id)) {
          try { await loadDefinition(url, id); pluginSources.set(id, url.href); }
          catch (error) { failures.push(`插件 ${id} 升级失败，继续使用已激活版本：${error instanceof Error ? error.message : String(error)}`); }
        } else pluginSources.set(id, url.href);
      } else if (pluginSources.has(id)) {
        if (builtinPlugins[id] && definitions.has(id)) await loadDefinition(builtinPlugins[id]!.load, id);
        else definitions.delete(id);
        pluginSources.delete(id);
      }
      if (entry.enabled) {
        disabledPlugins.delete(id); moduleErrors.delete(id);
        for (const [nodeId, error] of nodeErrors) if (error.pluginId === id) nodeErrors.delete(nodeId);
      }
      else {
        disabledPlugins.add(id); await runtime.unload(id); definitions.delete(id);
        views.delete(id); views.delete(`remote-${id}`);
        workspaceSubscriptions.get(id)?.(); workspaceSubscriptions.delete(id); workspacePlugins.delete(id);
      }
    }
    publishPlugins();
    window.dispatchEvent(new Event("toonflow:provider-config-changed"));
    if (session) {
      await syncPlugins(); failures.push(...await syncWorkspacePlugins());
      for (const [id, error] of nodeErrors) failures.push(`节点 ${id}：${error.message}`);
    }
    if (failures.length) throw new Error(failures.join("；"));
    publish({ error: null });
  }
  async function openWorkspace(directory: string) {
    if (workspace?.documents.directory === directory) return;
    for (const id of workspacePlugins.keys()) {
      workspaceSubscriptions.get(id)?.(); workspaceSubscriptions.delete(id);
      await runtime.deactivate(`workspace:${id}`);
    }
    workspacePlugins.clear(); releaseDocument?.(); workspace?.dispose();
    const next = createWorkspaceSession(directory, {
      async flush() { if (session?.getSnapshot().directory === directory) await saveSession(session); },
      changed() {
        if (session?.getSnapshot().directory === directory) session.setReadOnly(readOnly || !!next.provider?.readOnly);
        publish();
      },
    });
    if (workspaceStates.has(directory)) next.state = workspaceStates.get(directory)!;
    else workspaceStates.set(directory, next.state);
    workspace = next;
  }
  async function syncWorkspacePlugins() {
    const target = workspace;
    const failures: string[] = [];
    if (!target) return failures;
    for (const [id] of pluginLabels) {
      if ((definitions.get(id)?.scope ?? pluginScopes.get(id) ?? builtinPlugins[id]?.scope) !== "workspace" || disabledPlugins.has(id)) continue;
      try {
        const definition = await ensurePlugin(id);
        if (workspace !== target || disposed) return failures;
        const configKey = JSON.stringify(pluginConfigs.get(id) ?? {});
        if (workspacePlugins.get(id) === definition && activatedConfigs.get(`workspace:${id}`) === configKey && runtime.getInstance(`workspace:${id}`)) continue;
        const instance = await runtime.activate(id, { instanceId: `workspace:${id}`,
          config: pluginConfigs.get(id), services: { workspaceDocuments: target.documents, state: target.state, files: createWorkspaceFiles(target.documents.directory) } });
        workspaceSubscriptions.get(id)?.();
        const service = instance.service as { subscribe?(listener: () => void): () => void } | undefined;
        if (service?.subscribe) workspaceSubscriptions.set(id, service.subscribe(() => publish()));
        workspacePlugins.set(id, definition);
        activatedConfigs.set(`workspace:${id}`, configKey);
      } catch (error) { report(error); failures.push(`工作区插件 ${id}：${error instanceof Error ? error.message : String(error)}`); }
    }
    publishPlugins();
    return failures;
  }

  async function openCanvas(directory: string, path: string, signal?: AbortSignal) {
    await ready; assertAlive(); relativePath.parse(path);
    signal?.throwIfAborted();
    const previous = session;
    const files = createWorkspaceFiles(directory);
    const original = await files.readTextSnapshot(path, { maxBytes: 20 * 1024 * 1024, signal: AbortSignal.any([controllerLifetime.signal, ...(signal ? [signal] : [])]) });
    assertAlive();
    const document = parseCanvasDocument(JSON.parse(original.text));
    let revision = original.revision;
    let baseline = document;
    let usedProvider = false;
    const next = createDocumentSession({ directory, canvasId: path, document, readOnly,
      async save(document, context) {
        if (next.getSnapshot().readOnly) throw new Error("当前画布只读");
        const provider = workspace?.documents.directory === directory ? workspace.provider : undefined;
        if (provider) {
          baseline = parseCanvasDocument(await provider.save(path, document, context.runtimeUpdates)); usedProvider = true;
          return;
        }
        if (usedProvider) {
          const current = await files.readTextSnapshot(path);
          const disk = parseCanvasDocument(JSON.parse(current.text));
          const content = (value: CanvasDocument) => JSON.stringify({ nodes: value.nodes, edges: value.edges });
          if (content(disk) !== content(baseline)) throw new Error("协作结束后磁盘仍有新修改，请重新打开画布后继续保存");
          revision = current.revision; usedProvider = false;
        }
        revision = await files.writeTextSnapshot(path, `${JSON.stringify(document, null, 2)}\n`, { revision, encoding: original.encoding });
        baseline = document;
      },
    });
    try {
      await queuePlugins(async () => {
        assertAlive();
        signal?.throwIfAborted();
        if (session !== previous) throw new Error("工程已切换，请重新打开目标画布");
        for (const id of activated.keys()) {
          try { await runtime.deactivate(id); }
          catch (error) { console.warn(`节点 ${id} 的插件清理失败`, error); }
          finally { activated.delete(id); }
        }
        await openWorkspace(directory);
        releaseDocument?.(); releaseSession?.(); previous?.dispose();
        nodeErrors.clear(); workbenches.clear(); for (const id of activatedConfigs.keys()) if (!id.startsWith("workspace:")) activatedConfigs.delete(id); next.setReadOnly(readOnly || !!workspace?.provider?.readOnly); session = next;
        lifetime.abort(); lifetime = new AbortController();
        releaseSession = session.subscribe(() => publish());
        releaseDocument = workspace?.observe(path, {
          read: () => next.getSnapshot().document,
          base: () => baseline,
          busy: () => next.getSnapshot().saving || next.getSnapshot().dirty || [...drafts.values()].some(draft => draft.session === next),
          async apply(value, saved) {
            requireSession(next);
            if ([...drafts.values()].some(draft => draft.session === next)) throw new Error("正文仍有草稿，请先完成保存再接收协作修改");
            next.applyRemote(value, saved ?? value);
            baseline = parseCanvasDocument(saved ?? value); usedProvider = true;
            await syncPlugins(next);
          },
        });
        queryRevision++;
        publish({ directory, canvasId: path, selectedIds: [], error: null });
      });
    } catch (error) { next.dispose(); throw error; }
    await syncPlugins(next);
    await syncWorkspacePlugins();
  }
  async function readCommittedText(node: CanvasNode, target: DocumentSession) {
    const path = node.data?.textPath;
    if (typeof path === "string" && path) return createWorkspaceFiles(target.getSnapshot().directory).readText(relativePath.parse(path));
    const outputs = node.data?.outputs;
    const text = outputs && typeof outputs === "object" && !Array.isArray(outputs) ? outputs.text : undefined;
    return text && typeof text === "object" && !Array.isArray(text) && typeof text.value === "string" ? text.value : typeof node.data?.text === "string" ? node.data.text : "";
  }
  async function readText(id: string, target: DocumentSession) {
    requireSession(target);
    const node = findNode(id, target);
    const draft = drafts.get(id);
    if (draft?.session === target) return draft.text;
    const text = await readCommittedText(node, target);
    requireSession(target);
    const latestDraft = drafts.get(id);
    if (latestDraft?.session === target) return latestDraft.text;
    const latest = findNode(id, target);
    const source = (value: CanvasNode) => {
      const outputs = value.data?.outputs;
      return JSON.stringify([value.data?.textPath, outputs && typeof outputs === "object" && !Array.isArray(outputs) ? outputs.text : undefined, value.data?.text]);
    };
    if (source(latest) !== source(node)) throw new Error("正文在读取期间已变化，请重新读取");
    return text;
  }
  function stageText(id: string, text: string, target: DocumentSession) {
    requireWritable(target); findNode(nodeId.parse(id), target); textSchema.parse(text);
    const previous = drafts.get(id);
    if (previous?.session === target && previous.text === text) return previous;
    const draft = { text, session: target };
    drafts.set(id, draft); publish(); return draft;
  }
  function persistText(id: string, draft: TextDraft, expectedRevision?: number, signal?: AbortSignal) {
    const pending = pendingText.get(draft);
    if (pending) return pending;
    const target = draft.session;
    function superseded() {
      if (drafts.get(id) === draft) return false;
      if (signal) throw new Error("正文草稿已被更新，请重新读取后提交");
      return true;
    }
    const operation = textQueue.then(async () => {
      requireWritable(target, expectedRevision, true); signal?.throwIfAborted();
      if (superseded()) return;
      const node = findNode(id, target);
      const revision = target.getSnapshot().revision;
      const committed = await readCommittedText(node, target);
      requireWritable(target, revision, true); signal?.throwIfAborted();
      if (superseded()) return;
      if (committed === draft.text) { drafts.delete(id); publish(); return; }
      const files = createWorkspaceFiles(target.getSnapshot().directory);
      for (const path of ["assets", `assets/${id}`]) {
        requireWritable(target, revision, true); signal?.throwIfAborted();
        await files.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
          if (error.response?.data?.data?.code !== "EEXIST") throw error;
        });
      }
      requireWritable(target, revision, true); signal?.throwIfAborted();
      const textPath = `assets/${id}/content.${crypto.randomUUID()}.md`;
      await files.write(textPath, draft.text, true, signal);
      requireWritable(target, revision, true); signal?.throwIfAborted();
      // 正文版本文件不可变；被新稿取代或提交冲突时保留文件，不删除历史可能引用的素材。
      if (superseded()) return;
      const outputs = node.data?.outputs && typeof node.data.outputs === "object" && !Array.isArray(node.data.outputs) ? node.data.outputs : {};
      target.execute(parseDocumentCommand({ name: "updateNodes", expectedRevision: revision, args: { updates: [{ id, changes: { data: {
        textPath, outputs: { ...outputs, text: { dataType: "STRING", value: draft.text } },
        historyFields: [...new Set([...(Array.isArray(node.data?.historyFields) ? node.data.historyFields : []), "textPath", "outputs"])],
      } } }] } }));
      if (drafts.get(id) === draft) drafts.delete(id);
      publish();
    });
    const result = operation.catch(error => { report(error); throw error; }).finally(() => { pendingText.delete(draft); publish(); });
    pendingText.set(draft, result);
    textQueue = result.catch(() => {});
    publish(); return result;
  }
  async function flushText(target: DocumentSession) {
    for (;;) {
      requireSession(target);
      const current = [...drafts].filter(([, draft]) => draft.session === target);
      if (!current.length) { await textQueue; requireSession(target); return; }
      for (const [id, draft] of current) await persistText(id, draft);
    }
  }
  function saveSession(target: DocumentSession): Promise<void> {
    clearTimeout(autoSaveTimer);
    const pending = pendingSaves.get(target);
    if (pending) return pending;
    const operation = Promise.resolve().then(async () => {
      do {
        await flushText(target); requireSession(target);
        await target.flushSave(); requireSession(target);
      } while ([...drafts.values()].some(draft => draft.session === target) || target.getSnapshot().dirty);
      publish({ error: null });
    }).catch(error => { report(error); throw error; }).finally(() => { pendingSaves.delete(target); });
    pendingSaves.set(target, operation); return operation;
  }
  function connect(target: DocumentSession, connections: z.infer<typeof connectionSchema>[], expectedRevision?: number) {
    requireWritable(target, expectedRevision);
    const edges = [...target.getSnapshot().document.edges];
    const added: CanvasDocument["edges"] = [];
    const entries = connections.map(connection => {
      const source = findNode(connection.source, target), destination = findNode(connection.target, target);
      if (source.id === destination.id || source.connectable === false || destination.connectable === false) throw new Error("节点不允许建立此连接");
      const handles = (node: CanvasNode) => Array.isArray(node.data?.handles) ? node.data.handles : [];
      const handle = (node: CanvasNode, type: string, id: string) => handles(node).find(value => value && typeof value === "object" && !Array.isArray(value) && value.id === id && value.type === type);
      const out = handle(source, "source", connection.sourceHandle), input = handle(destination, "target", connection.targetHandle);
      const dataType = z.union([z.string(), z.array(z.string())]);
      if (!out || !input || typeof out !== "object" || Array.isArray(out) || typeof input !== "object" || Array.isArray(input)
        || !isTypeCompatible(dataType.parse(out.dataType), dataType.parse(input.dataType))) throw new Error("连线端口不存在或数据类型不兼容");
      if (!validConnection(target.getSnapshot().document.nodes, edges, connection)) throw new ToolExecutionError({ code: "connectionRejected", message: "此连接不符合目标节点的输入规则，整批未提交", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新读取目标端口及已有连线，缩小选区或选择其他兼容目标", tool: "getCanvasEdges" } });
      const existing = edges.find(edge => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle);
      if (existing) return existing;
      const edge = { id: crypto.randomUUID(), ...connection };
      edges.push(edge); added.push(edge); return edge;
    });
    if (added.length) target.execute(parseDocumentCommand({ name: "addEdges", expectedRevision, args: { edges: added } }));
    return entries;
  }
  function validConnection(nodes: readonly CanvasNode[], edges: readonly PortEdge[], connection: PortEdge) {
    const source = nodes.find(node => node.id === connection.source), destination = nodes.find(node => node.id === connection.target);
    if (!source || !destination || source.id === destination.id || source.connectable === false || destination.connectable === false) return false;
    const sourcePlugin = source.type?.replace(/^remote-/, "") ?? "", targetPlugin = destination.type?.replace(/^remote-/, "") ?? "";
    if (!definitions.has(sourcePlugin) || !definitions.has(targetPlugin) || pluginAvailability(sourcePlugin, source.id).status === "unavailable" || pluginAvailability(targetPlugin, destination.id).status === "unavailable") return false;
    const ports = z.array(z.object({ id: z.string(), type: z.string(), dataType: z.union([z.string(), z.array(z.string())]) }));
    const outputs = ports.safeParse(source.data?.handles ?? []), inputs = ports.safeParse(destination.data?.handles ?? []);
    if (!outputs.success || !inputs.success) return false;
    const out = outputs.data.find(port => port.type === "source" && port.id === connection.sourceHandle), input = inputs.data.find(port => port.type === "target" && port.id === connection.targetHandle);
    if (!out || !input || !isTypeCompatible(out.dataType, input.dataType)) return false;
    const rule = definitions.get(destination.type?.replace(/^remote-/, "") ?? "")?.canConnect;
    try { return !rule || rule(connection, { nodes: nodes as readonly PortNode[], edges }) === true; }
    catch { return false; }
  }
  function selectionConnections(document: CanvasDocument, nodeIds: string[], destination: CanvasNode, targetHandle?: string) {
    const ids = new Set(nodeIds);
    for (const id of ids) if (!document.nodes.some(node => node.id === id)) throw new Error(`节点不存在：${id}`);
    for (;;) { const count = ids.size; for (const node of document.nodes) if (ids.has(node.parentId ?? node.parentNode ?? "")) ids.add(node.id); if (count === ids.size) break; }
    if (ids.has(destination.id) || destination.connectable === false) return;
    const sources = document.nodes.filter(node => ids.has(node.id) && !["group", "canvasGroup"].includes(node.type ?? ""));
    if (!sources.length || sources.some(node => node.connectable === false)) return;
    if (sources.length > 100) throw new Error("批量连接最多包含100个实际来源节点，请缩小选区");
    const ports = z.array(z.object({ id: z.string(), type: z.string(), dataType: z.union([z.string(), z.array(z.string())]) }));
    const inputs = ports.parse(destination.data?.handles ?? []).filter(port => port.type === "target" && (!targetHandle || targetHandle === port.id));
    const candidates = sources.map(source => ports.parse(source.data?.handles ?? []).filter(port => port.type === "source").flatMap(out => inputs.filter(input => isTypeCompatible(out.dataType, input.dataType)).map(input => ({ source: source.id, target: destination.id, sourceHandle: out.id, targetHandle: input.id }))));
    const nodes = document.nodes.some(node => node.id === destination.id) ? document.nodes : [...document.nodes, destination];
    const pending: PortEdge[] = [...document.edges], result: z.infer<typeof connectionSchema>[] = [];
    let attempts = 0;
    // ACT: 回溯复用插件接收规则，最多校验10000次；更大组合需缩小选区，失败时不提交部分连线。
    function match(index: number): boolean {
      if (index === candidates.length) return true;
      const choices = candidates[index]!;
      if (choices.some(connection => document.edges.some(edge => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle))) return match(index + 1);
      for (const connection of choices) {
        if (++attempts > 10000) throw new Error("批量端口匹配组合过多，请缩小选区或指定目标端口");
        if (!validConnection(nodes, pending, connection)) continue;
        pending.push(connection); result.push(connection);
        if (match(index + 1)) return true;
        pending.pop(); result.pop();
      }
      return false;
    }
    return match(0) ? result : undefined;
  }
  async function compatibleEndpointTypes(target: DocumentSession, endpoint: z.infer<typeof connectionEndpointSchema>) {
    const document = target.getSnapshot().document, revision = target.getSnapshot().revision;
    const node = findNode(endpoint.nodeId, target);
    const portSchema = z.array(z.object({ id: z.string(), type: z.string(), dataType: z.union([z.string(), z.array(z.string())]) }));
    if (!portSchema.parse(node.data?.handles ?? []).some(port => port.id === endpoint.handleId && port.type === endpoint.direction)) throw new Error("连线端口不存在");
    const types: string[] = [], unavailable: { type: string; reason: string }[] = [];
    for (const plugin of snapshot.plugins.filter(item => item.supported)) {
      const pluginId = plugin.type.replace(/^remote-/, ""), availability = pluginAvailability(pluginId);
      if (availability.status === "unavailable") { unavailable.push({ type: plugin.type, reason: availability.reason }); continue; }
      try {
        const definition = await ensurePlugin(pluginId); requireSession(target);
        if (revision !== target.getSnapshot().revision) throw new Error("画布已变化，请重新发现兼容节点");
        if (definition.scope === "workspace") continue;
        const data = z.record(z.string(), z.json()).parse(definition.createData?.() ?? {});
        const candidate: CanvasNode = { id: crypto.randomUUID(), type: plugin.type, position: { x: 0, y: 0 }, data };
        if (portSchema.parse(data.handles ?? []).some(port => port.type !== endpoint.direction && validConnection([...document.nodes, candidate], document.edges, endpoint.direction === "source" ? { source: node.id, sourceHandle: endpoint.handleId, target: candidate.id, targetHandle: port.id } : { source: candidate.id, sourceHandle: port.id, target: node.id, targetHandle: endpoint.handleId }))) types.push(plugin.type);
      } catch (error) {
        requireSession(target);
        if (revision !== target.getSnapshot().revision) throw new Error("画布已变化，请重新发现兼容节点");
        unavailable.push({ type: plugin.type, reason: (error instanceof Error ? error.message : String(error)).slice(0, 512) });
      }
    }
    return { types, unavailable };
  }
  async function addEndpointNode(target: DocumentSession, args: { type: string; position: { x: number; y: number }; endpoint: z.infer<typeof connectionEndpointSchema> }, expectedRevision?: number) {
    requireWritable(target, expectedRevision);
    const revision = target.getSnapshot().revision, source = findNode(args.endpoint.nodeId, target);
    const ports = z.array(z.object({ id: z.string(), type: z.string(), dataType: z.union([z.string(), z.array(z.string())]) }));
    if (!ports.parse(source.data?.handles ?? []).some(port => port.id === args.endpoint.handleId && port.type === args.endpoint.direction)) throw new Error("连线起点已变化，请重新发现端口");
    const pluginId = args.type.replace(/^remote-/, ""), definition = await ensurePlugin(pluginId); requireWritable(target, revision);
    if (definition.scope === "workspace") throw new Error("工作区插件不能添加为画布节点");
    const data = z.record(z.string(), z.json()).parse(definition.createData?.() ?? {});
    const node: CanvasNode = { id: crypto.randomUUID(), type: `remote-${pluginId}`, position: args.position, data: { ...data, label: typeof data.label === "string" ? data.label : definition.name } };
    const document = target.getSnapshot().document;
    const connection = (portId: string) => args.endpoint.direction === "source" ? { source: source.id, sourceHandle: args.endpoint.handleId, target: node.id, targetHandle: portId } : { source: node.id, sourceHandle: portId, target: source.id, targetHandle: args.endpoint.handleId };
    const to = ports.parse(node.data?.handles ?? []).find(port => port.type !== args.endpoint.direction && validConnection([...document.nodes, node], document.edges, connection(port.id)));
    if (!to) throw new ToolExecutionError({ code: "connectionRejected", message: "新节点没有兼容端口，未创建节点或连线", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新发现此端口可连接的节点类型", tool: "getCompatibleNodeTypes", args: { ...args.endpoint, canvasId: target.getSnapshot().canvasId } } });
    const edge = { id: crypto.randomUUID(), ...connection(to.id) };
    target.execute(parseDocumentCommand({ name: "batch", expectedRevision: revision, args: { commands: [{ name: "addNodes", args: { nodes: [node] } }, { name: "addEdges", args: { edges: [edge] } }] } }));
    await syncPlugins(target); requireSession(target); controller.select([node.id]);
    await saveSession(target);
    return { node: findNode(node.id, target), edges: [edge] };
  }
  async function compatibleSelectionTypes(target: DocumentSession, nodeIds: string[]) {
    const document = target.getSnapshot().document, revision = target.getSnapshot().revision, types: string[] = [], unavailable: { type: string; reason: string }[] = [];
    for (const plugin of snapshot.plugins.filter(item => item.supported)) {
      const id = plugin.type.replace(/^remote-/, ""), availability = pluginAvailability(id);
      if (availability.status === "unavailable") { unavailable.push({ type: plugin.type, reason: availability.reason }); continue; }
      try {
        const definition = await ensurePlugin(id); requireSession(target);
        if (revision !== target.getSnapshot().revision) throw new Error("画布已变化，请重新发现兼容节点");
        if (definition.scope === "workspace") continue;
        const data = z.record(z.string(), z.json()).parse(definition.createData?.() ?? {});
        const candidate: CanvasNode = { id: crypto.randomUUID(), type: plugin.type, position: { x: 0, y: 0 }, data };
        if (selectionConnections(document, nodeIds, candidate)) types.push(plugin.type);
      } catch (error) {
        requireSession(target);
        if (revision !== target.getSnapshot().revision) throw new Error("画布已变化，请重新发现兼容节点");
        unavailable.push({ type: plugin.type, reason: (error instanceof Error ? error.message : String(error)).slice(0, 512) });
      }
    }
    return { types, unavailable };
  }
  async function addConnectedSelection(target: DocumentSession, args: { nodeIds: string[]; type: string; position: { x: number; y: number } }, expectedRevision?: number) {
    requireWritable(target, expectedRevision);
    const revision = target.getSnapshot().revision, pluginId = args.type.replace(/^remote-/, ""), definition = await ensurePlugin(pluginId);
    requireWritable(target, revision);
    if (definition.scope === "workspace") throw new Error("工作区插件不能添加为画布节点");
    const data = z.record(z.string(), z.json()).parse(definition.createData?.() ?? {});
    const node: CanvasNode = { id: crypto.randomUUID(), type: `remote-${pluginId}`, position: args.position, data: { ...data, label: typeof data.label === "string" ? data.label : definition.name } };
    const connections = selectionConnections(target.getSnapshot().document, args.nodeIds, node);
    if (!connections) throw new ToolExecutionError({ code: "connectionRejected", message: "新节点无法接收整个选区，未创建节点或连接", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "缩小选区或发现其他兼容节点类型", tool: "getCompatibleSelectionNodeTypes", args: { nodeIds: args.nodeIds, canvasId: target.getSnapshot().canvasId } } });
    const edges = connections.map(connection => ({ id: crypto.randomUUID(), ...connection }));
    target.execute(parseDocumentCommand({ name: "batch", expectedRevision: revision, args: { commands: [{ name: "addNodes", args: { nodes: [node] } }, { name: "addEdges", args: { edges } }] } }));
    await syncPlugins(target); requireSession(target); controller.select([node.id]);
    await saveSession(target);
    return { node: findNode(node.id, target), edges };
  }
  function finishDraggedNodes(document: CanvasDocument, moves: z.infer<typeof uiSchemas.moveNodes>["nodes"], sizesOverride?: Map<string, { width: number; height: number }>) {
      const nodes: CanvasNode[] = document.nodes.map(node => ({ ...node, position: { ...node.position } }));
      const byId = new Map(nodes.map(node => [node.id, node]));
      const moved = new Set(moves.map(node => node.id));
      if (moved.size !== moves.length) throw new Error("拖动节点 ID 不能重复");
      const parentId = (node: CanvasNode) => node.parentId ?? node.parentNode;
      const isGroup = (node: CanvasNode) => ["group", "canvasGroup"].includes(node.type ?? "");
      function ancestors(node: CanvasNode) {
        const parents: CanvasNode[] = [];
        let parent = byId.get(parentId(node) ?? "");
        while (parent) { parents.push(parent); parent = byId.get(parentId(parent) ?? ""); }
        return parents;
      }
      const roots = moves.map(item => {
        const node = byId.get(item.id);
        if (!node) throw new Error(`拖动节点不存在：${item.id}`);
        return { node, position: item.position };
      }).filter(({ node }) => !ancestors(node).some(parent => moved.has(parent.id)));
      const sizes = new Map(nodes.flatMap(node => {
        const size = sizesOverride?.get(node.id) ?? canvasView?.measure(node.id);
        return size && Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0 ? [[node.id, size] as const] : [];
      }));
      function origin(node: CanvasNode) {
        const value = node.origin;
        return Array.isArray(value) && value.length === 2 && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value as [number, number] : [0, 0];
      }
      for (const { node, position } of roots) {
        if (node.draggable === false || node.hidden === true) throw new Error(`节点不允许拖动：${node.id}`);
        const size = sizes.get(node.id);
        if (!size) throw new Error(`节点 ${node.id} 尚未完成尺寸测量`);
        const next = { ...position };
        if (node.extent != null) {
          const parentSize = node.extent === "parent" ? sizes.get(parentId(node) ?? "") : undefined;
          const extent = parentSize ? [[0, 0], [parentSize.width, parentSize.height]] : node.extent;
          if (!Array.isArray(extent) || extent.length !== 2 || extent.some(point => !Array.isArray(point) || point.length !== 2 || point.some(value => typeof value !== "number" || !Number.isFinite(value)))) throw new Error("节点移动范围无效或父分组尺寸未就绪");
          const [[left, top], [right, bottom]] = extent as [[number, number], [number, number]];
          if (left > right || top > bottom) throw new Error("节点移动范围无效");
          const [x, y] = origin(node);
          next.x = Math.max(left + x * size.width, Math.min(right - (1 - x) * size.width, next.x));
          next.y = Math.max(top + y * size.height, Math.min(bottom - (1 - y) * size.height, next.y));
        }
        node.position = next;
      }
      // ACT: 仅松手时按祖先计算；大画布可改为树遍历缓存与空间索引。先冻结矩形，避免贴合后的组吸收原本不相交的节点。
      const rectangles = new Map(nodes.flatMap(node => {
        const size = sizes.get(node.id);
        if (!size) return [];
        let x = node.position.x, y = node.position.y;
        const parents = ancestors(node);
        for (const current of [node, ...parents]) {
          const dimensions = sizes.get(current.id), [offsetX, offsetY] = origin(current);
          if (!dimensions) return [];
          x -= offsetX * dimensions.width; y -= offsetY * dimensions.height;
          if (current !== node) { x += current.position.x; y += current.position.y; }
        }
        return [[node.id, { x, y, ...size, depth: parents.length }] as const];
      }));
      const groups = nodes.filter(node => isGroup(node) && node.hidden !== true && rectangles.has(node.id)).sort((first, second) => {
        const a = rectangles.get(first.id)!, b = rectangles.get(second.id)!;
        return b.depth - a.depth || a.width * a.height - b.width * b.height;
      });
      function intersects(node: CanvasNode, group: CanvasNode) {
        const a = rectangles.get(node.id), b = rectangles.get(group.id);
        return !!a && !!b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      }
      const affected = new Set<CanvasNode>();
      for (const { node } of roots) {
        ancestors(node).filter(isGroup).forEach(group => affected.add(group));
        if (node.extent != null || !rectangles.has(node.id)) continue;
        const parent = byId.get(parentId(node) ?? "");
        const retainsParent = !!parent && isGroup(parent) && intersects(node, parent);
        const group = groups.find(group => group !== node && intersects(node, group) && !ancestors(group).includes(node) && (!retainsParent || ancestors(group).includes(parent!))) ?? (retainsParent ? parent : undefined);
        if (group === parent || (!group && (!parent || !isGroup(parent)))) continue;
        const point = rectangles.get(node.id)!, destination = group ? rectangles.get(group.id)! : { x: 0, y: 0 };
        const size = sizes.get(node.id)!, [x, y] = origin(node);
        delete node.parentId; delete node.parentNode;
        if (group) { node.parentId = group.id; node.parentNode = group.id; }
        node.position = { x: point.x - destination.x + x * size.width, y: point.y - destination.y + y * size.height };
        node.expandParent = false;
        ancestors(node).filter(isGroup).forEach(group => affected.add(group));
      }
      for (const group of [...affected].sort((a, b) => ancestors(b).length - ancestors(a).length)) {
        const children = nodes.filter(node => parentId(node) === group.id);
        const previous = sizes.get(group.id);
        if (!previous || !children.length || group.draggable === false || group.resizable === false || group.extent != null || children.some(node => !sizes.has(node.id) || node.extent != null)) continue;
        const bounds = children.map(node => {
          const size = sizes.get(node.id)!, [x, y] = origin(node);
          return { x: node.position.x - x * size.width, y: node.position.y - y * size.height, ...size };
        });
        const left = Math.min(...bounds.map(node => node.x)) - 24, top = Math.min(...bounds.map(node => node.y)) - 48;
        const width = Math.max(...bounds.map(node => node.x + node.width)) - left + 24;
        const height = Math.max(...bounds.map(node => node.y + node.height)) - top + 24;
        const [x, y] = origin(group);
        group.position = { x: group.position.x + left + x * (width - previous.width), y: group.position.y + top + y * (height - previous.height) };
        for (const child of children) child.position = { x: child.position.x - left, y: child.position.y - top };
        group.width = width; group.height = height;
        const style = group.style && typeof group.style === "object" && !Array.isArray(group.style) ? group.style : {};
        group.style = { ...style, width: `${width}px`, height: `${height}px` };
        sizes.set(group.id, { width, height });
      }
    return nodes;
  }
  async function execute(target: DocumentSession, name: string, args: Record<string, unknown>, expectedRevision?: number, allowTransition = false): Promise<unknown> {
    requireWritable(target, expectedRevision, allowTransition); publish({ error: null });
    if (name === "removeElements" && !allowTransition) {
      let result: unknown;
      await serialize(async () => { result = await execute(target, name, args, expectedRevision, true); });
      return result;
    }
    if (name === "moveNodes") {
      const parsed = uiSchemas.moveNodes.parse(args);
      for (const item of parsed.nodes) if (findNode(item.id, target).draggable === false) throw new Error(`节点不允许移动：${item.id}`);
      target.execute(parseDocumentCommand({ name: "updateNodes", expectedRevision, args: { updates: parsed.nodes.map(node => ({ id: node.id, changes: { position: node.position } })) } }));
    } else if (name === "finishNodeDrag") {
      const parsed = uiSchemas.moveNodes.parse(args);
      const document = target.getSnapshot().document;
      const nodes = finishDraggedNodes(document, parsed.nodes);
      if (JSON.stringify(nodes) !== JSON.stringify(document.nodes)) target.execute(parseDocumentCommand({ name: "replaceDocument", expectedRevision, args: { document: { ...document, nodes } } }));
    } else if (name === "renameNode") {
      const parsed = uiSchemas.renameNode.parse(args);
      target.execute(parseDocumentCommand({ name: "updateNodes", expectedRevision, args: { updates: [{ id: parsed.id, changes: { data: { label: parsed.label } } }] } }));
    } else if (name === "resizeNode") {
      const { id, ...changes } = uiSchemas.resizeNode.parse(args);
      const node = findNode(id, target);
      if (node.resizable === false) throw new Error("节点不允许调整尺寸");
      const updates: { id: string; changes: Record<string, unknown> }[] = [{ id, changes }];
      if (["group", "canvasGroup"].includes(node.type ?? "")) {
        const style = node.style && typeof node.style === "object" && !Array.isArray(node.style) ? node.style : {};
        const width = typeof node.width === "number" ? node.width : typeof style.width === "number" ? style.width : typeof style.width === "string" && /^\d+(?:\.\d+)?px$/.test(style.width) ? Number.parseFloat(style.width) : undefined;
        const height = typeof node.height === "number" ? node.height : typeof style.height === "number" ? style.height : typeof style.height === "string" && /^\d+(?:\.\d+)?px$/.test(style.height) ? Number.parseFloat(style.height) : undefined;
        const origin = Array.isArray(node.origin) && node.origin.length === 2 && node.origin.every(value => typeof value === "number" && Number.isFinite(value)) ? node.origin : [0, 0];
        if ((origin[0] && !width) || (origin[1] && !height)) throw new Error("分组原尺寸尚未就绪");
        const dx = changes.position.x - node.position.x - Number(origin[0]) * (changes.width - (width ?? changes.width));
        const dy = changes.position.y - node.position.y - Number(origin[1]) * (changes.height - (height ?? changes.height));
        for (const child of target.getSnapshot().document.nodes) if ((child.parentId ?? child.parentNode) === id && (dx || dy)) updates.push({ id: child.id, changes: { position: { x: child.position.x - dx, y: child.position.y - dy } } });
      }
      target.execute(parseDocumentCommand({ name: "updateNodes", expectedRevision, args: { updates } }));
    } else if (name === "connectNodes") connect(target, [connectionSchema.parse(args)], expectedRevision);
    else if (name === "connectSelection") {
      const parsed = z.strictObject({ nodeIds: z.array(nodeId).min(1).max(100), target: nodeId, targetHandle: nodeId.optional() }).parse(args);
      const destination = findNode(parsed.target, target);
      const connections = selectionConnections(target.getSnapshot().document, parsed.nodeIds, destination, parsed.targetHandle);
      if (!connections) throw new ToolExecutionError({ code: "connectionRejected", message: "目标无法接收整个选区，未添加任何连接", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新读取目标输入及已有连线，缩小选区或更换兼容目标", tool: "getCanvasEdges" } });
      connect(target, connections, expectedRevision);
    }
    else if (name === "removeElements") {
      const parsed = uiSchemas.removeElements.parse(args);
      await flushText(target); requireWritable(target, expectedRevision, allowTransition);
      const document = target.getSnapshot().document;
      const ids = new Set(parsed.nodeIds);
      for (;;) {
        const previous = ids.size;
        for (const node of document.nodes) if (ids.has(node.parentId ?? node.parentNode ?? "")) ids.add(node.id);
        if (ids.size === previous) break;
      }
      for (const id of ids) if (findNode(id, target).deletable === false) throw new Error(`节点不允许删除：${id}`);
      const editRevision = target.getSnapshot().editRevision;
      await prepareNodes([...ids], "beforeDelete"); requireWritable(target, undefined, allowTransition);
      if (expectedRevision !== undefined && target.getSnapshot().editRevision !== editRevision) throw new Error("任务收尾期间节点内容已变化，请重新读取后删除");
      for (const id of parsed.edgeIds) {
        const edge = document.edges.find(edge => edge.id === id);
        if (!edge || edge.deletable === false) throw new Error(`连接不存在或不允许删除：${id}`);
      }
      if (document.edges.some(edge => edge.deletable === false && (ids.has(edge.source) || ids.has(edge.target)))) throw new Error("节点存在不可删除的连接");
      const commands = [];
      if (parsed.edgeIds.length) commands.push({ name: "removeEdges", args: { ids: parsed.edgeIds } });
      if (ids.size) commands.push({ name: "removeNodes", args: { ids: [...ids] } });
      if (commands.length) target.execute(parseDocumentCommand({ name: "batch", expectedRevision: target.getSnapshot().revision, args: { commands } }));
    } else if (name === "reparentNodes") {
      const { nodeIds, parentId } = z.strictObject({ nodeIds: uiSchemas.duplicateNodes.shape.nodeIds, parentId: nodeId.nullable() }).parse(args);
      const document = target.getSnapshot().document, roots = selectionRoots(nodeIds, document.nodes);
      function rejectReparent(message: string): never {
        throw new ToolExecutionError({ code: "reparentRejected", message, phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新读取节点分组、绝对坐标和layout限制，选择可编辑的分组目标", tool: "getCanvasNodes", args: { nodeIds: [...new Set([...nodeIds, ...(parentId ? [parentId] : [])])].slice(0, 20), fields: ["parentId", "absolutePosition", "layout"] } } });
      }
      const destination = parentId ? findNode(parentId, target) : undefined;
      if (destination && !["group", "canvasGroup"].includes(destination.type ?? "")) rejectReparent("目标必须是画布分组");
      const rootIds = new Set(roots.map(node => node.id));
      function requireEditableHierarchy(node: CanvasNode) {
        let current: CanvasNode | undefined = node;
        while (current) {
          if (current.draggable === false || current.hidden === true) rejectReparent(`节点或父分组不允许变更分组：${current.id}`);
          const parent: string | undefined = current.parentId ?? current.parentNode;
          current = parent ? findNode(parent, target) : undefined;
        }
      }
      if (destination) {
        requireEditableHierarchy(destination);
        let current: CanvasNode | undefined = destination;
        while (current) {
          if (rootIds.has(current.id)) rejectReparent("不能将节点移入自身或后代分组");
          const parent: string | undefined = current.parentId ?? current.parentNode;
          current = parent ? findNode(parent, target) : undefined;
        }
      }
      const measuredNode = (id: string) => {
        const node = findNode(id, target), size = canvasView?.measure(id);
        return { ...node, width: typeof node.width === "number" ? node.width : size?.width, height: typeof node.height === "number" ? node.height : size?.height };
      };
      const offset = destination ? canvasNodePosition(destination, measuredNode) : { x: 0, y: 0 };
      if (destination) {
        const origin = Array.isArray(destination.origin) && destination.origin.length === 2 && destination.origin.every(value => typeof value === "number" && Number.isFinite(value)) ? destination.origin as [number, number] : [0, 0];
        const size = measuredNode(destination.id);
        if ((origin[0] && !size.width) || (origin[1] && !size.height)) rejectReparent("目标分组尺寸尚未就绪");
        offset.x -= origin[0]! * (size.width ?? 0); offset.y -= origin[1]! * (size.height ?? 0);
      }
      const positions = new Map(roots.map(node => {
        requireEditableHierarchy(node);
        if (node.extent != null) rejectReparent(`节点移动范围受限，不允许变更分组：${node.id}`);
        const position = canvasNodePosition(node, measuredNode);
        return [node.id, { x: position.x - offset.x, y: position.y - offset.y }] as const;
      }));
      const nodes = document.nodes.map(node => {
        const position = positions.get(node.id);
        if (!position || (node.parentId ?? node.parentNode ?? null) === parentId) return node;
        const { parentId: _parentId, parentNode: _parentNode, ...rest } = node;
        return { ...rest, ...(parentId ? { parentId, parentNode: parentId } : {}), expandParent: false, position };
      });
      if (JSON.stringify(nodes) !== JSON.stringify(document.nodes)) target.execute(parseDocumentCommand({ name: "replaceDocument", expectedRevision, args: { document: { ...document, nodes } } }));
      await syncPlugins(target); requireSession(target); scheduleSave(target);
      return { revision: target.getSnapshot().revision, dirty: target.getSnapshot().dirty, parentId, reparentedNodeIds: roots.map(node => node.id), selectedIds: snapshot.selectedIds };
    } else if (name === "groupNodes" || name === "mergeGroups") {
      const { nodeIds } = uiSchemas.duplicateNodes.parse(args);
      const document = target.getSnapshot().document;
      const roots = selectionRoots(nodeIds, document.nodes);
      const merging = name === "mergeGroups";
      if (merging && (roots.length < 2 || roots.some(node => !["group", "canvasGroup"].includes(node.type ?? "")))) throw new Error("请至少选择两个分组");
      if (roots.some(node => node.draggable === false || node.extent != null)) throw new Error("选中节点不允许变更分组");
      const firstParent = roots[0]?.parentId ?? roots[0]?.parentNode;
      const parent = roots.every(node => (node.parentId ?? node.parentNode) === firstParent) ? firstParent : undefined;
      const parentPosition = parent ? absolutePosition(findNode(parent, target), document.nodes) : { x: 0, y: 0 };
      const measured = roots.map(node => { const size = canvasView?.measure(node.id); if (!size) throw new Error(`节点 ${node.id} 尺寸尚未就绪`); return { node, size, position: absolutePosition(node, document.nodes) }; });
      const left = Math.min(...measured.map(item => item.position.x)) - (merging ? 0 : 24);
      const top = Math.min(...measured.map(item => item.position.y)) - (merging ? 0 : 40);
      const width = Math.max(...measured.map(item => item.position.x + item.size.width)) - left + (merging ? 0 : 24);
      const height = Math.max(...measured.map(item => item.position.y + item.size.height)) - top + (merging ? 0 : 24);
      const id = merging ? roots[0]!.id : crypto.randomUUID();
      const group: CanvasNode = { ...(merging ? roots[0] : {}), id, type: "canvasGroup", position: { x: left - parentPosition.x, y: top - parentPosition.y }, width, height,
        ...(parent ? { parentId: parent, parentNode: parent } : {}), connectable: false, expandParent: false, data: merging ? roots[0]!.data ?? {} : { label: "分组", handles: [] } } as CanvasNode;
      if (!parent) { delete group.parentId; delete group.parentNode; }
      const rootIds = new Set(roots.map(node => node.id));
      const nodes = document.nodes.flatMap(node => {
        if (merging && rootIds.has(node.id)) return [];
        if (!(merging ? rootIds.has(node.parentId ?? node.parentNode ?? "") : rootIds.has(node.id))) return [node];
        const position = absolutePosition(node, document.nodes);
        const { extent: _extent, ...rest } = node;
        return [{ ...rest, parentId: id, parentNode: id, expandParent: false, position: { x: position.x - left, y: position.y - top } }];
      });
      nodes.push(group);
      const removed = merging ? new Set(roots.slice(1).map(node => node.id)) : new Set<string>();
      target.execute(parseDocumentCommand({ name: "replaceDocument", expectedRevision, args: { document: { ...document, nodes, edges: document.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) } } }));
      publish({ selectedIds: [id] });
    } else if (name === "ungroupNodes") {
      const { nodeIds } = uiSchemas.duplicateNodes.parse(args);
      const document = target.getSnapshot().document;
      const groups = new Set(nodeIds.filter(id => ["group", "canvasGroup"].includes(findNode(id, target).type ?? "")));
      if (!groups.size) throw new Error("请选择画布分组");
      const promoted: string[] = [];
      const nodes = document.nodes.filter(node => !groups.has(node.id)).map(node => {
        let parent = node.parentId ?? node.parentNode;
        if (!groups.has(parent ?? "")) return node;
        const position = absolutePosition(node, document.nodes);
        while (parent && groups.has(parent)) { const ancestor = findNode(parent, target); parent = ancestor.parentId ?? ancestor.parentNode; }
        const destination = parent ? absolutePosition(findNode(parent, target), document.nodes) : { x: 0, y: 0 };
        const { parentId: _parentId, parentNode: _parentNode, extent: _extent, ...rest } = node;
        promoted.push(node.id);
        return { ...rest, ...(parent ? { parentId: parent, parentNode: parent } : {}), expandParent: false, position: { x: position.x - destination.x, y: position.y - destination.y } };
      });
      target.execute(parseDocumentCommand({ name: "replaceDocument", expectedRevision, args: { document: { ...document, nodes, edges: document.edges.filter(edge => !groups.has(edge.source) && !groups.has(edge.target)) } } }));
      publish({ selectedIds: [...nodeIds.filter(id => !groups.has(id)), ...promoted] });
    } else if (name === "arrangeSelection") {
      const { nodeIds, mode } = z.strictObject({ nodeIds: z.array(nodeId).min(2).max(100), mode: z.enum(["horizontal", "vertical", "grid"]) }).parse(args);
      const document = target.getSnapshot().document;
      const roots = selectionRoots(nodeIds, document.nodes);
      const items = roots.map(node => {
        if (node.draggable === false || node.extent != null) throw new Error(`节点不允许排列：${node.id}`);
        const size = canvasView?.measure(node.id); if (!size) throw new Error(`节点 ${node.id} 尺寸尚未就绪`);
        const position = absolutePosition(node, document.nodes);
        return { node, size, position, parent: { x: position.x - node.position.x, y: position.y - node.position.y } };
      }).sort((a, b) => mode === "horizontal" ? a.position.x - b.position.x || a.position.y - b.position.y : a.position.y - b.position.y || a.position.x - b.position.x);
      const columns = mode === "horizontal" ? items.length : mode === "vertical" ? 1 : Math.ceil(Math.sqrt(items.length));
      const widths = Array<number>(columns).fill(0), heights = Array<number>(Math.ceil(items.length / columns)).fill(0);
      items.forEach((item, index) => { widths[index % columns] = Math.max(widths[index % columns]!, item.size.width); heights[Math.floor(index / columns)] = Math.max(heights[Math.floor(index / columns)]!, item.size.height); });
      let x = Math.min(...items.map(item => item.position.x)), y = Math.min(...items.map(item => item.position.y));
      const xs = widths.map(width => { const previous = x; x += width + 80; return previous; });
      const ys = heights.map(height => { const previous = y; y += height + 80; return previous; });
      const updates = items.map((item, index) => ({ id: item.node.id, changes: { position: {
        x: xs[index % columns]! + (mode === "vertical" ? (widths[0]! - item.size.width) / 2 : 0) - item.parent.x,
        y: ys[Math.floor(index / columns)]! + (mode === "horizontal" ? (heights[0]! - item.size.height) / 2 : 0) - item.parent.y,
      } } }));
      const nodes = structuredClone(document.nodes);
      for (const update of updates) nodes.find(node => node.id === update.id)!.position = update.changes.position;
      const affected = new Set<string>();
      for (const root of roots) { let parent = root.parentId ?? root.parentNode; while (parent) { affected.add(parent); const node = findNode(parent, target); parent = node.parentId ?? node.parentNode; } }
      const depth = (node: CanvasNode) => { let value = 0, parent = node.parentId ?? node.parentNode; while (parent) { value++; const ancestor = findNode(parent, target); parent = ancestor.parentId ?? ancestor.parentNode; } return value; };
      for (const group of nodes.filter(node => affected.has(node.id)).sort((a, b) => depth(b) - depth(a))) {
        const children = nodes.filter(node => (node.parentId ?? node.parentNode) === group.id);
        if (!children.length || group.draggable === false || group.resizable === false || group.extent != null) continue;
        const measured = children.map(node => ({ node, size: affected.has(node.id) && typeof node.width === "number" && typeof node.height === "number" ? { width: node.width, height: node.height } : canvasView?.measure(node.id) }));
        if (measured.some(item => !item.size || item.node.extent != null)) continue;
        const left = Math.min(...children.map(node => node.position.x)) - 24, top = Math.min(...children.map(node => node.position.y)) - 40;
        const width = Math.max(...measured.map(item => item.node.position.x + item.size!.width)) - left + 24, height = Math.max(...measured.map(item => item.node.position.y + item.size!.height)) - top + 24;
        group.position = { x: group.position.x + left, y: group.position.y + top };
        for (const child of children) child.position = { x: child.position.x - left, y: child.position.y - top };
        group.width = width; group.height = height;
        group.style = { ...(group.style && typeof group.style === "object" && !Array.isArray(group.style) ? group.style : {}), width, height };
      }
      // ACT: 排列只贴合原父分组，不触发拖放时的相交归组。
      target.execute(parseDocumentCommand({ name: "replaceDocument", expectedRevision, args: { document: { ...document, nodes } } }));
    } else if (name === "duplicateNodes" || name === "pasteNodes") {
      await flushText(target); requireWritable(target, expectedRevision);
      const pasted = name === "pasteNodes" ? z.strictObject({ command: z.string().max(128), position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }) }).parse(args) : undefined;
      const clipboard = pasted ? await readClipboardNodes(pasted.command, target.getSnapshot().directory) : undefined;
      if (pasted && !clipboard) throw new Error("剪贴板中没有可粘贴的节点");
      requireWritable(target, expectedRevision);
      const document = clipboard ? parseCanvasDocument({ toonflowCanvas: true, ...clipboard, viewport: { x: 0, y: 0, zoom: 1 } }) : target.getSnapshot().document;
      const selected = new Set(clipboard ? document.nodes.map(node => node.id) : uiSchemas.duplicateNodes.parse(args).nodeIds);
      const duplication = pasted ? undefined : uiSchemas.duplicateNodes.parse(args);
      for (;;) {
        const previous = selected.size;
        for (const node of document.nodes) if (selected.has(node.parentId ?? node.parentNode ?? "")) selected.add(node.id);
        if (selected.size === previous) break;
      }
      const remap = new Map([...selected].map(id => [id, crypto.randomUUID()]));
      const clonedData = new Map<string, Record<string, unknown>>();
      for (const id of selected) {
        const node = document.nodes.find(node => node.id === id);
        if (!node) throw new Error(`节点不存在：${id}`);
        const data = structuredClone(node.data ?? {});
        const definition = ["group", "canvasGroup"].includes(node.type ?? "") ? undefined : await ensurePlugin(node.type?.replace(/^remote-/, "") ?? "");
        clonedData.set(id, z.record(z.string(), z.json()).parse(definition?.cloneData ? definition.cloneData(data) : data));
      }
      const files = createWorkspaceFiles(target.getSnapshot().directory);
      const copiedPaths: string[] = [];
      let committed = false;
      try {
        for (const [oldId, newId] of remap) {
          requireWritable(target, expectedRevision);
          try { await files.list(`assets/${oldId}`); }
          catch (error) {
            if ((error as { response?: { data?: { data?: { code?: string } } } }).response?.data?.data?.code === "ENOENT") continue;
            throw error;
          }
          await files.copy(`assets/${oldId}`, `assets/${newId}`); copiedPaths.push(`assets/${newId}`);
        }
        requireWritable(target, expectedRevision);
        const roots = document.nodes.filter(node => selected.has(node.id) && !selected.has(node.parentId ?? node.parentNode ?? ""));
        const offset = pasted ? { x: pasted.position.x - Math.min(...roots.map(node => node.position.x)), y: pasted.position.y - Math.min(...roots.map(node => node.position.y)) } : duplication?.offset ?? { x: 40, y: 40 };
        const remapReference = (value: string) => {
          try { const reference = JSON.parse(decodeURIComponent(value)); if (Array.isArray(reference) && reference.length === 2 && remap.has(reference[0])) return encodeURIComponent(JSON.stringify([remap.get(reference[0]), reference[1]])); } catch { /* 普通文本不是节点引用。 */ }
          return value;
        };
        const nodes = [...selected].map(id => {
          const node = document.nodes.find(node => node.id === id);
          if (!node) throw new Error(`节点不存在：${id}`);
          const parent = node.parentId ?? node.parentNode;
          const relative = parent && remap.has(parent);
          const data = JSON.parse(JSON.stringify(clonedData.get(id), (_key, value: unknown) => {
            if (typeof value !== "string") return value;
            for (const [oldId, newId] of remap) if (value === `assets/${oldId}` || value.startsWith(`assets/${oldId}/`)) return `assets/${newId}${value.slice(`assets/${oldId}`.length)}`;
            return value;
          }));
          if (data.referenceOrder && typeof data.referenceOrder === "object") for (const [handle, order] of Object.entries(data.referenceOrder)) {
            if (Array.isArray(order)) data.referenceOrder[handle] = order.map(value => typeof value === "string" ? remapReference(value) : value);
          }
          if (Array.isArray(data.promptModel)) for (const line of data.promptModel) if (Array.isArray(line)) for (const tag of line) {
            if (tag?.type === "Custom" && typeof tag.html === "string") tag.html = tag.html.replace(/(data-reference-id=["'])([^"']+)(["'])/g, (_match: string, before: string, value: string, after: string) => before + remapReference(value) + after);
          }
          if (!pasted) data.label = `${data.label || "未命名节点"} - 副本`;
          return { ...node, data, id: remap.get(id)!, position: { x: node.position.x + (relative ? 0 : offset.x), y: node.position.y + (relative ? 0 : offset.y) },
            ...(node.parentNode && remap.has(node.parentNode) ? { parentNode: remap.get(node.parentNode)! } : {}),
            ...(node.parentId && remap.has(node.parentId) ? { parentId: remap.get(node.parentId)! } : {}) };
        });
        const edges = duplication?.withEdges === false ? [] : document.edges.filter(edge => remap.has(edge.target) && (remap.has(edge.source) || !pasted))
          .map(edge => ({ ...edge, id: crypto.randomUUID(), source: remap.get(edge.source) ?? edge.source, target: remap.get(edge.target)! }));
        if (duplication?.reparent) {
          const sizes = new Map<string, { width: number; height: number }>();
          for (const [oldId, newId] of remap) { const size = canvasView?.measure(oldId); if (!size) throw new Error(`节点 ${oldId} 尺寸尚未就绪`); sizes.set(newId, size); }
          const proposed = { ...document, nodes: [...document.nodes, ...nodes], edges: [...document.edges, ...edges] };
          const moves = roots.map(node => ({ id: remap.get(node.id)!, position: nodes.find(copy => copy.id === remap.get(node.id))!.position }));
          const placed = finishDraggedNodes(proposed, moves, sizes);
          target.execute(parseDocumentCommand({ name: "replaceDocument", expectedRevision, args: { document: { ...proposed, nodes: placed } } }));
        } else target.execute(parseDocumentCommand({ name: "batch", expectedRevision, args: { commands: [{ name: "addNodes", args: { nodes } }, ...(edges.length ? [{ name: "addEdges", args: { edges } }] : [])] } }));
        committed = true;
        publish({ selectedIds: [...remap.values()] });
      } catch (error) {
        if (!committed) {
          const cleanup = await Promise.allSettled(copiedPaths.map(path => files.remove(path, true)));
          if (cleanup.some(result => result.status === "rejected")) throw new Error(`复制失败，部分新素材清理失败：${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    } else target.execute(parseDocumentCommand({ name, args, expectedRevision }));
    await syncPlugins(target); requireSession(target); scheduleSave(target);
    return { revision: target.getSnapshot().revision, dirty: target.getSnapshot().dirty, selectedIds: snapshot.selectedIds };
  }
  async function addNode(target: DocumentSession, args: z.infer<typeof canvasSchemas.addNode>, expectedRevision?: number) {
    requireWritable(target, expectedRevision);
    const name = args.type.replace(/^remote-/, "");
    const definition = await ensurePlugin(name);
    if (definition.scope === "workspace") throw new Error("工作区插件不能添加为画布节点");
    requireWritable(target, expectedRevision);
    const data = z.record(z.string(), z.json()).parse(definition.createData?.() ?? {});
    const id = crypto.randomUUID();
    target.execute(parseDocumentCommand({ name: "addNodes", expectedRevision, args: { nodes: [{ id, type: `remote-${name}`, position: args.position,
      data: { ...data, label: args.label ?? (typeof data.label === "string" ? data.label : definition.name) } }] } }));
    await syncPlugins(target); requireSession(target); scheduleSave(target);
    if (!transitioning) controller.select([id]);
    return { node: findNode(id, target) };
  }
  function changeHistory(target: DocumentSession, direction: "undo" | "redo", expectedRevision?: number) {
    return serialize(async () => {
      requireWritable(target, expectedRevision, true);
      await prepareNodes(target.getSnapshot().document.nodes.map(node => node.id), "beforeHistory");
      await flushText(target); requireWritable(target, undefined, true);
      await saveSession(target);
      if (workspace?.provider) await workspace.provider.history(target.getSnapshot().canvasId, direction);
      else target[direction]();
      await syncPlugins(target); await saveSession(target); publish();
    });
  }

  function canvasName(name: string) {
    const value = z.string().trim().min(1).max(120).parse(name).replace(/\.json$/i, "");
    if (!value || /[\\/:*?"<>|\0]/.test(value) || value === "." || value === "..") throw new Error("画布名称包含无效字符");
    return value;
  }
  async function writeNewCanvas(directory: string, name?: string, signal?: AbortSignal) {
    const files = createWorkspaceFiles(directory);
    const document = { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    for (let index = 1; index <= 10000; index++) {
      signal?.throwIfAborted();
      const label = name ? canvasName(name) : `画布${index}`;
      const path = `${label}.json`;
      try { await files.writeJson(path, document, true); return { path, name: label }; }
      catch (error) {
        const code = (error as { response?: { data?: { data?: { code?: string } } } }).response?.data?.data?.code;
        if (name || code !== "EEXIST") throw error;
      }
    }
    throw new Error("画布自动编号已用尽，请指定名称");
  }
  function createCanvas(name?: string, signal?: AbortSignal) {
    const target = currentSession();
    return serialize(async () => {
      requireWritable(target, undefined, true); await prepareCanvasSwitch(target);
      signal?.throwIfAborted();
      const file = await writeNewCanvas(target.getSnapshot().directory, name, signal);
      requireSession(target);
      publish({ canvasFiles: [...snapshot.canvasFiles, file] });
      await openCanvas(target.getSnapshot().directory, file.path);
    }, signal);
  }
  function renameCanvas(name: string, path = currentSession().getSnapshot().canvasId, signal?: AbortSignal, fileRevision?: string) {
    const target = currentSession();
    return serialize(async () => {
      requireWritable(target, undefined, true); await prepareCanvasSwitch(target);
      if (workspace?.provider) throw new Error("请先结束协作再重命名画布，以保留协作历史的文件绑定");
      if (!snapshot.canvasFiles.some(file => file.path === path)) throw new Error("目标画布不在当前工程");
      const label = canvasName(name), nextPath = path.slice(0, path.lastIndexOf("/") + 1) + `${label}.json`;
      if (path === nextPath) return;
      signal?.throwIfAborted();
      await createWorkspaceFiles(target.getSnapshot().directory).rename(path, nextPath, fileRevision);
      requireSession(target);
      publish({ canvasFiles: snapshot.canvasFiles.map(file => file.path === path ? { path: nextPath, name: label } : file) });
      if (target.getSnapshot().canvasId === path) await openCanvas(target.getSnapshot().directory, nextPath);
    }, signal);
  }
  async function fitCanvas(target: DocumentSession, ids?: string[]) {
    requireSession(target);
    if (!canvasView) throw new Error("画布视口尚未挂载");
    if (ids) for (const id of ids) findNode(id, target);
    const count = ids?.length ?? target.getSnapshot().document.nodes.length;
    if (!count) return { fitted: false, viewport: target.getSnapshot().document.viewport, nodeCount: 0 };
    const viewport = await canvasView.fit(ids); requireSession(target);
    if (!target.getSnapshot().readOnly) target.execute(parseDocumentCommand({ name: "setViewport", args: { viewport } }));
    return { fitted: true, viewport, nodeCount: count, ...(ids ? { nodeIds: ids.slice(0, 100), truncated: ids.length > 100 } : {}) };
  }
  async function arrangeCanvas(target: DocumentSession, expectedRevision?: number) {
    requireWritable(target, expectedRevision);
    const document = target.getSnapshot().document;
    const nodes = document.nodes.filter(node => !node.parentId && !node.parentNode);
    const graph = new graphlib.Graph().setGraph({ rankdir: "LR", nodesep: 96, ranksep: 160, edgesep: 32 }).setDefaultEdgeLabel(() => ({}));
    for (const node of nodes) {
      if (node.draggable === false) throw new Error(`节点不允许移动：${node.id}`);
      const size = canvasView?.measure(node.id);
      if (!size || size.width <= 0 || size.height <= 0) throw new Error(`节点 ${node.id} 尚未完成尺寸测量`);
      graph.setNode(node.id, size);
    }
    const rootId = (id: string): string => { const node = findNode(id, target); return node.parentId || node.parentNode ? rootId(node.parentId ?? node.parentNode!) : id; };
    for (const edge of document.edges) {
      const source = rootId(edge.source), destination = rootId(edge.target);
      if (source !== destination) graph.setEdge(source, destination);
    }
    if (nodes.length) {
      layout(graph);
      await execute(target, "moveNodes", { nodes: nodes.map(node => { const value = graph.node(node.id); return { id: node.id, position: { x: value.x - value.width / 2, y: value.y - value.height / 2 } }; }) }, expectedRevision);
    }
    const fitted = await fitCanvas(target);
    return { arrangedCount: nodes.length, arrangedNodeIds: nodes.slice(0, 100).map(node => node.id), truncated: nodes.length > 100, viewport: fitted.viewport };
  }

  const controller: WorkbenchController = {
    manageCanvas(action) {
      const target = currentSession(), directory = target.getSnapshot().directory;
      if (action.directory !== undefined && action.directory !== directory) throw new Error("工程已切换，请重新读取目录");
      return serialize(async () => {
        const manager = createCanvasManager(createWorkspaceFiles(directory), {
          async beforeChange(input) {
            requireWritable(target, undefined, true);
            if (["rename", "move", "remove"].includes(input.kind) && workspace?.provider) throw new Error("请先结束协作再移动、重命名或删除画布，以保留协作历史的文件绑定");
            await prepareCanvasSwitch(target); requireWritable(target, undefined, true);
            if (input.kind === "remove" && input.path === target.getSnapshot().canvasId) {
              const next = snapshot.canvasFiles.find(file => file.path !== input.path);
              if (!next) throw new Error("请先新建画布再删除当前画布");
              parseCanvasDocument(await createWorkspaceFiles(directory).readJson(next.path));
            }
          },
          async cloneData(node) {
            if (["group", "canvasGroup"].includes(node.type ?? "")) return node.data;
            const definition = await ensurePlugin(node.type?.replace(/^remote-/, "") ?? ""); requireSession(target);
            return z.record(z.string(), z.json()).parse(definition.cloneData ? definition.cloneData(node.data ?? {}) : node.data ?? {});
          },
          async afterChange(result) {
            requireSession(target); publish({ canvasFiles: result.canvasFiles, canvasFolders: result.canvasFolders });
            let next = result.openPath;
            const active = target.getSnapshot().canvasId;
            if (result.previousPath && (active === result.previousPath || active.startsWith(result.previousPath + "/"))) {
              if (result.nextPath) next = result.nextPath + active.slice(result.previousPath.length);
              else if (result.removed) next = result.canvasFiles[0]?.path;
            }
            if (next && next !== active) {
              try { await openCanvas(directory, next); }
              catch (error) { if (result.previousPath && (result.nextPath || result.removed) && (active === result.previousPath || active.startsWith(result.previousPath + "/"))) target.setReadOnly(true); throw error; }
            }
          },
        });
        await manager.apply(action);
      });
    },
    async renameProject(name) {
      const target = currentSession(); requireWritable(target);
      const label = z.string().trim().min(1).max(120).parse(name);
      if (window.openCinemaTransport) { publish({ projectName: label }); return; }
      const stored = localStorage.getItem("toonflow.projectList");
      const previous = stored ? z.record(z.string(), z.unknown()).parse(JSON.parse(stored)) : {};
      const directory = target.getSnapshot().directory;
      const projects = Array.isArray(previous.projectList) ? previous.projectList : [];
      const project = { ...(previous.project && typeof previous.project === "object" ? previous.project : {}), directory, name: label };
      localStorage.setItem("toonflow.projectList", JSON.stringify({ ...previous, project, projectList: projects.map(item => item && typeof item === "object" && item.directory === directory ? { ...item, name: label } : item) }));
      publish({ projectName: label });
    },
    async compatibleNodeTypes(id, handleId, direction) {
      const target = currentSession(); requireWritable(target);
      return (await compatibleEndpointTypes(target, connectionEndpointSchema.parse({ nodeId: id, handleId, direction }))).types;
    },
    async addConnectedNode(type, position, endpoint) {
      await addEndpointNode(currentSession(), { type, position, endpoint: connectionEndpointSchema.parse(endpoint) });
    },
    refreshPlugins,
    async setPluginEnabled(id, enabled) {
      nodeId.parse(id);
      await serialize(async () => {
        if (!enabled && session) {
          await prepareNodes(session.getSnapshot().document.nodes.filter(node => node.type?.replace(/^remote-/, "") === id).map(node => node.id), "beforeHistory");
          await saveSession(session);
        }
        const response = await fetch("/api/nodes/setEnabled", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ name: id, enabled }) });
        const value = await response.json(); if (!response.ok || value.code !== 200) throw new Error(value.message || "插件状态保存失败");
        await refreshPlugins(true);
      });
    },
    getHistory() { const target = currentSession(); const state = target.getSnapshot(); return { mode: workspace?.provider ? "collaboration" : "local", revision: state.revision, savedRevision: state.savedRevision, entries: workspace?.provider ? [] : target.getHistory() }; },
    getNodeService(id) {
      findNode(id);
      const service = workbenches.get(id);
      if (!service || !runtime.getInstance(id)) throw new Error(`节点插件未就绪：${id}`);
      return service;
    },
    async callNodeTool(id, name, args, signal) {
      const target = currentSession(); findNode(id, target);
      const result = await runtime.callTool({ instanceId: id, name: name.replace(/^node:/, ""), args }, AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]));
      requireSession(target); return result;
    },
    getPluginService(id) { assertAlive(); return runtime.getInstance(id)?.service; },
    getWorkspacePlugin(id) {
      const instance = runtime.getInstance(`workspace:${id}`);
      return instance?.view ? { view: instance.view as unknown as ComponentType<{ service: unknown }>, service: instance.service } : undefined;
    },
    validateConnection(connection) { const target = currentSession(), document = target.getSnapshot().document; return !target.getSnapshot().readOnly && !transitioning && validConnection(document.nodes, document.edges, connection); },
    attachCanvasView(view) { canvasView = view; publish({ canvasView: view.getOptions?.() }); return () => { if (canvasView === view) { canvasView = undefined; publish({ canvasView: undefined }); } }; },
    attachNodeEditorView(nodeId, adapter) {
      const entry = { adapter, session: currentSession() }; nodeEditorViews.set(nodeId, entry);
      return () => { if (nodeEditorViews.get(nodeId) === entry) nodeEditorViews.delete(nodeId); };
    },
    attachComposer(listener) { composerListeners.add(listener); return () => { composerListeners.delete(listener); }; },
    addCanvas(name) { return createCanvas(name); },
    renameCanvas(name, fileRevision) { return renameCanvas(name, undefined, undefined, fileRevision); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    openProject(directory, initialCanvasId) { return serialize(async () => {
      const requestedCanvas = initialCanvasId === undefined ? undefined : relativePath.parse(initialCanvasId);
      if (session) await prepareCanvasSwitch(session);
      const listing = await createWorkspaceFiles(directory).list("", controllerLifetime.signal);
      const discovered = await discoverWorkspaceCanvases(createWorkspaceFiles(listing.directory), controllerLifetime.signal);
      const canvases = discovered.canvasFiles;
      if (requestedCanvas !== undefined && !canvases.some(file => file.path === requestedCanvas)) throw new Error("指定画布不在当前工程目录");
      if (!canvases.length) canvases.push(await writeNewCanvas(listing.directory));
      await openCanvas(listing.directory, requestedCanvas ?? (canvases.find(file => file.path === "画布1.json") ?? canvases[0])!.path);
      let projectName = listing.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? listing.directory;
      if (!window.openCinemaTransport) try {
        const cache = JSON.parse(localStorage.getItem("toonflow.projectList") ?? "{}");
        const stored = Array.isArray(cache.projectList) ? cache.projectList.find((item: { directory?: string; name?: string }) => item?.directory === listing.directory) : undefined;
        if (typeof stored?.name === "string" && stored.name.trim()) projectName = stored.name;
      } catch { /* 工程缓存不影响磁盘目录读取。 */ }
      publish({ projectName, canvasFiles: canvases, canvasFolders: discovered.canvasFolders });
      const project = { directory: listing.directory, name: snapshot.projectName, lastOpenedAt: Date.now() };
      if (!window.openCinemaTransport) try {
        let previous: Record<string, unknown> = {};
        const stored = localStorage.getItem("toonflow.projectList");
        if (stored) {
          try { previous = z.record(z.string(), z.unknown()).parse(JSON.parse(stored)); }
          catch { /* 最近工程缓存损坏不影响已经读取的工程文件。 */ }
        }
        const projects = (Array.isArray(previous.projectList) ? previous.projectList : []).filter(item => item && typeof item === "object" && typeof item.directory === "string" && item.directory !== project.directory);
        localStorage.setItem("toonflow.projectList", JSON.stringify({ ...previous, project, projectList: [project, ...projects] }));
      } catch (error) { publish({ error: `工程已打开，但最近工程记录更新失败：${error instanceof Error ? error.message : String(error)}` }); }
    }); },
    switchCanvas(path, signal) {
      const target = currentSession();
      return serialize(async () => {
        requireSession(target); await prepareCanvasSwitch(target);
        if (!snapshot.canvasFiles.some(file => file.path === path)) throw new Error("画布不在当前工程目录");
        await openCanvas(target.getSnapshot().directory, path, signal);
      }, signal);
    },
    async execute(name, args) {
      const target = currentSession();
      if (name === "getCompatibleNodeTypes") { const input = additionalCanvasOperations.find(tool => tool.name === name)!.parameters.parse(args) as z.infer<typeof connectionEndpointSchema>; return compatibleEndpointTypes(target, input); }
      if (name === "addConnectedNode") { const input = additionalCanvasOperations.find(tool => tool.name === name)!.parameters.parse(args) as { type: string; position: { x: number; y: number }; endpoint: z.infer<typeof connectionEndpointSchema> }; return addEndpointNode(target, input); }
      if (name === "getCompatibleSelectionNodeTypes") { const input = additionalCanvasOperations.find(tool => tool.name === name)!.parameters.parse(args) as { nodeIds: string[] }; return compatibleSelectionTypes(target, input.nodeIds); }
      if (name === "addConnectedSelectionNode") { const input = additionalCanvasOperations.find(tool => tool.name === name)!.parameters.parse(args) as { nodeIds: string[]; type: string; position: { x: number; y: number } }; return addConnectedSelection(target, input); }
      if (name === "setCanvasView") return executePeripheral(name, args, lifetime.signal);
      if (name === "copyNodes") {
        const { nodeIds, preferImage } = uiSchemas.duplicateNodes.extend({ preferImage: z.boolean().optional() }).parse(args);
        const directory = target.getSnapshot().directory, signal = lifetime.signal;
        if (!target.getSnapshot().readOnly) await saveSession(target);
        requireSession(target); signal.throwIfAborted();
        const document = target.getSnapshot().document, ids = new Set(nodeIds);
        for (;;) { const previous = ids.size; for (const node of document.nodes) if (ids.has(node.parentId ?? node.parentNode ?? "")) ids.add(node.id); if (ids.size === previous) break; }
        const nodes = document.nodes.filter(node => ids.has(node.id)).map(node => {
          if (!node.parentId && !node.parentNode || ids.has(node.parentId ?? node.parentNode!)) return node;
          const { parentId: _parentId, parentNode: _parentNode, extent: _extent, ...rest } = node;
          let parent = document.nodes.find(item => item.id === (node.parentId ?? node.parentNode));
          let position = { ...node.position };
          while (parent) { position = { x: position.x + parent.position.x, y: position.y + parent.position.y }; parent = document.nodes.find(item => item.id === (parent!.parentId ?? parent!.parentNode)); }
          return { ...rest, position };
        });
        const image = preferImage && nodes.length === 1 ? Object.values(nodes[0]!.data?.outputs ?? {}).find(output => isNodeOutput(output) && output.dataType === "IMAGE" && typeof output.value === "object") : undefined;
        if (isNodeOutput(image) && typeof image.value === "object" && typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined" && (typeof ClipboardItem.supports !== "function" || ClipboardItem.supports("image/png"))) {
          const revision = target.getSnapshot().revision;
          const content = await createWorkspaceFiles(directory).read(image.value.url, 100 * 1024 ** 2, signal);
          requireSession(target); signal.throwIfAborted();
          if (target.getSnapshot().revision !== revision) throw new Error("节点已变化，请重新复制图片");
          await writeClipboardImage(new Blob([content], { type: image.value.mimeType || "image/png" }));
          return { copied: 1, content: "image" };
        }
        await copyNodesToClipboard(nodes as unknown as Parameters<typeof copyNodesToClipboard>[0], document.edges as unknown as Parameters<typeof copyNodesToClipboard>[1], directory);
        return { copied: nodes.length };
      }
      if (name === "arrangeCanvas") { canvasSchemas.arrangeCanvas.parse(args); const result = await arrangeCanvas(target); await saveSession(target); return result; }
      return execute(target, name, args);
    },
    async importMedia(files, position) {
      const target = currentSession(); requireWritable(target);
      if (!files.length || files.length > 64) throw new Error("每次导入 1–64 个媒体或文本文件");
      for (const file of files) {
        const { kind } = inferMediaFileType(file);
        if (!kind) throw new Error(`暂不支持此文件类型：${file.name}`);
        if (!file.size || file.size > 100 * 1024 ** 2) throw new Error(`文件为空或超过当前工作区100MiB写入上限：${file.name}`);
        if (kind === "text" && file.size > 1000000) throw new Error("文本文件最多 1 MB");
      }
      for (const [index, file] of files.entries()) {
        requireWritable(target);
        const { kind: type, mimeType } = inferMediaFileType(file);
        if (!type) throw new Error(`暂不支持此文件类型：${file.name}`);
        const text = type === "text" ? await file.text() : undefined; requireWritable(target);
        const { node } = await addNode(target, { type: `${type}Node`, position: { x: position.x + index % 4 * 400, y: position.y + Math.floor(index / 4) * 300 }, label: file.name });
        requireWritable(target);
        const service = controller.getNodeService(node.id);
        if (type === "text") {
          stageText(node.id, text!, target); await saveSession(target);
        } else {
          const path = await uploadNodeFile(service.files, node.id, file); requireWritable(target);
          await controller.callNodeTool(node.id, `set${type[0]!.toUpperCase()}${type.slice(1)}`, { path, mimeType });
        }
      }
      await saveSession(target);
    },
    select(ids) {
      const target = currentSession();
      if (transitioning) throw new Error("工程正在切换或恢复历史，请稍后选择");
      const parsed = z.array(nodeId).max(10000).parse(ids);
      for (const id of parsed) if (findNode(id, target).selectable === false) throw new Error(`节点不允许选择：${id}`);
      publish({ selectedIds: [...new Set(parsed)] });
    },
    async save() { if (session) await saveSession(session); },
    undo() { return changeHistory(currentSession(), "undo"); },
    redo() { return changeHistory(currentSession(), "redo"); },
    async sendPrompt(prompt, options = {}) {
      const adapter = host, target = currentSession();
      requireWritable(target);
      const ids = [...new Set(z.array(nodeId).max(20).parse(options.nodeIds ?? snapshot.selectedIds))];
      for (const id of ids) findNode(id, target);
      const action = options.action ? z.strictObject({ nodeId, tool: z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/) }).parse(options.action) : undefined;
      if (action && (ids.length !== 1 || ids[0] !== action.nodeId || activated.get(action.nodeId)?.composer?.tool !== action.tool)) throw new Error("创作对象或插件能力已变化，请重新选择");
      const maxLength = action ? activated.get(action.nodeId)?.composer?.maxLength ?? 16000 : 16000;
      const instruction = z.string().trim().min(1).max(maxLength, `创作指令最多 ${maxLength} 字`).parse(prompt);
      const instance = action ? runtime.getInstance(action.nodeId) : undefined;
      function assertComposerReady() {
        const state = action ? getComposerState(activated.get(action.nodeId)?.composer, findNode(action.nodeId, target).data ?? {}) : { requiresHost: true };
        if (state.disabledReason) throw new Error(state.disabledReason);
        if (state.requiresHost && (!adapter || host !== adapter || adapter.getState() !== "connected" || !adapter.capabilities.requests.includes("edit"))) throw new Error("宿主 Agent 尚未连接或不支持编辑请求");
      }
      assertComposerReady();
      const signal = lifetime.signal;
      await saveSession(target); requireWritable(target);
      for (const id of ids) findNode(id, target);
      assertComposerReady();
      if (action) {
        if (!instance || runtime.getInstance(action.nodeId) !== instance || activated.get(action.nodeId)?.composer?.tool !== action.tool) throw new Error("创作插件已变化，请重新选择");
        const result = await controller.callNodeTool(action.nodeId, action.tool, { prompt: instruction }, signal);
        const reply = result && typeof result === "object" ? result as { taskId?: string; requestId?: string; status?: string } : {};
        return { requestId: reply.taskId ?? reply.requestId ?? crypto.randomUUID(), status: reply.status === "completed" ? "completed" : "accepted", result };
      }
      if (host !== adapter || adapter!.getState() !== "connected") throw new Error("宿主 Agent 已切换，请重新发送");
      return adapter!.sendRequest({ kind: "edit", prompt: instruction, context: getHostContext(ids), metadata: { operation: "editSelection", targetNodeIds: ids } }, { signal });
    },
    addNode(type, position) { return addNode(currentSession(), canvasSchemas.addNode.parse({ type, position })); },
    async exportProject() {
      const target = currentSession(); await saveSession(target); requireSession(target);
      const projectName = snapshot.projectName;
      const data = await createWorkspaceFiles(target.getSnapshot().directory).exportProject(controllerLifetime.signal);
      if (window.openCinemaTransport) { await window.openCinemaTransport.downloadFile(data, `${projectName}.openCinema.zip`); return; }
      const url = URL.createObjectURL(data); const link = document.createElement("a"); link.href = url; link.download = `${projectName}.openCinema.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    async acquireMedia(path, mimeType) {
      const target = currentSession();
      const media = createWorkspaceFiles(target.getSnapshot().directory).acquireUrl(relativePath.parse(path), mimeType);
      try { const url = await media.url; requireSession(target); return { url, release: media.release }; }
      catch (error) { media.release(); throw error; }
    },
    async readNodeText(id) { return readText(id, currentSession()); },
    async reloadNodeText(id) {
      const target = currentSession(), draft = drafts.get(id);
      findNode(id, target);
      if (draft) await pendingText.get(draft)?.catch(() => {});
      requireSession(target);
      if (drafts.get(id) && drafts.get(id) !== draft) throw new Error("正文在重新读取期间有新草稿，请先保留最新编辑");
      const text = await readCommittedText(findNode(id, target), target);
      requireSession(target);
      if (drafts.get(id) && drafts.get(id) !== draft) throw new Error("正文在重新读取期间有新草稿，请先保留最新编辑");
      if (drafts.get(id) === draft) drafts.delete(id);
      publish(); return text;
    },
    stageNodeText(id, text) { const target = currentSession(); stageText(id, text, target); scheduleSave(target); },
    async writeNodeText(id, text) {
      const target = currentSession(), draft = drafts.get(id);
      if (!draft || draft.session !== target) return;
      if (draft.text !== text) throw new Error("正文草稿已更新，请继续编辑最新内容");
      await persistText(id, draft);
    },
    getNodeView: type => views.get(type),
  };

  function getHostContext(selectedIds = snapshot.selectedIds): HostContext {
    const ids = [...new Set(selectedIds)].slice(0, 20), canvas = snapshot.document;
    const references: NonNullable<HostContext["references"]>[number][] = [];
    const byId = new Map((canvas?.nodes ?? []).map(node => [node.id, node])), selected = new Set(ids), children = new Map<string, string[]>();
    for (const node of byId.values()) {
      const parentId = node.parentId ?? node.parentNode;
      if (!parentId) continue;
      const siblings = children.get(parentId) ?? [];
      siblings.push(node.id); children.set(parentId, siblings);
    }
    const pending = ids.filter(id => {
      let parentId = byId.get(id)?.parentId ?? byId.get(id)?.parentNode;
      while (parentId) { if (selected.has(parentId)) return false; const parent = byId.get(parentId); parentId = parent?.parentId ?? parent?.parentNode; }
      return true;
    });
    const visited = new Set<string>(), targets: Record<string, unknown>[] = [];
    let remaining = 100, targetsTruncated = false;
    const withinBudget = () => new TextEncoder().encode(JSON.stringify({ targets, references })).length <= 52 * 1024;
    while (pending.length) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = byId.get(id);
      if (!node || !canvas) continue;
      if (targets.length === 20) { targetsTruncated = true; break; }
      const group = ["group", "canvasGroup"].includes(node.type ?? ""), members = group ? children.get(id) ?? [] : [];
      if (group) pending.unshift(...members);
      const handles = Array.isArray(node.data?.handles) ? node.data.handles as { id: string; type: string }[] : [];
      const values = handles.filter(handle => handle.type === "target").flatMap(handle => getTargetValues(id, handle.id, canvas.nodes as unknown as PortNode[], canvas.edges as unknown as PortEdge[]));
      const inputs: Record<string, unknown>[] = [], target = { id: node.id, type: node.type, label: node.data?.label?.slice(0, 512), parentId: node.parentId ?? node.parentNode ?? null, ...(group ? { children: members.slice(0, 20), childCount: members.length, childrenTruncated: members.length > 20 } : {}), inputs, inputsTruncated: false };
      targets.push(target);
      if (!withinBudget()) { targets.pop(); targetsTruncated = true; break; }
      for (const input of values.slice(0, remaining)) {
        const reference = input.value && typeof input.value === "object" && "url" in input.value && typeof input.value.url === "string" && input.value.url.length <= 4096 && !input.value.url.startsWith("data:") ? { path: input.value.url, ...(typeof input.value.mimeType === "string" ? { mimeType: input.value.mimeType } : {}), label: input.source } : undefined;
        inputs.push({ source: input.source, sourceHandle: input.sourceHandle, dataType: input.dataType, available: input.value !== undefined, ...(typeof input.value === "string" ? { preview: input.value.slice(0, 512) } : {}) });
        if (reference) references.push(reference);
        if (!withinBudget()) { inputs.pop(); if (reference) references.pop(); break; }
        remaining--;
      }
      target.inputsTruncated = values.length > inputs.length;
    }
    return { ...(snapshot.directory ? { workspaceId: snapshot.directory } : {}), ...(snapshot.canvasId ? { documentId: snapshot.canvasId } : {}), revision: snapshot.revision, documentRevision: session?.getSnapshot().revision ?? 0, toolCatalogVersion: runtime.getVersion(), selectedNodeIds: ids,
      references, data: { targets, selectedTruncated: selectedIds.length > ids.length, targetsTruncated, selectionScope: "selectedNodesAndGroupDescendants", ...(targets.some(node => Array.isArray(node.children)) ? { groupReadback: { tool: "getCanvasNodes", fields: ["parentId", "children", "absolutePosition"], memberPagination: { path: ["children"], valueOffset: 0, valueLimit: 30 } } } : {}) } };
  }
  const nodeTools = {
    get tools() { return runtime.listTools().filter(tool => !!tool.nodeId).map(tool => ({ nodeId: tool.nodeId!, name: `node:${tool.name}` as const, description: tool.description, parameters: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, requires: { ...pluginRequirements.get(tool.pluginId), ...tool.requires } })); },
    get version() { return runtime.getVersion(); },
    *list(ids: string[], names?: string[]) {
      for (const tool of runtime.listTools(ids)) if (tool.nodeId && (!names || names.includes(`node:${tool.name}`))) yield {
        nodeId: tool.nodeId, name: `node:${tool.name}` as const, description: tool.description, parameters: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations, requires: { ...pluginRequirements.get(tool.pluginId), ...tool.requires },
      };
    },
    call(request: { nodeId: string; name: string; args: Record<string, unknown> }, signal?: AbortSignal) { return runtime.callTool({ instanceId: request.nodeId, name: request.name.replace(/^node:/, ""), args: request.args }, signal); },
  };
  const queries = createCanvasQueries({
    nodes: () => (snapshot.document?.nodes ?? []).map(node => ({ ...node, width: node.width ?? canvasView?.measure(node.id)?.width, height: node.height ?? canvasView?.measure(node.id)?.height, selected: snapshot.selectedIds.includes(node.id) })),
    edges: () => snapshot.document?.edges ?? [], findNode: id => {
      const node = snapshot.document?.nodes.find(node => node.id === id);
      return node ? { ...node, width: node.width ?? canvasView?.measure(id)?.width, height: node.height ?? canvasView?.measure(id)?.height, selected: snapshot.selectedIds.includes(id) } : undefined;
    },
    viewport: () => snapshot.document?.viewport ?? { x: 0, y: 0, zoom: 1 }, selectedCount: () => snapshot.selectedIds.length,
    nodeRevision: () => queryRevision, edgeRevision: () => queryRevision, documentRevision: () => session?.getSnapshot().revision ?? 0,
    canvases: async () => snapshot.canvasFiles.map(file => ({ id: file.path, name: file.name })),
    nodeTypes: () => snapshot.plugins.map(plugin => { const availability = pluginAvailability(plugin.type.replace(/^remote-/, "")); return { ...plugin, requires: availability.requires, availability }; }),
    nodeAvailability: ids => ids.map(id => { const node = findNode(id), pluginId = node.type?.replace(/^remote-/, "") ?? ""; return { nodeId: id, pluginId, ...pluginAvailability(pluginId, id) }; }), runtime: runtimeSummary, nodeTools: () => nodeTools,
  });
  async function contentRevision(content: BufferSource) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function boundedPage<T>(values: T[], offset: number, limit: number) {
    const items: T[] = [];
    for (const value of values.slice(offset, offset + limit)) {
      if (new TextEncoder().encode(JSON.stringify([...items, value])).length > 52 * 1024) {
        if (!items.length) throw new Error("单项结果超过52KiB，请缩小查询范围");
        break;
      }
      items.push(value);
    }
    const nextOffset = offset + items.length;
    return { items, total: values.length, hasMore: nextOffset < values.length, ...(nextOffset < values.length ? { nextOffset } : {}) };
  }
  function secretField(field: string, rule?: Record<string, unknown>) {
    const props = rule?.props;
    return (field !== "showPassword" && /^(?:api.?key|token|bearer)$|(?:api.?key|access.?key|auth.?token|access.?token|refresh.?token|secret|password|credential|authorization)$/i.test(field)) || rule?.type === "password" || props && typeof props === "object" && Reflect.get(props, "type") === "password" || rule?.secret === true || rule?.sensitive === true;
  }
  function publicConfiguration(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(publicConfiguration);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, secretField(field) ? { configured: entry !== undefined && entry !== "", secret: true } : publicConfiguration(entry)]));
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      try { const url = new URL(value); url.username = ""; url.password = ""; for (const field of [...url.searchParams.keys()]) if (secretField(field)) url.searchParams.set(field, "[redacted]"); return url.href; } catch { return value; }
    }
    return value ?? null;
  }
  async function readPluginPackage(path: string, target: DocumentSession, signal: AbortSignal) {
    const content = await createWorkspaceFiles(target.getSnapshot().directory).read(path, 100 * 1024 ** 2, signal);
    requireSession(target); signal.throwIfAborted();
    return { value: pluginPackageSchema.parse(JSON.parse(new TextDecoder().decode(content))), fileRevision: await contentRevision(content), size: content.byteLength };
  }
  async function executePeripheral(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (name === "getCanvasPreferences" || name === "setCanvasPreferences") {
      peripheralToolSchemas[name].parse(args);
      const result = name === "setCanvasPreferences" ? await workbenchSettingsClient.saveGeneralConfiguration(peripheralToolSchemas.setCanvasPreferences.parse(args).changes, peripheralToolSchemas.setCanvasPreferences.parse(args).expectedRevision, signal) : await workbenchSettingsClient.generalConfiguration(signal);
      const general = Object.fromEntries(Object.entries(result.general).filter(([key]) => ["nodeMenu", "canvasShortcuts", "canvasEdgeAnimationEnabled", "canvasEdgeColorMode", "canvasEdgeColor"].includes(key)));
      if (name === "setCanvasPreferences") window.dispatchEvent(new Event("openCinema:general-settings-changed"));
      return { general, configRevision: result.configRevision, ...(name === "setCanvasPreferences" ? { saved: true } : {}) };
    }
    if (name === "getMediaToolsConfiguration") {
      peripheralToolSchemas.getMediaToolsConfiguration.parse(args);
      const [configuration, status] = await Promise.all([workbenchSettingsClient.ffmpegConfiguration(signal), workbenchSettingsClient.ffmpegStatus(signal)]);
      return { ...configuration, status };
    }
    if (name === "setMediaToolsConfiguration") {
      const input = peripheralToolSchemas.setMediaToolsConfiguration.parse(args);
      const result = await workbenchSettingsClient.saveFfmpegConfiguration(input.changes, input.expectedRevision, signal);
      return { ...result, saved: true };
    }
    if (name === "prepareMediaToolsDownload" || name === "cancelMediaToolsDownload") {
      const input = peripheralToolSchemas[name].parse(args);
      const progress = name === "prepareMediaToolsDownload" ? await workbenchSettingsClient.downloadFfmpeg((input as { source: string }).source, signal) : await workbenchSettingsClient.cancelFfmpeg(signal);
      return { progress, observe: "getMediaToolsConfiguration" };
    }
    if (name === "getProviderModels" || name === "setProviderModels") {
      const input = peripheralToolSchemas[name].parse(args);
      if (name === "setProviderModels") {
        // 工作流会在 ComfyUI 上执行，只能由用户在设置页导入；Agent 可以改名或移除已有工作流，不能新增或改图。
        const saved = (await workbenchSettingsClient.providers(signal)).find(provider => provider.id === input.providerId)?.models ?? [];
        const changed = peripheralToolSchemas.setProviderModels.parse(args).models.some(model => "comfy" in model && JSON.stringify(model.comfy) !== JSON.stringify(saved.find(item => item.id === model.id)?.comfy));
        if (changed) throw new Error("ComfyUI 工作流只能由用户在设置页导入；Agent 不能新增或修改工作流");
      }
      const provider = name === "setProviderModels" ? await workbenchSettingsClient.saveProviderModels(input.providerId, peripheralToolSchemas.setProviderModels.parse(args).models, peripheralToolSchemas.setProviderModels.parse(args).expectedRevision, signal) : (await workbenchSettingsClient.providers(signal)).find(provider => provider.id === input.providerId);
      if (!provider) throw new Error("供应商不存在");
      if (name === "setProviderModels") { window.dispatchEvent(new Event("toonflow:provider-config-changed")); return { providerId: provider.id, providerRevision: provider.revision, modelCount: provider.models.length, saved: true }; }
      const page = peripheralToolSchemas.getProviderModels.parse(args);
      if (page.offset > 0 && !page.providerRevision || page.providerRevision && page.providerRevision !== provider.revision) throw new Error("供应商模型目录已变化或缺少分页修订，请从offset:0重新读取");
      const { items, ...pagination } = boundedPage(provider.models, page.offset, page.limit);
      return { providerId: provider.id, providerRevision: provider.revision, models: items, ...pagination };
    }
    if (name === "refreshProviderModels") {
      const input = peripheralToolSchemas.refreshProviderModels.parse(args), provider = await workbenchSettingsClient.fetchProviderModels(input.providerId, input.expectedRevision, signal);
      window.dispatchEvent(new Event("toonflow:provider-config-changed"));
      return { providerId: provider.id, providerRevision: provider.revision, modelCount: provider.models.length, saved: true };
    }
    if (name === "manageMediaProviders") {
      const input = peripheralToolSchemas.manageMediaProviders.parse(args);
      let providerId: string, providerRevision: string | undefined;
      if (input.action === "remove") { await workbenchSettingsClient.removeProvider(input.providerId, input.expectedRevision, signal); providerId = input.providerId; }
      else {
        let provider;
        if (input.action === "restoreBuiltin") provider = await workbenchSettingsClient.addBuiltinProvider(input.builtinId, signal);
        else {
          const target = currentSession(), content = await createWorkspaceFiles(target.getSnapshot().directory).read(input.path, 2 * 1024 ** 2, signal);
          requireSession(target); signal.throwIfAborted();
          if (await contentRevision(content) !== input.fileRevision) throw new Error("供应商清单已变化，请重新读取fileRevision");
          const source = new TextDecoder().decode(content);
          if (JSON.parse(source).models?.some?.((model: { comfy?: unknown }) => model?.comfy)) throw new Error("ComfyUI 工作流只能由用户在设置页导入；Agent 不能通过清单写入工作流");
          provider = await workbenchSettingsClient.addProvider(source, signal); requireSession(target);
        }
        providerId = provider.id; providerRevision = provider.revision;
      }
      window.dispatchEvent(new Event("toonflow:provider-config-changed"));
      return { action: input.action, providerId, providerRevision, completed: true };
    }
    if (name === "exportPluginPackage") {
      const input = peripheralToolSchemas.exportPluginPackage.parse(args), target = currentSession();
      requireToolCanvas(target, input.canvasId); requireWritable(target, requireToolRevision(target, input.expectedRevision));
      const value = await workbenchSettingsClient.pluginPackage(input.pluginId, input.pluginRevision, signal), content = new TextEncoder().encode(JSON.stringify(value, null, 2));
      requireWritable(target, input.expectedRevision); signal.throwIfAborted();
      const files = createWorkspaceFiles(target.getSnapshot().directory);
      await files.write(input.path, new Blob([content]), true, signal);
      const artifact = await files.stat(input.path, signal); requireSession(target);
      if (artifact.fileRevision !== await contentRevision(content) || artifact.size !== content.byteLength) throw new Error("插件发行包写入后SHA256回读不一致");
      return { pluginId: input.pluginId, pluginRevision: input.pluginRevision, artifact: { path: input.path, size: artifact.size, fileRevision: artifact.fileRevision }, saved: true };
    }
    if (name === "getNodeEditorView" || name === "setNodeEditorView") {
      const input = peripheralToolSchemas[name].parse(args), target = currentSession();
      requireToolCanvas(target, input.canvasId); findNode(input.nodeId, target);
      const entry = nodeEditorViews.get(input.nodeId);
      if (!entry || entry.session !== target) throw new ToolExecutionError({ code: "nodeViewNotMounted", message: "节点编辑视图尚未挂载", phase: "target", target: { ...toolTarget(target), nodeId: input.nodeId }, executionState: "notDispatched", recovery: { action: "readState", message: "先fitCanvas展示此节点，再读取节点编辑视图", tool: "fitCanvas", args: { canvasId: input.canvasId, nodeIds: [input.nodeId] } } });
      let view = entry.adapter.read();
      if (name === "setNodeEditorView") {
        const change = peripheralToolSchemas.setNodeEditorView.parse(args);
        const revisionConflict = change.expectedViewRevision !== view.viewRevision;
        if (revisionConflict || (change.open && !view.available) || transitioning) throw new ToolExecutionError({ code: revisionConflict ? "nodeEditorViewRevisionConflict" : "nodeEditorUnavailable", message: revisionConflict ? "节点编辑器视图已变化，请重新读取" : "节点编辑器当前不可切换", phase: "target", target: { ...toolTarget(target), nodeId: input.nodeId }, executionState: "notDispatched", expectedRevision: change.expectedViewRevision, actualRevision: view.viewRevision, recovery: { action: "readState", message: "重新读取节点编辑视图并采用最新viewRevision", tool: "getNodeEditorView", args: { canvasId: input.canvasId, nodeId: input.nodeId } } });
        view = await entry.adapter.set(change, signal);
      }
      requireSession(target); signal.throwIfAborted();
      return { view, persistence: "session" };
    }
    if (name === "getCanvasView" || name === "setCanvasView") {
      const input = peripheralToolSchemas[name].parse(args), target = currentSession();
      if (input.canvasId !== undefined) requireToolCanvas(target, input.canvasId);
      if (!canvasView?.getOptions || !canvasView.setOptions) throw new Error("画布视图尚未挂载");
      if (name === "setCanvasView") { const { canvasId: _canvasId, ...changes } = input; canvasView.setOptions(changes); }
      const options = canvasView.getOptions(); publish({ canvasView: options });
      return { options, persistence: "session" };
    }
    if (name === "getFileTransferCapabilities") {
      peripheralToolSchemas.getFileTransferCapabilities.parse(args);
      return { provider: window.openCinemaTransport ? "nativeWidget" : "reactWeb", workspaceWriteMaxBytes: 100 * 1024 ** 2, workspaceRangeMaxBytes: 8 * 1024 ** 2, agentInlineMaxBytes: 20 * 1024 ** 2, assetMaxBytes: 100 * 1024 ** 2, mediaImportMaxBytes: 100 * 1024 ** 2, mediaImportBatchMaxBytes: 100 * 1024 ** 2, mediaImportMaxFiles: 20, textImportMaxBytes: 1000000, savedArchiveMaxBytes: 2 * 1024 ** 3 + 128 * 1024 ** 2, nativeUpload: "stagedChunks", largeFileImport: "workspaceFiles.importMedia → importWorkspaceMedia", contentInAgentContext: false };
    }
    if (name === "importWorkspaceMedia") {
      const input = peripheralToolSchemas.importWorkspaceMedia.parse(args), target = currentSession();
      requireToolCanvas(target, input.canvasId); requireWritable(target, requireToolRevision(target, input.expectedRevision));
      const files = createWorkspaceFiles(target.getSnapshot().directory), imported: { path: string; fileRevision: string; size: number }[] = [], media: File[] = [];
      let totalSize = 0;
      const sources: (typeof input.files[number] & { size: number; sourceRevision: string })[] = [];
      for (const source of input.files) {
        const info = await files.stat(source.path, signal);
        if (info.isDirectory || info.fileRevision !== source.fileRevision) throw new ToolExecutionError({ code: "revisionConflict", message: "导入源文件内容与读取到的fileRevision不一致", phase: "target", target: { ...toolTarget(target), path: source.path }, executionState: "notDispatched", expectedRevision: source.fileRevision, actualRevision: info.fileRevision, recovery: { action: "readState", message: "重新读取源文件内容fileRevision后确认导入", tool: "workspaceFiles" } });
        const metadata = await files.readRange(source.path, 0, 1, undefined, signal);
        requireWritable(target, input.expectedRevision); signal.throwIfAborted();
        if (!metadata.size || metadata.size > 100 * 1024 ** 2 || metadata.size !== info.size) throw new Error("导入源文件为空、超过100MiB或在预检中变化");
        totalSize += metadata.size;
        if (totalSize > 100 * 1024 ** 2) throw new Error("整批导入源文件合计超过100MiB，请拆分调用");
        const { kind } = inferMediaFileType(new File([], source.path.split("/").at(-1)!));
        if (!kind) throw new Error(`暂不支持此文件类型：${source.path}`);
        if (kind === "text" && metadata.size > 1000000) throw new Error("文本文件最多1MB");
        sources.push({ ...source, size: metadata.size, sourceRevision: metadata.revision });
      }
      for (const source of sources) {
        let offset = 0, size = 0;
        const parts: ArrayBuffer[] = [];
        do {
          const part = await files.readRange(source.path, offset, 8 * 1024 ** 2, source.sourceRevision, signal);
          requireWritable(target, input.expectedRevision); signal.throwIfAborted();
          if (part.size !== source.size) throw new Error("导入源文件大小在预检后已变化");
          if (!part.content.byteLength) throw new Error("导入源文件返回了空分段");
          size = part.size; parts.push(part.content); offset += part.content.byteLength;
        } while (offset < size);
        const file = new File(parts, source.path.split("/").at(-1)!);
        const actualRevision = await contentRevision(await file.arrayBuffer());
        requireWritable(target, input.expectedRevision); signal.throwIfAborted();
        if (actualRevision !== source.fileRevision) throw new ToolExecutionError({ code: "revisionConflict", message: "源文件在分段读取后未通过内容SHA256校验", phase: "target", target: { ...toolTarget(target), path: source.path }, executionState: "notDispatched", expectedRevision: source.fileRevision, actualRevision, recovery: { action: "readState", message: "重新读取源文件内容fileRevision后确认导入", tool: "workspaceFiles" } });
        media.push(file); imported.push({ path: source.path, fileRevision: actualRevision, size });
      }
      const originalIds = new Set(target.getSnapshot().document.nodes.map(node => node.id));
      requireWritable(target, input.expectedRevision); await controller.importMedia(media, input.position); requireSession(target);
      return { imported, createdNodeIds: target.getSnapshot().document.nodes.filter(node => !originalIds.has(node.id)).map(node => node.id), saved: true };
    }
    if (name === "getCanvasViewport" || name === "getCanvasHistory") {
      const target = currentSession(), input = peripheralToolSchemas[name].parse(args);
      if (input.canvasId !== undefined) requireToolCanvas(target, input.canvasId);
      if (name === "getCanvasViewport") return { viewport: target.getSnapshot().document.viewport ?? { x: 0, y: 0, zoom: 1 }, units: { x: "screenPixels", y: "screenPixels", zoom: "ratio" } };
      const history = controller.getHistory(), page = peripheralToolSchemas.getCanvasHistory.parse(args);
      const { items, ...pagination } = boundedPage(history.entries, page.offset, page.limit);
      return { ...history, entries: items, ...pagination, canUndo: snapshot.canUndo, canRedo: snapshot.canRedo };
    }
    if (name === "getAssetLibrary") {
      const input = peripheralToolSchemas.getAssetLibrary.parse(args), entries = await assetLibraryClient.list(signal);
      const all: AssetLibraryEntry[] = [];
      function flatten(entries: AssetLibraryEntry[]) { for (const entry of entries) { all.push(entry); if (entry.children) flatten(entry.children); } }
      flatten(entries);
      if (input.path !== "." && !all.some(entry => entry.path === input.path && entry.type === "directory")) throw new Error("素材库目录不存在");
      const keyword = input.query?.trim().toLocaleLowerCase();
      const values = all.filter(entry => (entry.path.split("/").slice(0, -1).join("/") || ".") === input.path && (!keyword || entry.name.toLocaleLowerCase().includes(keyword)) && (input.kind === "all" || input.kind === "directory" && entry.type === "directory" || entry.type === "file" && (assetMediaKind(entry.name) ?? "other") === input.kind))
        .map(entry => ({ name: entry.name, path: entry.path, type: entry.type, ...(entry.type === "file" ? { kind: assetMediaKind(entry.name) ?? "other" } : {}) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const queryRevision = await contentRevision(new TextEncoder().encode(JSON.stringify(values)));
      if ((input.offset > 0 && !input.queryRevision) || input.queryRevision && input.queryRevision !== queryRevision) throw new ToolExecutionError({ code: "queryChanged", message: "素材库查询已变化或缺少分页版本", phase: "validation", executionState: "notDispatched", recovery: { action: "readState", message: "从offset:0重新查询素材目录", tool: "getAssetLibrary" } });
      const { items, ...pagination } = boundedPage(values, input.offset, input.limit);
      return { entries: items, path: input.path, queryRevision, ...pagination };
    }
    if (name === "getAssetInfo") {
      const input = peripheralToolSchemas.getAssetInfo.parse(args), info = await assetLibraryClient.stat(input.path, signal);
      return { ...info, revisionScope: info.type === "file" ? "fileContent" : "directoryMetadata" };
    }
    if (name === "manageAssetLibrary") {
      const input = peripheralToolSchemas.manageAssetLibrary.parse(args);
      if (input.action === "createFolder") await assetLibraryClient.mkdir(input.path);
      else if (input.action === "rename") await assetLibraryClient.rename(input.path, input.target, input.fileRevision);
      else if (input.action === "remove") await assetLibraryClient.remove(input.path, input.fileRevision);
      else {
        const target = currentSession(); requireToolCanvas(target, input.canvasId); requireWritable(target, requireToolRevision(target, input.expectedRevision));
        if (input.action === "saveNodeOutput") {
          await saveSession(target); requireSession(target);
          const output = findNode(input.nodeId, target).data?.outputs;
          const value = output && typeof output === "object" ? Reflect.get(output, input.handle) : undefined;
          if (!isNodeOutput(value)) throw new Error("节点输出不存在，请重新读取节点端口");
          const content = typeof value.value === "object" ? await createWorkspaceFiles(target.getSnapshot().directory).read(value.value.url, 256 * 1024 ** 2, signal) : new Blob([String(value.value)]);
          requireSession(target); signal.throwIfAborted();
          await assetLibraryClient.save(input.path, content, signal);
        } else {
          const file = await assetLibraryClient.readFile(input.path, signal, input.fileRevision);
          requireWritable(target, input.expectedRevision); signal.throwIfAborted();
          await controller.importMedia([file], input.position); requireSession(target);
        }
      }
      return { action: input.action, path: "target" in input ? input.target : input.path, completed: true };
    }
    if (name === "getPluginConfiguration") {
      const input = peripheralToolSchemas.getPluginConfiguration.parse(args), plugins = await workbenchSettingsClient.plugins(signal);
      const values = plugins.filter(plugin => !input.pluginId || (plugin.id ?? plugin.name) === input.pluginId).map(plugin => {
        const rules = plugin.configRules ?? [], config = plugin.config ?? {};
        const fields = [...new Set([...Object.keys(config), ...rules.flatMap(rule => typeof rule.field === "string" ? [rule.field] : [])])];
        return { id: plugin.id ?? plugin.name, label: plugin.displayName ?? plugin.name, version: plugin.version, scope: plugin.scope ?? "node", builtin: plugin.builtin, installed: !!plugin.installed, enabled: plugin.enabled, configRevision: plugin.configRevision, loadError: plugin.loadError,
          description: plugin.description, tags: plugin.tags, license: plugin.license, homepage: plugin.homepage, ...(input.pluginId && plugin.agentGuide ? { agentGuide: plugin.agentGuide } : {}),
          configRules: rules.map(rule => secretField(String(rule.field ?? ""), rule) ? { field: rule.field ?? "", type: rule.type ?? "password", title: rule.title ?? rule.field ?? "", required: rule.required === true, secret: true } : publicConfiguration(rule)),
          configuration: Object.fromEntries(fields.map(field => { const rule = rules.find(rule => rule.field === field); return [field, !rule || secretField(field, rule) ? { configured: config[field] !== undefined && config[field] !== "", secret: true } : { value: publicConfiguration(config[field]), secret: false }]; })) };
      }).sort((a, b) => a.id.localeCompare(b.id));
      const { items, ...pagination } = boundedPage(values, input.offset, input.limit);
      return { plugins: items, toolCatalogVersion: runtime.getVersion(), ...pagination };
    }
    if (name === "setPluginConfiguration") {
      const input = peripheralToolSchemas.setPluginConfiguration.parse(args); requireToolCatalog(input.toolCatalogVersion);
      const plugin = (await workbenchSettingsClient.plugins(signal)).find(plugin => (plugin.id ?? plugin.name) === input.pluginId);
      if (!plugin || plugin.canConfigure === false) throw new Error("插件不存在或不允许配置");
      const config = { ...plugin.config };
      for (const [field, value] of Object.entries(input.changes)) {
        const rule = plugin.configRules?.find(rule => rule.field === field);
        if (!rule || secretField(field, rule)) throw new Error(`配置项未声明或属于凭据：${field}`);
        if (value === null) { if (rule.required === true) throw new Error(`必填配置项不能清除：${field}`); delete config[field]; continue; }
        if ((["number", "inputNumber"].includes(String(rule.type)) && typeof value !== "number") || (["switch", "checkbox", "boolean"].includes(String(rule.type)) && typeof value !== "boolean")) throw new Error(`配置项类型不匹配：${field}`);
        config[field] = value;
      }
      requireToolCatalog(input.toolCatalogVersion); signal.throwIfAborted();
      const saved = await workbenchSettingsClient.savePlugin(input.pluginId, config, input.expectedRevision, signal); await controller.refreshPlugins();
      return { pluginId: input.pluginId, changedFields: Object.keys(input.changes), saved: true, configRevision: saved.configRevision, toolCatalogVersion: runtime.getVersion() };
    }
    if (name === "setPluginEnabled") {
      const input = peripheralToolSchemas.setPluginEnabled.parse(args); requireToolCatalog(input.toolCatalogVersion);
      await controller.setPluginEnabled(input.pluginId, input.enabled);
      return { pluginId: input.pluginId, enabled: input.enabled, saved: true, toolCatalogVersion: runtime.getVersion() };
    }
    if (name === "uninstallPluginPackage") {
      const input = peripheralToolSchemas.uninstallPluginPackage.parse(args); requireToolCatalog(input.toolCatalogVersion);
      const plugin = (await workbenchSettingsClient.plugins(signal)).find(plugin => (plugin.id ?? plugin.name) === input.pluginId);
      if (!plugin || !plugin.installed) throw new Error("插件尚未安装");
      if (plugin.builtin && !input.restoreBuiltin) throw new Error("恢复内置插件须明确restoreBuiltin:true");
      if (!plugin.builtin && input.restoreBuiltin) throw new Error("此插件没有可恢复的内置版本");
      const target = session;
      if (target) { requireWritable(target); await prepareNodes(target.getSnapshot().document.nodes.filter(node => node.type?.replace(/^remote-/, "") === input.pluginId).map(node => node.id), "beforeHistory"); await saveSession(target); requireSession(target); }
      requireToolCatalog(input.toolCatalogVersion); signal.throwIfAborted();
      await workbenchSettingsClient.uninstallPlugin(input.pluginId, signal, input.restoreBuiltin); await controller.refreshPlugins();
      return { uninstalled: true, pluginId: input.pluginId, restoredBuiltin: input.restoreBuiltin, toolCatalogVersion: runtime.getVersion() };
    }
    if (name === "reviewPluginPackage" || name === "installPluginPackage") {
      const input = peripheralToolSchemas[name].parse(args), target = currentSession();
      const reviewed = await readPluginPackage(input.path, target, signal), id = reviewed.value.manifest.id;
      const existing = (await workbenchSettingsClient.plugins(signal)).find(plugin => (plugin.id ?? plugin.name) === id);
      requireSession(target);
      if (name === "reviewPluginPackage") return { path: input.path, fileRevision: reviewed.fileRevision, size: reviewed.size, pluginId: id, name: reviewed.value.manifest.name, version: reviewed.value.manifest.version, renderer: reviewed.value.manifest.renderer, assets: reviewed.value.assets?.length ?? 0, replacesExisting: !!existing, replacesBuiltin: !!existing?.builtin };
      const install = peripheralToolSchemas.installPluginPackage.parse(args);
      if (install.fileRevision !== reviewed.fileRevision) throw new ToolExecutionError({ code: "fileRevisionConflict", message: "插件包在复核后已变化", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新复核相同路径的插件包", tool: "reviewPluginPackage", args: { path: input.path } } });
      requireWritable(target); signal.throwIfAborted();
      if (existing && !install.replaceExisting || existing?.builtin && !install.replaceBuiltin) throw new Error("覆盖已安装或内置插件须明确对应的replaceExisting/replaceBuiltin");
      await workbenchSettingsClient.installPlugin(reviewed.value, { force: install.replaceExisting, replaceBuiltin: install.replaceBuiltin }, signal);
      await controller.refreshPlugins(); requireSession(target);
      return { installed: true, pluginId: id, version: reviewed.value.manifest.version, fileRevision: reviewed.fileRevision, toolCatalogVersion: runtime.getVersion() };
    }
    if (name === "getPluginMarket") {
      const input = peripheralToolSchemas.getPluginMarket.parse(args);
      const [general, installed] = await Promise.all([workbenchSettingsClient.generalConfiguration(signal), workbenchSettingsClient.plugins(signal)]);
      const market = await pluginMarketClient.index(pluginMarketUrlOf(general.general), signal);
      const keyword = input.query?.trim().toLocaleLowerCase(), capabilities = runtime.getCapabilities();
      const values = market.plugins.filter(entry => !keyword || [entry.id, entry.name, ...Object.values(entry.description), ...entry.tags].join(" ").toLocaleLowerCase().includes(keyword)).map(entry => {
        const current = installed.find(plugin => (plugin.id ?? plugin.name) === entry.id);
        return { id: entry.id, name: entry.name, version: entry.version, description: entry.description, author: entry.author, license: entry.license, homepage: entry.homepage, tags: entry.tags, scope: entry.scope, requires: entry.requires, size: entry.size, sha256: entry.sha256, url: entry.packageUrl,
          installed: current ? { version: current.version, builtin: current.builtin, enabled: current.enabled } : null,
          missingCapabilities: Object.entries(entry.requires).flatMap(([name, requiredVersion]) => (capabilities[name] ?? 0) < requiredVersion ? [{ name, requiredVersion, providedVersion: capabilities[name] ?? 0 }] : []) };
      });
      const { items, ...pagination } = boundedPage(values, input.offset, input.limit);
      return { marketUrl: market.url, generatedAt: market.generatedAt, plugins: items, toolCatalogVersion: runtime.getVersion(), ...pagination };
    }
    if (name === "installMarketplacePlugin") {
      const input = peripheralToolSchemas.installMarketplacePlugin.parse(args), target = currentSession();
      const general = await workbenchSettingsClient.generalConfiguration(signal);
      const market = await pluginMarketClient.index(pluginMarketUrlOf(general.general), signal);
      const entry = market.plugins.find(item => item.id === input.pluginId && item.version === input.version);
      if (!entry) throw new ToolExecutionError({ code: "marketEntryNotFound", message: "插件市场目录中没有该 id 与版本", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新读取插件市场目录，使用其中的 version 与 sha256", tool: "getPluginMarket", args: { query: input.pluginId } } });
      if (entry.sha256 !== input.sha256) throw new ToolExecutionError({ code: "sha256Mismatch", message: "传入的 sha256 与市场目录不一致，未下载", phase: "validation", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "使用 getPluginMarket 返回的 sha256 重新调用", tool: "getPluginMarket", args: { query: input.pluginId } } });
      const downloaded = await pluginMarketClient.download(entry, signal);
      const existing = (await workbenchSettingsClient.plugins(signal)).find(plugin => (plugin.id ?? plugin.name) === entry.id);
      requireSession(target); requireWritable(target); signal.throwIfAborted();
      if (existing && !input.replaceExisting || existing?.builtin && !input.replaceBuiltin) throw new Error("覆盖已安装或内置插件须明确对应的replaceExisting/replaceBuiltin");
      await workbenchSettingsClient.installPlugin(downloaded.value, { force: input.replaceExisting, replaceBuiltin: input.replaceBuiltin }, signal);
      await controller.refreshPlugins(); requireSession(target);
      return { installed: true, pluginId: entry.id, version: entry.version, sha256: downloaded.sha256, toolCatalogVersion: runtime.getVersion() };
    }
    if (name === "getModelStatus") {
      const input = peripheralToolSchemas.getModelStatus.parse(args), target = session;
      const providers = await workbenchSettingsClient.models(signal);
      const builtinProviders = (await workbenchSettingsClient.providerCatalog(signal)).map(provider => ({ id: provider.id, label: provider.label, installed: providers.some(installed => installed.id === provider.id) }));
      const { items, ...pagination } = boundedPage(providers.filter(provider => !input.providerId || provider.id === input.providerId).sort((a, b) => a.id.localeCompare(b.id)), input.offset, input.limit);
      const depth = target ? await workbenchSettingsClient.depthStatus(target.getSnapshot().directory, signal) : null;
      if (target) requireSession(target);
      return { providers: items, builtinProviders, depth, ...pagination };
    }
    if (name === "getProviderConfiguration") {
      const input = peripheralToolSchemas.getProviderConfiguration.parse(args);
      return workbenchSettingsClient.providerConfiguration(input.providerId, signal);
    }
    if (name === "setProviderConfiguration") {
      const input = peripheralToolSchemas.setProviderConfiguration.parse(args);
      const result = await workbenchSettingsClient.saveProviderConfiguration(input.providerId, input.changes, input.expectedRevision, signal);
      window.dispatchEvent(new Event("toonflow:provider-config-changed"));
      return result;
    }
    if (name === "getLocalVideoConnection") {
      peripheralToolSchemas.getLocalVideoConnection.parse(args);
      return workbenchSettingsClient.localVideoConnection(signal);
    }
    if (name === "setLocalVideoConnection") {
      const input = peripheralToolSchemas.setLocalVideoConnection.parse(args);
      return workbenchSettingsClient.saveLocalVideoConnection(input.changes, input.expectedRevision, signal);
    }
    if (name === "inspectLocalVideoConnection") {
      const input = peripheralToolSchemas.inspectLocalVideoConnection.parse(args);
      return workbenchSettingsClient.inspectLocalVideoConnection(input, signal);
    }
    if (name === "prepareDepthModel" || name === "cancelDepthModelPreparation") {
      peripheralToolSchemas[name].parse(args);
      const target = currentSession(), directory = target.getSnapshot().directory;
      const result = await (name === "prepareDepthModel" ? workbenchSettingsClient.prepareDepth(directory, signal) : workbenchSettingsClient.cancelDepth(directory, signal));
      requireSession(target);
      const phase = result && typeof result === "object" ? String(Reflect.get(result, "phase")) : "unknown";
      return { preparation: result, cancelRequested: phase === "cancelling", executionSettled: ["missing", "ready", "failed", "cancelled"].includes(phase), observe: "getModelStatus" };
    }
    if (name === "exportProject") {
      const input = peripheralToolSchemas.exportProject.parse(args), target = currentSession();
      requireToolCanvas(target, input.canvasId); requireToolRevision(target, input.expectedRevision);
      await saveSession(target); requireSession(target); signal.throwIfAborted();
      const files = createWorkspaceFiles(target.getSnapshot().directory), artifact = await files.saveProjectArchive(input.path, signal);
      requireSession(target); signal.throwIfAborted();
      const saved = await files.stat(input.path, signal), header = await files.readRange(input.path, 0, 4, artifact.sourceRevision, signal);
      if (saved.fileRevision !== artifact.fileRevision || saved.size !== artifact.size || new Uint8Array(header.content)[0] !== 0x50 || new Uint8Array(header.content)[1] !== 0x4b) throw new Error("ZIP产物保存后的版本、大小或文件头回读不一致");
      return { saved: true, artifact };
    }
    throw new Error(`未知外围能力：${name}`);
  }
  async function executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    assertAlive(); signal.throwIfAborted();
    if (name === "getAppState") { z.strictObject({}).parse(args); return getControlState(); }
    if (name === "saveWorkspace") {
      z.strictObject({}).parse(args);
      const target = currentSession();
      requireToolWriteAccess(target);
      await saveSession(target); signal.throwIfAborted(); requireSession(target);
      const current = target.getSnapshot();
      return { canvasId: current.canvasId, documentRevision: current.revision, dirty: current.dirty, saved: true };
    }
    if (Object.hasOwn(peripheralToolSchemas, name)) return executePeripheral(name, args, signal);
    if (name === "getWorkspaceTools") {
      const input = workspaceToolSchemas.getWorkspaceTools.parse(args), version = runtime.getVersion();
      if (input.offset > 0 && input.version === undefined && input.toolCatalogVersion === undefined) requireToolCatalog(undefined);
      if (input.version !== undefined) requireToolCatalog(input.version);
      if (input.toolCatalogVersion !== undefined) requireToolCatalog(input.toolCatalogVersion);
      const tools = runtime.listTools().filter(tool => !tool.nodeId && (!input.pluginId || tool.pluginId === input.pluginId));
      const page: typeof tools = [];
      for (const tool of tools.slice(input.offset, input.offset + input.limit)) {
        if (new TextEncoder().encode(JSON.stringify([...page, tool])).length > 60 * 1024) { if (!page.length) throw new Error("单个工作区工具 Schema 超过 60 KiB"); break; }
        page.push(tool);
      }
      const next = input.offset + page.length;
      return { tools: page, version, toolCatalogVersion: version, hasMore: next < tools.length, ...(next < tools.length ? { nextOffset: next } : {}) };
    }
    if (name === "workspaceTools") {
      const input = workspaceToolSchemas.workspaceTools.parse(args);
      requireToolCatalog(input.toolCatalogVersion);
      const tool = runtime.listTools().find(tool => !tool.nodeId && tool.pluginId === input.pluginId && tool.name === input.name);
      if (!tool) throw new Error("工作区工具已失效，请重新发现能力");
      return runtime.callTool({ instanceId: tool.instanceId, name: tool.name, args: input.args }, signal);
    }
    if (!supportedCanvas.has(name)) throw new Error(`未发布的工作台工具：${name}`);
    if (name === "switchCanvas") {
      await controller.switchCanvas(canvasSchemas.switchCanvas.parse(args).canvasId, signal); signal.throwIfAborted();
      return queries({ name: "getCanvas", args: {} }, snapshot.canvasId!, signal);
    }
    if (name === "addCanvas") {
      await createCanvas(canvasSchemas.addCanvas.parse(args).name, signal); signal.throwIfAborted();
      return queries({ name: "getCanvas", args: {} }, snapshot.canvasId!, signal);
    }
    if (name === "renameCanvas") {
      const { fileRevision, ...rest } = args;
      const target = currentSession(); requireToolCanvas(target, rest.canvasId); requireWritable(target);
      const revision = z.string().regex(/^[a-f0-9]{64}$/).parse(fileRevision);
      const parsed = canvasSchemas.renameCanvas.parse(rest);
      await renameCanvas(parsed.name, parsed.canvasId, signal, revision); signal.throwIfAborted();
      return queries({ name: "getCanvas", args: {} }, snapshot.canvasId!, signal);
    }
    if (name === "manageCanvas" || name === "renameProject") {
      const tool = additionalCanvasOperations.find(tool => tool.name === name)!;
      const input = tool.parameters.parse(args) as Parameters<WorkbenchController["manageCanvas"]>[0] & { directory: string; name?: string };
      const target = currentSession();
      if (input.directory !== target.getSnapshot().directory) throw new ToolExecutionError({ code: "targetChanged", message: "工程目录已切换，请重新读取目标", phase: "target", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新读取当前工程directory", tool: "getAppState" } });
      if (name === "renameProject") { await controller.renameProject(input.name!); return { directory: input.directory, projectName: snapshot.projectName, saved: true }; }
      await controller.manageCanvas(input); signal.throwIfAborted();
      return { saved: true, directory: input.directory, canvasFiles: snapshot.canvasFiles, canvasFolders: snapshot.canvasFolders };
    }
    const target = currentSession();
    if (name === "getCompatibleNodeTypes") {
      const input = additionalCanvasOperations.find(tool => tool.name === name)!.parameters.parse(args) as z.infer<typeof connectionEndpointSchema> & { canvasId?: string };
      if (input.canvasId !== undefined) requireToolCanvas(target, input.canvasId);
      const result = await compatibleEndpointTypes(target, input);
      return { ...result, canvasId: target.getSnapshot().canvasId, documentRevision: target.getSnapshot().revision, toolCatalogVersion: runtime.getVersion(), dirty: target.getSnapshot().dirty };
    }
    if (name === "getCompatibleSelectionNodeTypes") {
      const input = additionalCanvasOperations.find(tool => tool.name === name)!.parameters.parse(args) as { nodeIds: string[]; canvasId?: string };
      if (input.canvasId !== undefined) requireToolCanvas(target, input.canvasId);
      return compatibleSelectionTypes(target, input.nodeIds);
    }
    if (name === "getCanvasFolders") {
      const { canvasId, expectedRevision: _expectedRevision, ...rest } = args;
      if (canvasId !== undefined && canvasId !== target.getSnapshot().canvasId) throw new Error("目标画布已切换，请重新查询");
      const input = z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(30) }).parse(rest);
      const folders: string[] = [];
      for (const folder of snapshot.canvasFolders.slice(input.offset, input.offset + input.limit)) { if (new TextEncoder().encode(JSON.stringify([...folders, folder])).length > 60 * 1024) break; folders.push(folder); }
      const nextOffset = input.offset + folders.length;
      return { folders, total: snapshot.canvasFolders.length, hasMore: nextOffset < snapshot.canvasFolders.length, ...(nextOffset < snapshot.canvasFolders.length ? { nextOffset } : {}) };
    }
    if (isCanvasRead(name)) {
      const result = await queries({ name, args }, target.getSnapshot().canvasId, signal);
      requireSession(target); return result;
    }
    const { expectedRevision: rawRevision, canvasId, toolCatalogVersion, ...rest } = args;
    const expectedRevision = revisionSchema.optional().parse(rawRevision);
    requireToolCanvas(target, canvasId);
    if (name !== "nodeTools") requireToolRevision(target, rawRevision);
    else requireToolCatalog(toolCatalogVersion);
    if (name === "selectNodes") { controller.select(canvasSchemas.selectNodes.parse(rest).nodeIds); return { selectedIds: snapshot.selectedIds }; }
    if (name === "fitCanvas") return fitCanvas(target, canvasSchemas.fitCanvas.parse(rest).nodeIds);
    if (name === "nodeTools") {
      const request = canvasSchemas.nodeTools.parse(rest);
      const tool = runtime.listTools([request.nodeId]).find(item => `node:${item.name}` === request.name);
      if (tool?.annotations?.readOnlyHint !== true) requireToolRevision(target, rawRevision);
      const properties = tool?.inputSchema.properties;
      const revisionProperty = properties && typeof properties === "object" ? Reflect.get(properties, "expectedRevision") : undefined;
      const documentRevisionParameter = revisionProperty && typeof revisionProperty === "object" && ["integer", "number"].includes(Reflect.get(revisionProperty, "type"));
      if (documentRevisionParameter && expectedRevision !== undefined && request.args.expectedRevision !== undefined && request.args.expectedRevision !== expectedRevision) throw new ToolExecutionError({ code: "revisionConflict", message: "节点函数的画布期望修订与请求不一致，未执行节点函数", phase: "target", target: toolTarget(target), executionState: "notDispatched", recovery: { action: "readState", message: "重新读取画布documentRevision与节点函数Schema，作品修订和专业资源修订不能混用", tool: "getNodeTools", args: { nodeIds: [request.nodeId] } } });
      const parameters = expectedRevision !== undefined && documentRevisionParameter ? { ...request.args, expectedRevision } : request.args;
      const result = await nodeTools.call({ ...request, args: parameters }, signal); requireSession(target); return result;
    }
    requireToolWriteAccess(target);
    if (name === "saveCanvas") { canvasSchemas.saveCanvas.parse(rest); await saveSession(target); return { saved: true, revision: target.getSnapshot().revision }; }
    if (name === "changeCanvasHistory") {
      const parsed = canvasSchemas.changeCanvasHistory.parse(rest);
      await changeHistory(target, parsed.direction, expectedRevision); requireSession(target); return { revision: target.getSnapshot().revision };
    }
    requireWritable(target, expectedRevision);
    let result: unknown;
    const additional = additionalCanvasOperations.find(tool => tool.name === name);
    if (additional) {
      const parsed = additional.parameters.parse(rest);
      if (name === "manageCanvas") await controller.manageCanvas(parsed as Parameters<WorkbenchController["manageCanvas"]>[0]);
      else if (name === "renameProject") await controller.renameProject((parsed as { name: string }).name);
      else if (name === "resizeNodes") {
        const sizes = parsed as { sizes: { nodeId: string; width: number; height: number }[] };
        const updates = sizes.sizes.map(({ nodeId: id, width, height }) => { if (findNode(id, target).resizable === false) throw new Error(`节点不允许调整尺寸：${id}`); return { id, changes: { width, height } }; });
        result = await execute(target, "updateNodes", { updates }, expectedRevision);
      } else if (name === "addConnectedNode") result = await addEndpointNode(target, parsed as { type: string; position: { x: number; y: number }; endpoint: z.infer<typeof connectionEndpointSchema> }, expectedRevision);
      else if (name === "addConnectedSelectionNode") result = await addConnectedSelection(target, parsed as { nodeIds: string[]; type: string; position: { x: number; y: number } }, expectedRevision);
      else if (name === "setCanvasViewport") result = await execute(target, "setViewport", parsed, expectedRevision);
      else result = await execute(target, name, parsed, expectedRevision);
      if (name === "manageCanvas") { signal.throwIfAborted(); return { saved: true, canvasId: snapshot.canvasId, canvasFiles: snapshot.canvasFiles, canvasFolders: snapshot.canvasFolders, revision: snapshot.revision }; }
    } else if (name === "arrangeCanvas") { canvasSchemas.arrangeCanvas.parse(rest); result = await arrangeCanvas(target, expectedRevision); }
    else if (name === "addNode") result = await addNode(target, canvasSchemas.addNode.parse(rest), expectedRevision);
    else if (name === "moveNodes") {
      const parsed = canvasSchemas.moveNodes.parse(rest);
      const absoluteMoves = parsed.positionSpace === "canvas" ? new Map(parsed.moves.map(move => [move.nodeId, move.position])) : undefined;
      const nodes = parsed.moves.map(move => {
        const node = findNode(move.nodeId, target);
        const offset = absoluteMoves ? canvasNodePosition({ ...node, position: { x: 0, y: 0 } }, id => {
          const parent = findNode(id, target), size = canvasView?.measure(id);
          return { ...parent, width: typeof parent.width === "number" ? parent.width : size?.width, height: typeof parent.height === "number" ? parent.height : size?.height };
        }, absoluteMoves) : { x: 0, y: 0 };
        return { id: move.nodeId, position: { x: move.position.x - offset.x, y: move.position.y - offset.y } };
      });
      result = await execute(target, name, { nodes }, expectedRevision);
    } else if (name === "renameNodes") {
      const parsed = canvasSchemas.renameNodes.parse(rest);
      result = await execute(target, "updateNodes", { updates: parsed.renames.map(item => ({ id: item.nodeId, changes: { data: { label: item.label } } })) }, expectedRevision);
    } else if (name === "deleteNodes") result = await execute(target, "removeElements", { nodeIds: canvasSchemas.deleteNodes.parse(rest).nodeIds, edgeIds: [] }, expectedRevision);
    else if (name === "deleteEdges") result = await execute(target, "removeElements", { edgeIds: canvasSchemas.deleteEdges.parse(rest).edgeIds, nodeIds: [] }, expectedRevision);
    else if (name === "connectNodes") result = { edges: connect(target, canvasSchemas.connectNodes.parse(rest).connections, expectedRevision) };
    signal.throwIfAborted(); requireSession(target); await saveSession(target);
    return { ...(result && typeof result === "object" ? result : {}), canvasId: target.getSnapshot().canvasId, saved: true, dirty: target.getSnapshot().dirty, documentRevision: target.getSnapshot().revision, revision: target.getSnapshot().revision };
  }
  async function callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const result = await executeTool(name, args, signal);
    signal.throwIfAborted();
    const output = result && typeof result === "object" && !Array.isArray(result) && name !== "nodeTools" && name !== "workspaceTools" && (supportedCanvas.has(name) || ["getAppState", "getCanvasViewport", "getCanvasHistory", "getCanvasView", "setCanvasView"].includes(name))
      ? { ...result, canvasId: snapshot.canvasId, documentRevision: session?.getSnapshot().revision ?? 0, dirty: snapshot.dirty } : result;
    const serialized = JSON.parse(JSON.stringify(output ?? null)) as unknown;
    try { validateWorkbenchToolResult(name, serialized); }
    catch (error) { throw new ToolExecutionError({ code: "toolOutputInvalid", message: `工具结果不符合已发布Schema：${error instanceof Error ? error.message : String(error)}`, phase: "result", target: toolTarget(), executionState: "completed", recovery: { action: "readState", message: "本次函数已返回，不要自动重放；请读取作品状态或原operationId结果", tool: "getAppState" } }); }
    return serialized;
  }
  const hostTools: HostToolProvider = {
    list: listWorkbenchTools,
    call: (name, args, signal) => callTool(name, z.record(z.string(), z.unknown()).parse(args), signal),
  };
  function getControlState() { return JSON.parse(JSON.stringify({ directory: snapshot.directory, canvasId: snapshot.canvasId, panel: "workspace", projectList: snapshot.directory ? [{ directory: snapshot.directory, name: snapshot.projectName, lastOpenedAt: 0 }] : [],
    tools: [], nodeToolCount: runtime.getToolCount(), nodeToolsVersion: runtime.getVersion(), toolCatalogVersion: runtime.getVersion(), selectedCount: snapshot.selectedIds.length,
    selectedNodes: snapshot.document?.nodes.filter(node => snapshot.selectedIds.includes(node.id)).slice(0, 100).map(node => ({ id: node.id, type: node.type, label: String(node.data?.label ?? node.id).slice(0, 512), selected: true })) ?? [],
    selectedNodesTruncated: snapshot.selectedIds.length > 100,
    revision: snapshot.revision, documentRevision: session?.getSnapshot().revision ?? 0, queryRevision, dirty: snapshot.dirty, saving: snapshot.saving, readOnly: snapshot.readOnly, transitioning, capabilities: hostTools.list() })); }

  ready = initializePlugins();
  return Object.assign(controller, {
    ready, runtime, callTool, hostTools, getControlState, getHostContext,
    getNodeError: (id: string) => nodeErrors.get(id)?.message,
    async loadPlugin(source: PluginSource<View>) {
      const definition = await loadDefinition(source);
      await syncPlugins();
      await syncWorkspacePlugins();
      const errors = [...nodeErrors].filter(([, error]) => error.pluginId === definition.id);
      return { id: definition.id, name: definition.name, version: definition.version,
        activationErrorCount: errors.length, activationErrors: errors.slice(0, 100).map(([nodeId, error]) => ({ nodeId, message: error.message })) };
    },
    unloadPlugin(id: string) {
      return queueCatalog(async () => {
        assertAlive(); nodeId.parse(id); disabledPlugins.add(id);
        try { await runtime.unload(id); }
        finally {
          definitions.delete(id); views.delete(id); views.delete(`remote-${id}`);
          workspaceSubscriptions.get(id)?.(); workspaceSubscriptions.delete(id); workspacePlugins.delete(id);
          for (const [instanceId, definition] of activated) if (definition.id === id) { activated.delete(instanceId); workbenches.delete(instanceId); }
          for (const [nodeId, error] of nodeErrors) if (error.pluginId === id) nodeErrors.delete(nodeId);
          publishPlugins();
        }
      });
    },
    setReadOnly(value: boolean) { assertAlive(); readOnly = z.boolean().parse(value); session?.setReadOnly(readOnly || !!workspace?.provider?.readOnly); publish(); },
    setHost(adapter: HostAdapter) {
      assertAlive(); releaseHost?.(); host?.disconnect(); host = adapter;
      const update = () => { if (!disposed && host === adapter) publish({ host: { name: adapter.name, connected: adapter.getState() === "connected", canSend: adapter.getState() === "connected" && adapter.capabilities.requests.includes("edit") } }); };
      releaseHost = adapter.subscribe(update); update();
      return adapter.connect().then(update);
    },
    dispose() { if (disposed) return Promise.resolve(); disposed = true; clearTimeout(autoSaveTimer); controllerLifetime.abort(); releaseDocument?.(); releaseSession?.(); releaseHost?.(); for (const release of workspaceSubscriptions.values()) release(); workspace?.dispose(); host?.disconnect(); lifetime.abort(); session?.dispose(); listeners.clear(); composerListeners.clear(); return runtime.dispose(); },
  });
}

export type WorkbenchRuntime = ReturnType<typeof createWorkbenchController>;
