import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import type { WorkbenchController } from "./types";
import ComfySettings from "./comfySettings";
import NodeMenuSettings from "./nodeMenuSettings";
import { canvasShortcutFields, defaultCanvasShortcuts, isModifierShortcut, isShortcutAllowed, normalizeShortcut, shortcutFromEvent, shortcutLabel } from "@/lib/canvasShortcuts";
import { defaultPluginMarketUrl, ffmpegConfigurationSchema, ffmpegStatusSchema, mediaProviderSchema, pluginMarketClient, pluginMarketUrlOf, pluginPackageSchema, pluginSchema, providerModelSchema, workbenchSettingsClient, type PluginMarket, type PluginMarketEntry } from "@/lib/workbenchSettingsClient";

const depthSchema = z.object({ available: z.boolean(), runtimeAvailable: z.boolean(), message: z.string(), preparationProgress: z.object({ phase: z.string(), received: z.number(), total: z.number(), error: z.string().optional() }).optional() });
const hostSessionSchema = z.object({ id: z.string(), name: z.string(), directory: z.string().optional() });
type ModelDraft = { id: string; label: string; type: "image" | "video" | "audio" | "text"; options: string };
export type SettingsTab = "host" | "plugins" | "models" | "canvas" | "ffmpeg" | "nodeMenu";
const apiKeyRule = { field: "apiKey", title: "API Key", type: "input", value: "", props: { type: "password" } };
const providerTemplates = {
  video: { id: "remoteVideo", label: "自建视频服务", apiUrl: "https://video.example.com/v1", videoProtocol: "openaiVideo", transport: "public", cancelMode: "none", endpoints: { video: "videos" }, rules: [apiKeyRule], models: [{ id: "deployedModelName", label: "已部署的视频模型", type: "video", mode: ["text", "endFrameOptional"], imageRatios: ["16:9", "9:16"], audio: false, durationResolutionMap: [{ duration: [4, 8], resolution: ["720p"] }], video: { inputMap: { firstFrame: "input_reference" } } }] },
  comfy: { id: "studioComfy", label: "工作站 ComfyUI", apiUrl: "http://192.168.1.20:8188", videoProtocol: "comfyui", transport: "local", cancelMode: "request", rules: [{ field: "apiUrl", title: "服务地址", type: "input", value: "http://192.168.1.20:8188" }], models: [] },
  image: { id: "customImage", label: "自定义图片服务", apiUrl: "https://api.example.com/v1", protocol: "openai", rules: [apiKeyRule], models: [{ id: "deployedImageModel", label: "已部署的图片模型", type: "image" }] },
};
const modelKinds = { image: "图片", video: "视频", audio: "音频", text: "文本" };
function providerSummary(provider: z.infer<typeof mediaProviderSchema>) {
  return [[...new Set(provider.models.map(model => modelKinds[model.type]))].join(" / "), `${provider.models.length} 个模型`].filter(Boolean).join(" · ");
}
function draftModels(provider: z.infer<typeof mediaProviderSchema>): ModelDraft[] {
  return provider.models.map(({ id, label, type, ...options }) => ({ id, label, type, options: JSON.stringify(options, null, 2) }));
}
function SettingFields({ rules, values, onChange, disabled }: { rules: Record<string, unknown>[]; values: Record<string, unknown>; onChange: (field: string, value: string | number | boolean) => void; disabled: boolean }) {
  return <>{rules.filter(rule => typeof rule.field === "string" && rule.field).map(rule => {
    const field = String(rule.field), label = String(rule.title || field), value = values[field] ?? rule.value ?? "";
    const props = rule.props && typeof rule.props === "object" ? rule.props as Record<string, unknown> : {};
    const options = Array.isArray(rule.options) ? rule.options as Record<string, unknown>[] : [];
    if (["switch", "checkbox"].includes(String(rule.type))) return <label className="settingToggle" key={field}><span>{label}</span><input type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(field, event.target.checked)} /></label>;
    if (rule.type === "select" && options.length) return <label key={field}>{label}<select value={String(value)} disabled={disabled} onChange={event => { const selected = options.find(option => String(option.value) === event.target.value)?.value; onChange(field, typeof selected === "number" || typeof selected === "boolean" ? selected : String(selected ?? "")); }}>{options.map((option, index) => <option key={index} value={String(option.value)}>{String(option.label ?? option.value)}</option>)}</select></label>;
    const numeric = ["inputNumber", "slider"].includes(String(rule.type));
    const secret = props.type === "password" || /key|token|secret|password|credential/i.test(field);
    return <label key={field}>{label}<input type={numeric ? "number" : secret ? "password" : "text"} value={String(value)} disabled={disabled} autoComplete="off" placeholder={typeof props.placeholder === "string" ? props.placeholder : undefined} onChange={event => onChange(field, numeric ? Number(event.target.value) : event.target.value)} /></label>;
  })}</>;
}
async function api(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : method, headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok || value.code !== 200) throw new Error(value.message || `请求失败（${response.status}）`);
  return value.data;
}

export default function SettingsPanel({ controller, initialTab = "host" }: { controller: WorkbenchController; initialTab?: SettingsTab }) {
  const native = !!window.openCinemaTransport;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [generalConfiguration, setGeneralConfiguration] = useState<Awaited<ReturnType<typeof workbenchSettingsClient.generalConfiguration>>>();
  const [providers, setProviders] = useState<z.infer<typeof mediaProviderSchema>[]>([]);
  const [providerCatalog, setProviderCatalog] = useState<z.infer<typeof mediaProviderSchema>[]>([]);
  const [providerId, setProviderId] = useState("");
  const [providerValues, setProviderValues] = useState<Record<string, unknown>>({});
  const [providerSource, setProviderSource] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [modelDrafts, setModelDrafts] = useState<ModelDraft[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<z.infer<typeof pluginSchema>[]>([]);
  const [configuringPlugin, setConfiguringPlugin] = useState<z.infer<typeof pluginSchema>>();
  const [pluginValues, setPluginValues] = useState<Record<string, unknown>>({});
  const [removingPlugin, setRemovingPlugin] = useState<string>();
  const [removingProvider, setRemovingProvider] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<z.infer<typeof ffmpegStatusSchema>>();
  const [ffmpegConfiguration, setFfmpegConfiguration] = useState<z.infer<typeof ffmpegConfigurationSchema>>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pendingPackage, setPendingPackage] = useState<{ value: z.infer<typeof pluginPackageSchema>; size: number; existing: boolean; builtin: boolean; origin?: string }>();
  const [market, setMarket] = useState<PluginMarket>();
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [marketUrlDraft, setMarketUrlDraft] = useState("");
  const [depth, setDepth] = useState<z.infer<typeof depthSchema>>();
  const [hostSessions, setHostSessions] = useState<z.infer<typeof hostSessionSchema>[]>([]);
  const [hostSessionId, setHostSessionId] = useState(() => {
    if (native) return "";
    try { return localStorage.getItem("openCinema.hostSessionId") ?? ""; } catch { return ""; }
  });
  const pluginFile = useRef<HTMLInputElement>(null);
  const providerFile = useRef<HTMLInputElement>(null);
  const config = settings.mediaProviderConfigs && typeof settings.mediaProviderConfigs === "object" ? settings.mediaProviderConfigs as Record<string, Record<string, unknown>> : {};
  useEffect(() => {
    let active = true;
    void Promise.all([api("settings/get"), workbenchSettingsClient.providerCatalog(new AbortController().signal), workbenchSettingsClient.generalConfiguration(new AbortController().signal)]).then(([values, catalog, general]) => {
      if (!active) return;
      setSettings(z.record(z.string(), z.unknown()).parse(values));
      setProviderCatalog(catalog);
      setGeneralConfiguration(general);
    }).catch(value => { if (active) setError(value instanceof Error ? value.message : String(value)); });
    return () => { active = false; };
  }, []);
  // 插件的安装、停用和卸载发生在别的标签页或 Agent 工具里，所以进入本页和配置变化时都重新读取。
  useEffect(() => {
    if (tab !== "models") return;
    const controller = new AbortController();
    async function refresh() {
      try { const list = await workbenchSettingsClient.providers(controller.signal); if (!controller.signal.aborted) setProviders(list); }
      catch (value) { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)); }
    }
    void refresh();
    window.addEventListener("toonflow:provider-config-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("toonflow:provider-config-changed", refresh); };
  }, [tab]);
  useEffect(() => {
    if (tab !== "plugins" && tab !== "ffmpeg") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        if (tab === "plugins") { const list = await workbenchSettingsClient.plugins(controller.signal); if (!controller.signal.aborted) setInstalledPlugins(list); }
        else {
          const [state, configuration] = await Promise.all([workbenchSettingsClient.ffmpegStatus(controller.signal), workbenchSettingsClient.ffmpegConfiguration(controller.signal)]);
          if (controller.signal.aborted) return;
          setFfmpeg(state); setFfmpegConfiguration(configuration);
          if (["downloading", "verifying", "installing"].includes(state.download.phase)) timer = setTimeout(() => void refresh(), 1000);
        }
      } catch (value) { if (!controller.signal.aborted) setError(value instanceof Error ? value.message : String(value)); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [tab, ffmpeg?.download.phase]);
  useEffect(() => {
    if (tab !== "models" && tab !== "host") return;
    let active = true;
    async function refresh() {
      try {
        if (tab === "models" && snapshot.directory) {
          const result = depthSchema.parse(await api(`media/referenceDepth/modelStatus?${new URLSearchParams({ directory: snapshot.directory })}`));
          if (active) setDepth(result);
        } else if (tab === "host") {
          const value = z.object({ sessions: z.array(hostSessionSchema) }).parse(await api("host/state"));
          if (active) setHostSessions(value.sessions.filter(session => !session.directory || session.directory === snapshot.directory));
        }
      } catch (value) { if (active) setError(value instanceof Error ? value.message : String(value)); }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 2000);
    return () => { active = false; clearInterval(timer); };
  }, [tab, snapshot.directory]);
  useEffect(() => { const value = generalConfiguration?.general.pluginMarketUrl; setMarketUrlDraft(typeof value === "string" ? value : ""); }, [generalConfiguration?.configRevision]);
  async function loadMarket() {
    setMarketLoading(true); setMarketError("");
    try {
      const general = generalConfiguration ?? await workbenchSettingsClient.generalConfiguration(new AbortController().signal);
      setMarket(await pluginMarketClient.index(pluginMarketUrlOf(general.general), new AbortController().signal));
    } catch (value) { setMarketError(value instanceof Error ? value.message : String(value)); } finally { setMarketLoading(false); }
  }
  // 市场条目只下载并校验，安装仍走同一张“复核”卡片；用户看清 id、版本、大小后才执行。
  async function reviewMarketEntry(entry: PluginMarketEntry) {
    const downloaded = await pluginMarketClient.download(entry, new AbortController().signal);
    const catalog = await workbenchSettingsClient.plugins(new AbortController().signal);
    const existing = catalog.find(item => (item.id ?? item.name) === entry.id);
    setPendingPackage({ value: downloaded.value, size: downloaded.size, existing: !!existing, builtin: !!existing?.builtin, origin: `来自插件市场 ${new URL(market?.url ?? defaultPluginMarketUrl).host} · SHA-256 已校验 ${downloaded.sha256.slice(0, 16)}…` });
    setStatus("插件包已下载并通过校验，请确认安装");
  }
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setStatus("");
    try { await action(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } finally { setBusy(false); }
  }
  const activeProvider = providers.find(provider => provider.id === providerId);
  const ffmpegBusy = ["downloading", "verifying", "installing"].includes(ffmpeg?.download.phase ?? "");
  async function refreshFfmpeg() {
    const signal = new AbortController().signal;
    const [state, configuration] = await Promise.all([workbenchSettingsClient.ffmpegStatus(signal), workbenchSettingsClient.ffmpegConfiguration(signal)]);
    setFfmpeg(state); setFfmpegConfiguration(configuration);
  }
  async function refreshProviderList() {
    const list = await workbenchSettingsClient.providers(new AbortController().signal);
    setProviders(list); window.dispatchEvent(new Event("toonflow:provider-config-changed")); return list;
  }
  function selectProvider(id: string) {
    setProviderId(id); setRemovingProvider(false); setAddingProvider(false);
    const provider = providers.find(item => item.id === id);
    setProviderValues({ ...(config[id] ?? {}) }); setModelDrafts(provider ? draftModels(provider) : []);
  }
  return <div className="settingsPanel">
    <nav aria-label="设置分类">{([["host", "连接 Agent"], ["plugins", "插件"], ["models", "媒体服务"], ["ffmpeg", "FFmpeg"], ["canvas", "画布"], ["nodeMenu", "节点菜单"]] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setTab(id); setStatus(""); setError(""); }}>{label}</button>)}</nav>
    {tab === "nodeMenu" && <NodeMenuSettings controller={controller} />}
    {tab === "canvas" && <form className="settingsContent" onSubmit={event => { event.preventDefault(); void perform(async () => {
      if (!generalConfiguration) throw new Error("画布设置尚未读取");
      const general = generalConfiguration.general;
      const saved = general.canvasShortcuts && typeof general.canvasShortcuts === "object" ? general.canvasShortcuts as Record<string, string> : {};
      const normalized = Object.fromEntries(canvasShortcutFields.map(field => { const value = normalizeShortcut(saved[field.id] ?? defaultCanvasShortcuts[field.id]); if (value === undefined || !isShortcutAllowed(field, value)) throw new Error(`${field.label}的按键组合无效`); return [field.id, value]; }));
      const next = await workbenchSettingsClient.saveGeneralConfiguration({ canvasShortcuts: normalized, canvasEdgeAnimationEnabled: general.canvasEdgeAnimationEnabled !== false, canvasEdgeColorMode: general.canvasEdgeColorMode ?? "theme", canvasEdgeColor: general.canvasEdgeColor ?? "#2dd4bf" }, generalConfiguration.configRevision, new AbortController().signal);
      setGeneralConfiguration(next); setStatus("画布设置已保存"); window.dispatchEvent(new Event("openCinema:general-settings-changed"));
    }); }}>
      <label className="settingToggle"><span>选中节点的连线流动动画</span><input type="checkbox" checked={generalConfiguration?.general.canvasEdgeAnimationEnabled !== false} disabled={busy || !generalConfiguration} onChange={event => setGeneralConfiguration(current => current ? { ...current, general: { ...current.general, canvasEdgeAnimationEnabled: event.target.checked } } : current)} /></label>
      <label>关联连线高亮颜色<select aria-label="关联连线高亮颜色模式" value={String(generalConfiguration?.general.canvasEdgeColorMode ?? "theme")} disabled={busy || !generalConfiguration} onChange={event => setGeneralConfiguration(current => current ? { ...current, general: { ...current.general, canvasEdgeColorMode: event.target.value } } : current)}><option value="none">不使用高亮颜色</option><option value="theme">跟随主题色</option><option value="custom">自选颜色</option></select></label>
      {generalConfiguration?.general.canvasEdgeColorMode === "custom" && <label>自选高亮颜色<input type="color" aria-label="连线高亮自选颜色" value={String(generalConfiguration.general.canvasEdgeColor ?? "#2dd4bf")} disabled={busy} onChange={event => setGeneralConfiguration(current => current ? { ...current, general: { ...current.general, canvasEdgeColor: event.target.value } } : current)} /></label>}
      <p>点击快捷键后直接按下新的组合键；需要按住的操作只按修饰键。Tab 离开输入框。</p>
      <div className="shortcutGrid">{canvasShortcutFields.map(field => {
        const general = generalConfiguration?.general ?? {};
        const saved = general.canvasShortcuts && typeof general.canvasShortcuts === "object" ? general.canvasShortcuts as Record<string, string> : {};
        return <label key={field.id}><span>{field.label}</span><input readOnly aria-label={`${field.label}快捷键`} value={shortcutLabel(saved[field.id] ?? defaultCanvasShortcuts[field.id]) || "未设置"} disabled={busy || !generalConfiguration} onKeyDown={event => {
          if (event.key === "Tab") return;
          event.preventDefault();
          const value = shortcutFromEvent(event.nativeEvent);
          // 普通操作要等到非修饰键按下；按住类操作只记录修饰键。
          if (!value || !field.hold && isModifierShortcut(value) || !isShortcutAllowed(field, value)) return;
          setGeneralConfiguration(current => current ? { ...current, general: { ...current.general, canvasShortcuts: { ...saved, [field.id]: value } } } : current);
        }} /></label>;
      })}</div><div className="settingsActions"><button type="submit" disabled={busy || !generalConfiguration}>保存画布设置</button><button type="button" disabled={busy || !generalConfiguration} onClick={() => setGeneralConfiguration(current => current ? { ...current, general: { ...current.general, canvasShortcuts: { ...defaultCanvasShortcuts } } } : current)}>恢复默认快捷键</button></div>
    </form>}
    {tab === "host" && <div className="settingsContent">
      <div className="settingRow"><span>当前 Agent</span><strong>{snapshot.host.name}</strong><span className={snapshot.host.connected ? "connectedValue" : ""}>{snapshot.host.connected ? "已连接" : "未连接"}</span></div>
      {!native && hostSessions.length > 0 && <label>接收画布指令的 Agent<select value={hostSessionId} onChange={event => {
        const id = event.target.value;
        void perform(async () => {
          if (id) localStorage.setItem("openCinema.hostSessionId", id); else localStorage.removeItem("openCinema.hostSessionId");
          setHostSessionId(id);
        });
      }}><option value="">单个 Agent 时自动连接</option>{hostSessions.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}</select></label>}
      {native ? <p>画布指令会连同固定的操作目标发送到当前宿主对话。请在对话和画布中查看结果；消息已接收不代表执行完成。</p> : <>
        <p>接入 Claude Code 或 Codex 后，底部输入框的创作要求会交给它执行。在仓库根目录完成 <code>bun run build</code> 后运行：</p>
        <div className="hostSetup">{([["Claude Code", ["claude --plugin-dir ./build/openCinema"]], ["Codex", ["codex plugin marketplace add . --json", "codex plugin add opencinema@openCinemaStandalone --json"]]] as const).map(([name, commands]) => <div key={name}><span>{name}</span>{commands.map(command => <div className="hostCommand" key={command}><code>{command}</code><button type="button" aria-label={`复制 ${command}`} onClick={() => void perform(async () => { await navigator.clipboard.writeText(command); setStatus("命令已复制"); })}>复制</button></div>)}</div>)}</div>
        <p>启动后告诉 Agent「连接 OpenCinema 工作台」（Claude Code 可用 <code>/opencinema:opencinema</code>），它注册为这个工程的接收端后，这里会显示“已连接”。</p>
        <details className="settingEditor"><summary>其他 MCP 客户端</summary><label>MCP 服务地址<input readOnly value={`${location.origin}/mcp`} aria-label="MCP 服务地址" /></label>
          <button type="button" disabled={busy} onClick={() => void perform(async () => {
            const current = await api("settings/get");
            const value = z.object({ mcp: z.object({ enabled: z.boolean(), token: z.string().min(32) }) }).parse(current);
            if (!value.mcp.enabled) throw new Error("MCP 服务已关闭");
            await navigator.clipboard.writeText(JSON.stringify({ mcpServers: { openCinema: { url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${value.mcp.token}` } } } }, null, 2));
            setStatus("连接配置已复制，请粘贴到 Agent 的 MCP 配置中");
          })}>复制 MCP 连接配置</button>
          <p>Agent 需调用 registerHost 声明能力，并用 pollHostRequests 领取画布指令、completeHostRequest 回报结果。仅建立 MCP 连接不代表 Agent 在线。</p></details>
      </>}
    </div>}
    {tab === "plugins" && <div className="settingsContent">
      <div className="settingsActions"><button type="button" disabled={busy} onClick={() => void perform(async () => { await controller.refreshPlugins(); setInstalledPlugins(await workbenchSettingsClient.plugins(new AbortController().signal)); setStatus("插件目录已刷新"); })}>刷新目录</button><button type="button" disabled={busy} onClick={() => pluginFile.current?.click()}>安装插件包</button><a href="/pluginSdk.js" target="_blank" rel="noreferrer">插件 SDK</a></div>
      <input ref={pluginFile} type="file" accept="application/json,.json" hidden aria-label="插件包" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        void perform(async () => {
          if (file.size > 128 * 1024 ** 2) throw new Error("插件包超过 128 MiB");
          const value = pluginPackageSchema.parse(JSON.parse(await file.text()));
          const catalog = z.array(z.object({ id: z.string().optional(), name: z.string(), builtin: z.boolean() })).parse(await api("nodes/get"));
          const existing = catalog.find(item => (item.id ?? item.name) === value.manifest.id);
          setPendingPackage({ value, size: file.size, existing: !!existing, builtin: !!existing?.builtin });
        });
      }} />
      {pendingPackage && <div className="pluginPackageReview"><strong>{pendingPackage.value.manifest.name ?? pendingPackage.value.manifest.id}</strong><span>{pendingPackage.value.manifest.id} · {pendingPackage.value.manifest.version}</span><span>{(pendingPackage.size / 1024 ** 2).toFixed(2)} MiB · {pendingPackage.value.assets?.length ?? 0} 个资源</span>{pendingPackage.origin && <span>{pendingPackage.origin}</span>}{typeof pendingPackage.value.manifest.description === "string" && <span>{pendingPackage.value.manifest.description}</span>}<div className="settingsActions"><button type="button" disabled={busy} onClick={() => void perform(async () => {
        const value = pendingPackage;
        await api("nodes/install", { fileName: `${value.value.manifest.id}.js`, ...value.value, ...(value.existing ? { force: true, replaceBuiltin: value.builtin } : {}) });
        await controller.refreshPlugins(); setInstalledPlugins(await workbenchSettingsClient.plugins(new AbortController().signal)); setPendingPackage(undefined); setStatus("插件已安装并登记能力");
      })}>{pendingPackage.existing ? pendingPackage.builtin ? "更新内置插件" : "更新已安装插件" : "安装此插件"}</button><button type="button" disabled={busy} onClick={() => setPendingPackage(undefined)}>取消</button></div></div>}
      <section className="pluginMarket" aria-label="插件市场">
        <div className="pluginMarketBar"><strong>插件市场</strong><span>{market ? `${market.plugins.length} 个插件 · ${new URL(market.url).host} · 安装前按 SHA-256 校验` : "静态目录，默认来自 opencinema.site；下载后按目录中的 SHA-256 校验，再经本机服务安装。"}</span><button type="button" disabled={busy || marketLoading} onClick={() => void loadMarket()}>{marketLoading ? "正在读取…" : market ? "刷新市场" : "打开插件市场"}</button></div>
        {marketError && <p className="settingsError" role="alert">{marketError}</p>}
        {market?.plugins.length === 0 && <p>市场目录暂时没有插件。</p>}
        {market?.plugins.map(entry => {
          const current = installedPlugins.find(plugin => (plugin.id ?? plugin.name) === entry.id), same = current?.version === entry.version;
          const description = entry.description["zh-CN"] ?? entry.description.zh ?? entry.description.en ?? Object.values(entry.description)[0] ?? "";
          return <section className="pluginSettingsCard pluginMarketCard" key={`${entry.id}@${entry.version}`}>
            <div className="pluginMarketHead"><strong>{entry.displayName?.["zh-CN"] ?? entry.name}</strong><small>{entry.id} · {entry.version} · {entry.author} · {entry.license} · {(entry.size / 1024 ** 2).toFixed(2)} MiB</small></div>
            <p>{description}</p>
            {(entry.tags.length > 0 || Object.keys(entry.requires).length > 0) && <div className="pluginMarketTags">{entry.tags.map(tag => <span key={tag}>{tag}</span>)}{Object.keys(entry.requires).map(name => <span key={`requires:${name}`} className="pluginMarketRequires" title="插件声明需要的宿主能力">{name}</span>)}</div>}
            <div className="settingsActions">
              <button type="button" disabled={busy || snapshot.transitioning || same} onClick={() => void perform(() => reviewMarketEntry(entry))}>{same ? `已安装 ${entry.version}` : current ? `下载更新 ${entry.version}` : "下载并复核"}</button>
              {entry.homepage && <a href={entry.homepage} target="_blank" rel="noreferrer">主页</a>}
            </div>
          </section>;
        })}
        <details><summary>市场地址</summary>
          <label>index.json 地址<input value={marketUrlDraft} placeholder={defaultPluginMarketUrl} disabled={busy || !generalConfiguration} spellCheck={false} onChange={event => setMarketUrlDraft(event.target.value)} /></label>
          <div className="settingsActions"><button type="button" disabled={busy || !generalConfiguration} onClick={() => void perform(async () => {
            if (!generalConfiguration) throw new Error("设置尚未读取");
            const next = await workbenchSettingsClient.saveGeneralConfiguration({ pluginMarketUrl: marketUrlDraft.trim() }, generalConfiguration.configRevision, new AbortController().signal);
            setGeneralConfiguration(next); setMarket(undefined); setStatus(marketUrlDraft.trim() ? "市场地址已保存" : "已恢复默认市场地址");
          })}>保存地址</button><span>留空恢复默认。只接受 https；本机开发可用 http://127.0.0.1。</span></div>
        </details>
      </section>
      {installedPlugins.map(plugin => <section className="pluginSettingsCard" key={plugin.name}>
        <label className="pluginSetting"><span><strong>{plugin.displayName || plugin.name}</strong><small>{plugin.name} · {plugin.version ?? ""}{plugin.builtin ? " · 内置" : ""}</small></span><input type="checkbox" aria-label={`启用${plugin.displayName || plugin.name}`} checked={plugin.enabled} disabled={busy || snapshot.transitioning} onChange={event => void perform(async () => { await controller.setPluginEnabled(plugin.name, event.target.checked); setInstalledPlugins(await workbenchSettingsClient.plugins(new AbortController().signal)); })} /></label>
        {plugin.loadError && <p className="settingsError" role="alert">{plugin.loadError}</p>}
        <div className="settingsActions">
          {!!plugin.configRules?.length && <button type="button" disabled={busy || plugin.canConfigure === false} onClick={() => { setConfiguringPlugin(plugin); setPluginValues(plugin.config ?? {}); }}>配置</button>}
          {plugin.installed && <><button type="button" disabled={busy || !plugin.enabled || !plugin.revision} onClick={() => void perform(async () => {
            const value = await workbenchSettingsClient.pluginPackage(plugin.name, plugin.revision!, new AbortController().signal);
            const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = `${plugin.name}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setStatus("插件包已导出，不包含运行配置");
          })}>导出插件包</button><button type="button" disabled={busy} onClick={() => setRemovingPlugin(plugin.name)}>{plugin.builtin ? "恢复内置版本" : "卸载"}</button></>}
        </div>
        {removingPlugin === plugin.name && <div className="settingConfirmation"><p>{plugin.builtin ? "移除已安装的更新并恢复内置版本。" : "卸载插件后，现有节点和素材会保留；重新安装后可继续编辑。"}</p><div className="settingsActions"><button type="button" disabled={busy} onClick={() => void perform(async () => { await workbenchSettingsClient.uninstallPlugin(plugin.name, new AbortController().signal, plugin.builtin); await controller.refreshPlugins(); setInstalledPlugins(await workbenchSettingsClient.plugins(new AbortController().signal)); setRemovingPlugin(undefined); setConfiguringPlugin(undefined); setStatus(plugin.builtin ? "已恢复内置版本" : "插件已卸载"); })}>{plugin.builtin ? "确认恢复" : "确认卸载"}</button><button type="button" disabled={busy} onClick={() => setRemovingPlugin(undefined)}>取消</button></div></div>}
      </section>)}
      {configuringPlugin && <form className="settingEditor" onSubmit={event => { event.preventDefault(); void perform(async () => { const result = await workbenchSettingsClient.savePlugin(configuringPlugin.name, pluginValues, configuringPlugin.configRevision, new AbortController().signal); setConfiguringPlugin({ ...configuringPlugin, ...result }); setInstalledPlugins(await workbenchSettingsClient.plugins(new AbortController().signal)); await controller.refreshPlugins(); setStatus("插件配置已保存"); }); }}>
        <strong>{configuringPlugin.displayName || configuringPlugin.name} · 配置</strong><SettingFields rules={configuringPlugin.configRules ?? []} values={pluginValues} disabled={busy} onChange={(field, value) => setPluginValues({ ...pluginValues, [field]: value })} /><div className="settingsActions"><button type="submit" disabled={busy}>保存配置</button><button type="button" disabled={busy} onClick={() => setConfiguringPlugin(undefined)}>关闭配置</button></div>
      </form>}
      <p>已安装的插件可读取和修改工作区。停用插件会保留画布和素材，重新启用后恢复编辑能力。</p>
    </div>}
    {tab === "models" && <div className="settingsContent providerSettings">
      <div className="providerMaster">
      <div className="providerList" role="group" aria-label="媒体供应商">{providers.map(provider => <button type="button" className="providerRow" key={provider.id} aria-pressed={provider.id === providerId} onClick={() => selectProvider(provider.id)}><span><strong>{provider.label}</strong><small>{providerSummary(provider)}</small></span><em data-ready={provider.transport === "local" || provider.videoProtocol === "adapter" || !!provider.credentialConfigured}>{provider.transport === "local" ? "本地服务" : provider.videoProtocol === "adapter" ? "本机适配器" : provider.credentialConfigured ? "已配置" : "待配置"}</em></button>)}</div>
      <div className="settingsActions"><button type="button" disabled={busy} aria-expanded={addingProvider} onClick={() => setAddingProvider(!addingProvider)}>添加自定义供应商</button></div>
      {providerCatalog.some(provider => !providers.some(item => item.id === provider.id)) && <label>恢复内置供应商<select value="" disabled={busy} onChange={event => { const id = event.target.value; if (id) void perform(async () => { const value = await workbenchSettingsClient.addBuiltinProvider(id, new AbortController().signal); await refreshProviderList(); setProviderId(value.id); setModelDrafts(draftModels(value)); setProviderValues({}); setStatus("内置供应商已恢复，请填写连接配置"); }); }}><option value="">选择供应商</option>{providerCatalog.filter(provider => !providers.some(item => item.id === provider.id)).map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>}
      </div>
      <div className="providerDetail">
      {!activeProvider && !addingProvider && <p className="providerPlaceholder">选择左侧的供应商，填写 API Key 或服务地址后，就能在生成节点里选它的模型。本地和局域网服务不需要 Key。</p>}
      {addingProvider && <form className="settingEditor" onSubmit={event => { event.preventDefault(); void perform(async () => { const value = await workbenchSettingsClient.addProvider(providerSource, new AbortController().signal); const list = await refreshProviderList(); setProviderId(value.id); setModelDrafts(draftModels(list.find(item => item.id === value.id) ?? value)); setProviderValues({}); setAddingProvider(false); setProviderSource(""); setStatus("供应商已添加"); }); }}><label>HTTP 供应商清单（JSON）<textarea rows={8} value={providerSource} maxLength={2 * 1024 ** 2} onChange={event => setProviderSource(event.target.value)} spellCheck={false} /></label><input ref={providerFile} type="file" accept="application/json,.json" hidden aria-label="供应商清单文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void perform(async () => { if (file.size > 2 * 1024 ** 2) throw new Error("供应商清单超过 2 MiB"); setProviderSource(await file.text()); }); }} /><p>从模板改起：把地址、模型 ID 换成你的服务，API Key 添加后再在连接配置里填写，不要写进清单。协议有 openaiVideo、ark（仅视频），fal、replicate、httpTask（图片、视频、音频）和 adapter（本机适配器，可执行文件只能手动放到数据目录，清单不能声明命令）；连本机或局域网服务时加 transport: "local"。详见 docs/videoProvider.md。</p><div className="settingsActions"><button type="button" disabled={busy} onClick={() => setProviderSource(JSON.stringify(providerTemplates.video, null, 2))}>视频服务模板</button><button type="button" disabled={busy} onClick={() => setProviderSource(JSON.stringify(providerTemplates.image, null, 2))}>图片服务模板</button><button type="button" disabled={busy} onClick={() => setProviderSource(JSON.stringify(providerTemplates.comfy, null, 2))}>其他 ComfyUI 服务模板</button><button type="button" disabled={busy} onClick={() => providerFile.current?.click()}>读取 JSON 文件</button><button type="button" disabled={busy || !providerSource.trim()} onClick={() => void perform(async () => { const value = await workbenchSettingsClient.validateProvider(providerSource, new AbortController().signal); setStatus(`清单有效：${value.label}，${value.models.length} 个模型`); })}>校验清单</button><button type="submit" disabled={busy || !providerSource.trim()}>添加供应商</button><button type="button" disabled={busy} onClick={() => setAddingProvider(false)}>取消</button></div></form>}
      {activeProvider && !addingProvider && <>
      {typeof activeProvider.videoProtocol === "string" && <p>{activeProvider.transport === "local" ? "本地 / 局域网执行" : activeProvider.videoProtocol === "openaiVideo" ? "远程模型服务" : "平台执行"} · 与所有生成节点共用任务和产物入口</p>}
      {activeProvider.videoProtocol === "comfyui" && <ComfySettings provider={activeProvider} busy={busy} perform={perform} onStatus={setStatus} onSaved={async value => { const list = await refreshProviderList(); if (value) setModelDrafts(draftModels(list.find(item => item.id === value.id) ?? value)); }} />}
      {activeProvider.id !== "comfyui" && <form className="settingEditor" onSubmit={event => { event.preventDefault(); void perform(async () => {
      if (!providerId) return;
      const current = z.record(z.string(), z.unknown()).parse(await api("settings/get"));
      const configs = current.mediaProviderConfigs && typeof current.mediaProviderConfigs === "object" ? current.mediaProviderConfigs as Record<string, Record<string, unknown>> : {};
      const next = { ...current, mediaProviderConfigs: { ...configs, [providerId]: { ...configs[providerId], ...providerValues } } };
      await api("settings/save", { settings: next }, "PUT"); setSettings(next); await refreshProviderList(); setStatus("媒体服务设置已保存，可以在生成节点里选择模型");
    }); }}><strong>{activeProvider.label} · 连接配置</strong><SettingFields rules={activeProvider.rules ?? []} values={providerValues} disabled={busy} onChange={(field, value) => setProviderValues({ ...providerValues, [field]: value })} /><button type="submit" disabled={busy}>保存连接配置</button></form>}
      <form className="settingEditor" onSubmit={event => { event.preventDefault(); void perform(async () => { const models = modelDrafts.map(({ options, ...fields }) => { const parsed = z.record(z.string(), z.json()).parse(JSON.parse(options)); return providerModelSchema.parse({ ...parsed, ...fields }); }); const result = await workbenchSettingsClient.saveProviderModels(providerId, models, activeProvider.revision, new AbortController().signal); await refreshProviderList(); setModelDrafts(draftModels(result)); setStatus("模型列表已保存"); }); }}><strong>模型列表 · {modelDrafts.length}</strong>
        {modelDrafts.map((model, index) => <div className="providerModelEditor" key={index}><div className="providerModelFields"><label>模型 ID<input value={model.id} required maxLength={256} disabled={busy} onChange={event => setModelDrafts(modelDrafts.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} /></label><label>显示名称<input value={model.label} required maxLength={200} disabled={busy} onChange={event => setModelDrafts(modelDrafts.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} /></label><label>类型<select value={model.type} disabled={busy} onChange={event => setModelDrafts(modelDrafts.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as ModelDraft["type"] } : item))}><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option>{model.type === "text" && <option value="text">文本（保留）</option>}</select></label><button type="button" disabled={busy} aria-label={`移除模型 ${model.label || index + 1}`} onClick={() => setModelDrafts(modelDrafts.filter((_, itemIndex) => itemIndex !== index))}>移除</button></div><details><summary>高级能力声明</summary><label>尺寸、时长、参考素材等能力（JSON）<textarea rows={4} spellCheck={false} value={model.options} disabled={busy} onChange={event => setModelDrafts(modelDrafts.map((item, itemIndex) => itemIndex === index ? { ...item, options: event.target.value } : item))} /></label></details></div>)}
        <div className="settingsActions"><button type="button" disabled={busy} onClick={() => setModelDrafts([...modelDrafts, { id: "", label: "", type: "image", options: "{}" }])}>添加模型</button><button type="submit" disabled={busy}>保存模型列表</button><button type="button" disabled={busy} onClick={() => setModelDrafts(draftModels(activeProvider))}>还原修改</button>{activeProvider.modelsUrl && <button type="button" disabled={busy} onClick={() => void perform(async () => { const value = await workbenchSettingsClient.fetchProviderModels(providerId, activeProvider.revision, new AbortController().signal); await refreshProviderList(); setModelDrafts(draftModels(value)); setStatus("已从供应商获取模型列表"); })}>从供应商获取模型</button>}</div>
      </form><div className="settingsActions"><button type="button" disabled={busy} onClick={() => setRemovingProvider(true)}>删除供应商</button></div>{removingProvider && <div className="settingConfirmation"><p>删除 {activeProvider.label} 及其连接配置；现有节点的模型引用会保留，生成前需要选择可用模型。</p><div className="settingsActions"><button type="button" disabled={busy} onClick={() => void perform(async () => { await workbenchSettingsClient.removeProvider(providerId, activeProvider.revision, new AbortController().signal); await refreshProviderList(); setProviderId(""); setRemovingProvider(false); setStatus("供应商已删除"); })}>确认删除供应商</button><button type="button" disabled={busy} onClick={() => setRemovingProvider(false)}>取消</button></div></div>}
      </>}
      </div>
      <p>视频专项模型在视频节点中选择。通用创作与理解由当前宿主 Agent 执行。</p>
      <section className="localModelSetting"><strong>本地分析模型</strong><span>Video Depth Anything Small · 视频时序深度</span>{depth && <p>{depth.message}</p>}{depth?.preparationProgress && <><progress max={depth.preparationProgress.total || 1} value={depth.preparationProgress.received} /><span>{Math.round(depth.preparationProgress.received / 1024 ** 2)} / {Math.round(depth.preparationProgress.total / 1024 ** 2)} MiB</span>{depth.preparationProgress.error && <p role="alert">{depth.preparationProgress.error}</p>}</>}<div className="settingsActions"><button type="button" disabled={busy || !snapshot.directory || depth?.available || depth?.preparationProgress?.phase === "preparing"} onClick={() => void perform(async () => { await api("media/referenceDepth/prepareModel", { directory: snapshot.directory }); setStatus("正在准备固定版本的本地分析模型"); })}>{depth?.available ? "模型已就绪" : "准备视频深度模型"}</button>{["preparing", "cancelling"].includes(depth?.preparationProgress?.phase ?? "") && <button type="button" disabled={busy} onClick={() => void perform(async () => { await api("media/referenceDepth/cancelModelPreparation", { directory: snapshot.directory }); })}>取消准备</button>}</div></section>
    </div>}
    {tab === "ffmpeg" && <div className="settingsContent">
      <div className="settingRow"><strong>FFmpeg</strong><span>{ffmpegBusy ? "正在准备" : ffmpeg && Object.values(ffmpeg.tools).every(tool => tool.version) ? "已就绪" : "待配置"}</span><button type="button" disabled={busy} onClick={() => void perform(refreshFfmpeg)}>重新检测</button></div>
      <p>音视频处理使用当前 OpenCinema 服务上的 FFmpeg 与 ffprobe。</p>
      {ffmpegConfiguration && <form className="settingEditor" onSubmit={event => { event.preventDefault(); void perform(async () => { const { mode, source } = ffmpegConfiguration.config; await workbenchSettingsClient.saveFfmpegConfiguration({ mode, ...(source ? { source } : {}) }, ffmpegConfiguration.configRevision, new AbortController().signal); await refreshFfmpeg(); setStatus("FFmpeg 运行配置已保存"); }); }}>
        <label>运行方式<select value={ffmpegConfiguration.config.mode} disabled={busy || ffmpegBusy} onChange={event => setFfmpegConfiguration({ ...ffmpegConfiguration, config: { ...ffmpegConfiguration.config, mode: event.target.value as "auto" | "download" | "system" } })}><option value="auto">自动选择</option><option value="download">仅使用下载版</option><option value="system">仅使用系统安装版</option></select></label>
        <p>{ffmpegConfiguration.config.mode === "auto" ? "优先使用已下载的版本，未下载时从服务的系统 PATH 查找。" : ffmpegConfiguration.config.mode === "system" ? "从服务的系统 PATH 查找；无需重复安装。" : "仅使用 OpenCinema 数据目录中的下载版。"}</p>
        <label>下载线路<select value={ffmpegConfiguration.config.source || ffmpeg?.sources.find(source => source.available)?.id || ""} disabled={busy || ffmpegBusy} onChange={event => setFfmpegConfiguration({ ...ffmpegConfiguration, config: { ...ffmpegConfiguration.config, source: event.target.value } })}>{ffmpeg?.sources.filter(source => source.available).map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select></label>
        <div className="settingsActions"><button type="submit" disabled={busy || ffmpegBusy}>保存运行配置</button><button type="button" disabled={busy || ffmpegBusy || !ffmpeg?.supported || ffmpegConfiguration.config.mode === "system"} onClick={() => void perform(async () => { const source = ffmpegConfiguration.config.source || ffmpeg?.sources.find(item => item.available)?.id; if (!source) throw new Error("没有可用的下载线路"); const download = await workbenchSettingsClient.downloadFfmpeg(source, new AbortController().signal); setFfmpeg(current => current ? { ...current, download } : current); setStatus("FFmpeg 下载已开始"); })}>下载并安装</button>{ffmpegBusy && ffmpeg?.download.phase !== "installing" && <button type="button" disabled={busy} onClick={() => void perform(async () => { await workbenchSettingsClient.cancelFfmpeg(new AbortController().signal); await refreshFfmpeg(); setStatus("已请求取消下载"); })}>取消下载</button>}</div>
      </form>}
      {ffmpeg && <><div className="settingProgress" aria-live="polite"><span>{({ idle: "等待下载", downloading: "正在下载", verifying: "正在校验", installing: "正在安装", completed: "安装完成", error: "下载失败", cancelled: "已取消" } as Record<string, string>)[ffmpeg.download.phase] ?? ffmpeg.download.phase}</span>{ffmpeg.download.phase !== "idle" && <><progress max={ffmpeg.download.total || undefined} value={ffmpeg.download.total ? ffmpeg.download.received : undefined} /><span>{(ffmpeg.download.received / 1024 ** 2).toFixed(1)}{ffmpeg.download.total ? ` / ${(ffmpeg.download.total / 1024 ** 2).toFixed(1)}` : ""} MiB</span></>}{ffmpeg.download.error && <p role="alert">{ffmpeg.download.error}</p>}</div><details className="settingEditor"><summary>运行环境与版本</summary><p>{ffmpeg.platform} / {ffmpeg.arch} · {ffmpeg.target}</p>{Object.entries(ffmpeg.tools).map(([name, tool]) => <div className="ffmpegTool" key={name}><strong>{name} · {tool.version ? tool.source === "download" ? "下载版" : "系统安装版" : "不可用"}</strong>{tool.version && <p>{tool.version}</p>}{tool.path && <code>{tool.path}</code>}{tool.error && <p>{tool.error}</p>}</div>)}</details>{!ffmpeg.supported && <p>此平台没有已核验的下载版本，请使用系统安装版。</p>}</>}
    </div>}
    {status && <p className="settingsStatus" role="status">{status}</p>}{error && <p className="settingsError" role="alert">{error}</p>}
  </div>;
}
