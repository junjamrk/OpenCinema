import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { z } from "zod";
import { capabilityLabel } from "@toonflow/nodes-scaffold/nodeCapabilities";
import SettingFields from "./settingFields";
import type { WorkbenchController } from "./types";
import { compareVersions, defaultPluginMarketUrl, parsePluginPackage, parseUrl, pluginIncompatibility, pluginMarketClient, pluginMarketUrlOf, workbenchSettingsClient, type PluginMarket, type PluginMarketEntry, type pluginPackageSchema, type pluginSchema } from "@/lib/workbenchSettingsClient";

type Plugin = z.infer<typeof pluginSchema>;
type PluginPackage = z.infer<typeof pluginPackageSchema>;
type GeneralConfiguration = Awaited<ReturnType<typeof workbenchSettingsClient.generalConfiguration>>;
type PackageSource = { kind: "file"; fileName: string } | { kind: "market"; marketHost: string; packageHost: string; sha256: string };
type PendingPackage = { value: PluginPackage; size: number; existing?: Plugin; source: PackageSource; minHost?: string };
type VersionChange = "install" | "repair" | "upgrade" | "same" | "downgrade";

const developmentGuideUrl = "https://github.com/junjamrk/OpenCinema/blob/main/docs/pluginDevelopment.md";
const marketActions: Record<VersionChange, (version: string) => string> = { install: () => "下载并复核", repair: version => `重新下载修复 ${version}`, upgrade: version => `下载更新 ${version}`, same: version => `已安装 ${version}`, downgrade: version => `降级到 ${version}` };
const reviewActions: Record<VersionChange, (version: string) => string> = { install: () => "安装此插件", repair: version => `重新安装 ${version} 以修复`, upgrade: version => `更新到 ${version}`, same: version => `重新安装 ${version}`, downgrade: version => `降级到 ${version}` };
const pluginIdOf = (plugin: Plugin) => plugin.id ?? plugin.name;
const httpLink = (value?: string) => value && /^https?:\/\//i.test(value) ? value : undefined;
const signal = () => new AbortController().signal;

function versionChange(version: string, current: Plugin | undefined, broken: boolean): VersionChange {
  if (!current) return "install";
  if (broken) return "repair";
  const order = compareVersions(version, current.version ?? "");
  return order > 0 ? "upgrade" : order < 0 ? "downgrade" : "same";
}
function providerAddresses(manifest: PluginPackage["manifest"]) {
  return (manifest.providers ?? []).map(provider => ({ label: String(provider.label ?? provider.id ?? "未命名服务"), addresses: [...new Set([provider.apiUrl, provider.modelsUrl].filter(value => typeof value === "string" && value))] as string[] }));
}
function CapabilityList({ requires }: { requires?: Record<string, number> }) {
  const names = Object.keys(requires ?? {});
  return names.length ? <ul>{names.map(name => <li key={name} title={name}>{capabilityLabel(name)}</li>)}</ul> : <>未声明</>;
}

function PackageReview({ pending, blockers, busy, onInstall, onCancel }: { pending: PendingPackage; blockers: string[]; busy: boolean; onInstall(): void; onCancel(): void }) {
  const { value: { manifest, assets }, size, existing, source } = pending;
  const change = versionChange(manifest.version, existing, false), homepage = httpLink(manifest.homepage), services = providerAddresses(manifest);
  const offMarket = source.kind === "market" && source.packageHost !== source.marketHost;
  return <div className="pluginPackageReview">
    <strong>{manifest.displayName ?? manifest.name ?? manifest.id}</strong>
    <span>{manifest.id} · {existing?.version && existing.version !== manifest.version ? `${existing.version} → ${manifest.version}` : manifest.version}{existing?.builtin ? " · 替换内置版本，之后可恢复" : ""}</span>
    <span>{(size / 1024 ** 2).toFixed(2)} MiB · {assets?.length ?? 0} 个资源</span>
    {manifest.description && <span>{manifest.description}</span>}
    <dl className="pluginFacts">
      <div><dt>作者</dt><dd>{manifest.author || "未声明"}</dd></div>
      <div><dt>许可</dt><dd>{manifest.license || "未声明"}</dd></div>
      {homepage && <div><dt>主页</dt><dd><a href={homepage} target="_blank" rel="noreferrer">{homepage}</a></dd></div>}
      <div><dt>来源</dt><dd>{source.kind === "file" ? `本地文件 ${source.fileName}` : `插件市场 ${source.marketHost} · SHA-256 已校验 ${source.sha256.slice(0, 16)}…`}{offMarket && <em>包文件托管在 {source.packageHost}，不是市场所在的地址</em>}</dd></div>
      <div><dt>声明的能力</dt><dd><CapabilityList requires={manifest.requires} /></dd></div>
      {services.length > 0 && <div><dt>服务地址</dt><dd><em>你为这些服务填写的 API Key 会发送到下面的地址</em><ul>{services.map(service => <li key={service.label}>{service.label}：{service.addresses.join("、") || "本机适配器"}</li>)}</ul></dd></div>}
    </dl>
    {manifest.readme?.trim() && <details className="pluginReadme"><summary>插件说明</summary><pre>{manifest.readme}</pre></details>}
    {blockers.length > 0 && <div className="pluginBlockers" role="alert"><strong>当前工作台不能安装这个插件</strong>{blockers.map(blocker => <span key={blocker}>{blocker}</span>)}</div>}
    <p className="pluginTrustNotice">安装后插件代码会立即运行。它和工作台在同一个页面环境里，上面声明的能力不是沙箱：插件可以读写工程文件、读取你保存的 API Key、向外部地址发送数据。只安装你信任来源的插件。</p>
    <div className="settingsActions"><button type="button" disabled={busy || blockers.length > 0} onClick={onInstall}>{reviewActions[change](manifest.version)}</button><button type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </div>;
}

export default function PluginSettings({ controller, busy, perform, onStatus, onError, generalConfiguration, onGeneralConfiguration, focusPluginId }: {
  controller: WorkbenchController; busy: boolean; perform(action: () => Promise<void>): Promise<void>; onStatus(message: string): void; onError(message: string): void;
  generalConfiguration?: GeneralConfiguration; onGeneralConfiguration(value: GeneralConfiguration): void; focusPluginId?: string;
}) {
  const { transitioning } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [hostVersion, setHostVersion] = useState<string>();
  const [configuring, setConfiguring] = useState<Plugin>();
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [removing, setRemoving] = useState<string>();
  const [pending, setPending] = useState<PendingPackage>();
  const [market, setMarket] = useState<PluginMarket>();
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [marketUrlDraft, setMarketUrlDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const marketUrl = generalConfiguration && pluginMarketUrlOf(generalConfiguration.general);
  const capabilities = controller.getCapabilities();
  const latest = new Map<string, PluginMarketEntry>();
  for (const entry of market?.plugins ?? []) if (compareVersions(entry.version, latest.get(entry.id)?.version ?? "") > 0) latest.set(entry.id, entry);
  const issueOf = (plugin: Plugin) => plugin.loadError || controller.getPluginError(pluginIdOf(plugin));
  const focusMissing = !!focusPluginId && !!market && !marketLoading && !latest.has(focusPluginId) && !plugins.some(plugin => pluginIdOf(plugin) === focusPluginId);

  // 插件按需加载，不在当前画布上的插件坏了不会自己报错；每次读目录都探测一遍，卡片才能显示真实状态。
  async function refreshInstalled(abort = signal()) {
    const list = await workbenchSettingsClient.plugins(abort);
    setPlugins(list);
    await Promise.all(list.filter(plugin => plugin.installed && plugin.enabled).map(plugin => controller.probePlugin(pluginIdOf(plugin))));
  }
  async function loadMarket(abort: AbortSignal) {
    setMarketLoading(true); setMarketError("");
    try {
      const general = generalConfiguration ?? await workbenchSettingsClient.generalConfiguration(abort);
      setMarket(await pluginMarketClient.index(pluginMarketUrlOf(general.general), abort));
    } catch (value) { if (!abort.aborted) setMarketError(value instanceof Error ? value.message : String(value)); }
    finally { if (!abort.aborted) setMarketLoading(false); }
  }
  // 插件的安装、停用和卸载也可能发生在 Agent 工具里，所以每次进入本页都重新读取。
  useEffect(() => {
    const abort = new AbortController();
    refreshInstalled(abort.signal).catch(value => { if (!abort.signal.aborted) onError(value instanceof Error ? value.message : String(value)); });
    workbenchSettingsClient.hostVersion(abort.signal).then(setHostVersion).catch(() => {});
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!marketUrl) return;
    const abort = new AbortController();
    setMarket(undefined);
    void loadMarket(abort.signal);
    return () => abort.abort();
  }, [marketUrl]);
  useEffect(() => { const value = generalConfiguration?.general.pluginMarketUrl; setMarketUrlDraft(typeof value === "string" ? value : ""); }, [generalConfiguration?.configRevision]);
  useEffect(() => {
    if (focusPluginId) page.current?.querySelector(`[data-focused="true"]`)?.scrollIntoView({ block: "center" });
  }, [focusPluginId, market, plugins]);

  async function review(value: PluginPackage, size: number, source: PackageSource, minHost?: string) {
    const catalog = await workbenchSettingsClient.plugins(signal());
    setPlugins(catalog);
    setPending({ value, size, source, minHost, existing: catalog.find(plugin => pluginIdOf(plugin) === value.manifest.id) });
    onStatus("请核对下方信息后确认安装");
  }
  // 市场条目只下载并校验，安装仍走同一张复核卡片；用户看清来源、能力和服务地址后才执行。
  async function reviewEntry(entry: PluginMarketEntry) {
    const downloaded = await pluginMarketClient.download(entry, signal());
    await review(downloaded.value, downloaded.size, { kind: "market", marketHost: new URL(market?.url ?? defaultPluginMarketUrl).host, packageHost: new URL(entry.packageUrl).host, sha256: downloaded.sha256 }, entry.minHost);
  }
  async function install({ value, existing }: PendingPackage) {
    await workbenchSettingsClient.installPlugin(value, { force: !!existing, replaceBuiltin: !!existing?.builtin }, signal());
    setPending(undefined);
    try { await controller.refreshPlugins(); } finally { await refreshInstalled(); }
    const failure = await controller.probePlugin(value.manifest.id);
    onStatus(failure ? "插件已安装，但没有加载成功，原因见插件卡片" : "插件已安装并加载成功");
  }
  async function retry(plugin: Plugin) {
    try { await controller.refreshPlugins(); } finally { await refreshInstalled(); }
    onStatus(await controller.probePlugin(pluginIdOf(plugin)) ? "仍然无法加载，原因见插件卡片" : "插件已加载");
  }
  async function exportPackage(plugin: Plugin) {
    const value = await workbenchSettingsClient.pluginPackage(plugin.name, plugin.revision!, signal());
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${plugin.name}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onStatus("插件包已导出，不包含运行配置");
  }
  async function uninstall(plugin: Plugin) {
    await workbenchSettingsClient.uninstallPlugin(plugin.name, signal(), plugin.builtin);
    await controller.refreshPlugins();
    await refreshInstalled();
    setRemoving(undefined); setConfiguring(undefined);
    onStatus(plugin.builtin ? "已恢复内置版本" : "插件已卸载");
  }

  return <div className="settingsContent" ref={page}>
    <div className="settingsActions">
      <button type="button" disabled={busy} onClick={() => void perform(async () => { await controller.refreshPlugins(); await refreshInstalled(); onStatus("插件目录已刷新"); })}>刷新目录</button>
      <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>安装插件包</button>
      <a href={developmentGuideUrl} target="_blank" rel="noreferrer">开发指南</a>
    </div>
    <input ref={fileInput} type="file" accept="application/json,.json" hidden aria-label="插件包" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      void perform(async () => {
        if (file.size > 128 * 1024 ** 2) throw new Error("插件包超过 128 MiB");
        await review(parsePluginPackage(await file.text()), file.size, { kind: "file", fileName: file.name });
      });
    }} />
    {pending && <PackageReview pending={pending} blockers={pluginIncompatibility({ requires: pending.value.manifest.requires, minHost: pending.minHost }, capabilities, hostVersion)} busy={busy} onInstall={() => void perform(() => install(pending))} onCancel={() => setPending(undefined)} />}
    {focusMissing && <p className="pluginFocusNotice" role="status">市场里没有 {focusPluginId}。可以向插件作者要 install.json，再用上方的“安装插件包”安装。</p>}
    <section className="pluginMarket" aria-label="插件市场">
      <div className="pluginMarketBar">
        <strong>插件市场</strong>
        <span>{market ? `${market.plugins.length} 个插件 · ` : ""}进入此页时从 {parseUrl(market?.url ?? marketUrl ?? defaultPluginMarketUrl)?.host ?? marketUrl} 读取目录，不上传工程内容；安装前按目录中的 SHA-256 校验{market?.skipped ? ` · 已跳过 ${market.skipped} 条无效记录` : ""}</span>
        <button type="button" disabled={busy || marketLoading} onClick={() => void loadMarket(signal())}>{marketLoading ? "正在读取…" : marketError ? "重试" : "刷新市场"}</button>
      </div>
      {marketError && <p className="settingsError" role="alert">{marketError}</p>}
      {market?.plugins.length === 0 && <p>市场目录暂时没有插件。</p>}
      {market?.plugins.map(entry => {
        const current = plugins.find(plugin => pluginIdOf(plugin) === entry.id);
        const change = versionChange(entry.version, current, !!current && !!issueOf(current));
        const blockers = pluginIncompatibility(entry, capabilities, hostVersion);
        const description = entry.description["zh-CN"] ?? entry.description.zh ?? entry.description.en ?? Object.values(entry.description)[0] ?? "";
        return <section className="pluginSettingsCard pluginMarketCard" key={`${entry.id}@${entry.version}`} data-focused={entry.id === focusPluginId || undefined}>
          <div className="pluginMarketHead"><strong>{entry.displayName?.["zh-CN"] ?? entry.name}</strong><small>{entry.id} · {entry.version} · {entry.author} · {entry.license} · {(entry.size / 1024 ** 2).toFixed(2)} MiB</small></div>
          <p>{description}</p>
          {(entry.tags.length > 0 || Object.keys(entry.requires).length > 0) && <div className="pluginMarketTags">{entry.tags.map(tag => <span key={tag}>{tag}</span>)}{Object.keys(entry.requires).map(name => <span key={`requires:${name}`} className="pluginMarketRequires" title={`插件声明需要的宿主能力：${name}`}>{capabilityLabel(name)}</span>)}</div>}
          {blockers.map(blocker => <p className="settingsError" key={blocker}>{blocker}</p>)}
          <div className="settingsActions">
            <button type="button" disabled={busy || transitioning || change === "same" || blockers.length > 0} onClick={() => void perform(() => reviewEntry(entry))}>{marketActions[change](entry.version)}</button>
            {entry.homepage && <a href={entry.homepage} target="_blank" rel="noreferrer">主页</a>}
          </div>
        </section>;
      })}
      <details><summary>市场地址</summary>
        <label>index.json 地址<input value={marketUrlDraft} placeholder={defaultPluginMarketUrl} disabled={busy || !generalConfiguration} spellCheck={false} onChange={event => setMarketUrlDraft(event.target.value)} /></label>
        <div className="settingsActions"><button type="button" disabled={busy || !generalConfiguration} onClick={() => void perform(async () => {
          if (!generalConfiguration) throw new Error("设置尚未读取");
          onGeneralConfiguration(await workbenchSettingsClient.saveGeneralConfiguration({ pluginMarketUrl: marketUrlDraft.trim() }, generalConfiguration.configRevision, signal()));
          onStatus(marketUrlDraft.trim() ? "市场地址已保存" : "已恢复默认市场地址");
        })}>保存地址</button><span>留空恢复默认。只接受 https；本机开发可用 http://127.0.0.1。</span></div>
      </details>
    </section>
    {plugins.map(plugin => {
      const id = pluginIdOf(plugin), issue = issueOf(plugin), update = latest.get(id), label = plugin.displayName || plugin.name, homepage = httpLink(plugin.homepage);
      const updatable = !!update && !!plugin.version && compareVersions(update.version, plugin.version) > 0;
      return <section className="pluginSettingsCard" key={plugin.name} data-focused={!latest.has(id) && id === focusPluginId || undefined}>
        <label className="pluginSetting"><span><strong>{label}</strong><small>{plugin.name} · {plugin.version ?? ""}{plugin.builtin ? " · 内置" : ""}{updatable ? ` · 有更新 ${update.version}` : ""}</small></span><input type="checkbox" aria-label={`启用${label}`} checked={plugin.enabled} disabled={busy || transitioning} onChange={event => void perform(async () => { await controller.setPluginEnabled(plugin.name, event.target.checked); await refreshInstalled(); })} /></label>
        {plugin.description && <p className="pluginDescription">{plugin.description}</p>}
        {(plugin.author || plugin.license || homepage || !!plugin.tags?.length) && <div className="pluginMarketTags">{plugin.author && <span>{plugin.author}</span>}{plugin.license && <span>{plugin.license}</span>}{plugin.tags?.map(tag => <span key={tag}>{tag}</span>)}{homepage && <a href={homepage} target="_blank" rel="noreferrer">主页</a>}</div>}
        {issue && <p className="settingsError" role="alert">{issue}</p>}
        <div className="settingsActions">
          {updatable && <button type="button" disabled={busy || transitioning} onClick={() => void perform(() => reviewEntry(update))}>查看更新</button>}
          {issue && <button type="button" disabled={busy || transitioning} onClick={() => void perform(() => retry(plugin))}>重试加载</button>}
          {!!plugin.configRules?.length && <button type="button" disabled={busy || plugin.canConfigure === false} onClick={() => { setConfiguring(plugin); setConfigValues(plugin.config ?? {}); }}>配置</button>}
          {plugin.installed && <><button type="button" disabled={busy || !plugin.enabled || !plugin.revision || !!plugin.loadError} onClick={() => void perform(() => exportPackage(plugin))}>导出插件包</button><button type="button" disabled={busy} onClick={() => setRemoving(plugin.name)}>{plugin.builtin ? "恢复内置版本" : "卸载"}</button></>}
        </div>
        {removing === plugin.name && <div className="settingConfirmation"><p>{plugin.builtin ? "移除已安装的更新并恢复内置版本。" : "卸载插件后，现有节点和素材会保留；重新安装后可继续编辑。"}</p><div className="settingsActions"><button type="button" disabled={busy} onClick={() => void perform(() => uninstall(plugin))}>{plugin.builtin ? "确认恢复" : "确认卸载"}</button><button type="button" disabled={busy} onClick={() => setRemoving(undefined)}>取消</button></div></div>}
      </section>;
    })}
    {configuring && <form className="settingEditor" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const result = await workbenchSettingsClient.savePlugin(configuring.name, configValues, configuring.configRevision, signal());
      setConfiguring({ ...configuring, ...result }); await refreshInstalled(); await controller.refreshPlugins(); onStatus("插件配置已保存");
    }); }}>
      <strong>{configuring.displayName || configuring.name} · 配置</strong>
      <SettingFields rules={configuring.configRules ?? []} values={configValues} disabled={busy} onChange={(field, value) => setConfigValues({ ...configValues, [field]: value })} />
      <div className="settingsActions"><button type="submit" disabled={busy}>保存配置</button><button type="button" disabled={busy} onClick={() => setConfiguring(undefined)}>关闭配置</button></div>
    </form>}
    <p>停用插件会保留画布和素材，重新启用后恢复编辑能力。</p>
  </div>;
}
