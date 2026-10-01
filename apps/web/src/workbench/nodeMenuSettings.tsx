import { useEffect, useState, useSyncExternalStore } from "react";
import { IconArrowDown, IconArrowUp, IconEye, IconEyeOff, IconFolderMinus } from "@tabler/icons-react";
import { normalizeNodeMenu, resolveNodeMenu, serializeNodeMenu, type NodeMenuItem } from "@/lib/nodeMenu";
import { workbenchSettingsClient } from "@/lib/workbenchSettingsClient";
import type { WorkbenchController } from "./types";

function menuEntries(items: NodeMenuItem[], parentId = "", depth = 1): { item: NodeMenuItem; parentId: string; siblings: NodeMenuItem[]; depth: number }[] {
  return items.flatMap(item => [{ item, parentId, siblings: items, depth }, ...menuEntries(item.children ?? [], item.id, depth + 1)]);
}

function menuHeight(item: NodeMenuItem): number {
  return item.children?.length ? 1 + Math.max(...item.children.map(menuHeight)) : 1;
}

export default function NodeMenuSettings({ controller }: { controller: WorkbenchController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [items, setItems] = useState<NodeMenuItem[]>([]);
  const [configRevision, setConfigRevision] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [reload, setReload] = useState(0);
  const entries = menuEntries(items);
  const groups = entries.filter(entry => !!entry.item.children);
  const available = new Map(snapshot.plugins.map(plugin => [plugin.type, plugin]));

  useEffect(() => {
    const operation = new AbortController();
    setBusy(true); setError("");
    void workbenchSettingsClient.generalConfiguration(operation.signal).then(result => {
      if (operation.signal.aborted) return;
      setItems(resolveNodeMenu(normalizeNodeMenu(result.general.nodeMenu), controller.getSnapshot().plugins));
      setConfigRevision(result.configRevision); setDirty(false);
    }).catch(value => { if (!operation.signal.aborted) setError(value instanceof Error ? value.message : String(value)); }).finally(() => { if (!operation.signal.aborted) setBusy(false); });
    return () => operation.abort();
  }, [controller, reload]);
  useEffect(() => { if (configRevision) setItems(previous => resolveNodeMenu(previous, snapshot.plugins)); }, [configRevision, snapshot.plugins]);

  function edit(action: (items: NodeMenuItem[]) => void) {
    const next = structuredClone(items);
    action(next);
    const changed = menuEntries(next);
    for (const entry of menuEntries(items).filter(entry => entry.item.hidden && entry.item.children && !changed.some(current => current.item.id === entry.item.id))) {
      for (const child of entry.item.children!) { const promoted = changed.find(current => current.item.id === child.id); if (promoted) promoted.item.hidden = true; }
    }
    setItems(next); setDirty(true); setStatus("");
  }

  function move(id: string, parentId: string) {
    edit(next => {
      const list = menuEntries(next), source = list.find(entry => entry.item.id === id);
      const destination = parentId ? list.find(entry => entry.item.id === parentId) : undefined;
      if (!source || (parentId && !destination?.item.children)) return;
      source.siblings.splice(source.siblings.indexOf(source.item), 1);
      (destination?.item.children ?? next).push(source.item);
    });
  }

  async function save() {
    setBusy(true); setError(""); setStatus("");
    try {
      if (entries.some(entry => entry.item.children && !entry.item.label.trim())) throw new Error("菜单名称不能为空");
      const result = await workbenchSettingsClient.saveGeneralConfiguration({ nodeMenu: serializeNodeMenu(items) }, configRevision, new AbortController().signal);
      setItems(resolveNodeMenu(normalizeNodeMenu(result.general.nodeMenu), controller.getSnapshot().plugins));
      setConfigRevision(result.configRevision); setDirty(false); setStatus("节点菜单已保存");
      window.dispatchEvent(new Event("openCinema:general-settings-changed"));
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  }

  return <section className="settingsContent nodeMenuSettings" aria-label="节点菜单管理" aria-busy={busy}>
    <p>调整添加菜单的顺序、分组、别名和显示状态。最多三级，隐藏菜单会同时隐藏其中的节点。</p>
    <div className="settingsActions"><button type="button" disabled={busy || !configRevision || !dirty} onClick={() => void save()}>保存菜单</button><button type="button" disabled={busy} onClick={() => { setReload(value => value + 1); setStatus(""); }}>重新读取</button><button type="button" disabled={busy || !configRevision} onClick={() => { setItems(resolveNodeMenu([], snapshot.plugins)); setDirty(true); setStatus(""); }}>恢复默认菜单</button></div>
    <form className="nodeMenuCreate" onSubmit={event => { event.preventDefault(); if (!newGroupName.trim()) return; edit(next => next.push({ id: `group:${crypto.randomUUID()}`, label: newGroupName.trim(), hidden: false, children: [] })); setNewGroupName(""); }}><label htmlFor="newNodeMenuName">新菜单名称</label><input id="newNodeMenuName" value={newGroupName} maxLength={40} disabled={busy || !configRevision} onChange={event => setNewGroupName(event.target.value)} /><button type="submit" disabled={busy || !configRevision || !newGroupName.trim()}>添加分组</button></form>
    <div className="nodeMenuTree" role="list" aria-label="节点菜单项目">{entries.map(({ item, parentId, siblings, depth }) => {
      const index = siblings.indexOf(item), descendants = new Set(menuEntries(item.children ?? []).map(entry => entry.item.id));
      const parents = groups.filter(group => group.item.id !== item.id && !descendants.has(group.item.id) && group.depth + Math.max(menuHeight(item), item.children ? 2 : 1) <= 3);
      const name = item.alias || available.get(item.type ?? "")?.label || item.label;
      return <div className={`nodeMenuRow${item.hidden ? " nodeMenuHidden" : ""}`} role="listitem" key={item.id} style={{ paddingInlineStart: 10 + (depth - 1) * 18 }}>
        <div className="nodeMenuIdentity"><span className="nodeMenuKind">{item.children ? "菜单" : "节点"}</span><input aria-label={item.children ? `${name}菜单名称` : `${name}节点别名`} value={item.type ? item.alias ?? "" : item.label} placeholder={item.type ? available.get(item.type)?.label || item.label : undefined} maxLength={40} disabled={busy || !configRevision} onChange={event => edit(next => { const current = menuEntries(next).find(entry => entry.item.id === item.id)!.item; if (current.type) { current.alias = event.target.value; current.label = event.target.value || available.get(current.type)?.label || current.type; } else current.label = event.target.value; })} />{item.type && available.get(item.type)?.supported === false && <span className="nodeMenuUnavailable">插件未就绪</span>}</div>
        <select aria-label={`${name}所属菜单`} value={parentId} disabled={busy || !configRevision} onChange={event => move(item.id, event.target.value)}><option value="">一级菜单</option>{parents.map(parent => <option value={parent.item.id} key={parent.item.id}>{parent.item.label}</option>)}</select>
        <div className="nodeMenuActions"><button type="button" aria-label={`上移${name}`} title="上移" disabled={busy || index === 0} onClick={() => edit(next => { const current = menuEntries(next).find(entry => entry.item.id === item.id)!; const index = current.siblings.indexOf(current.item); current.siblings.splice(index - 1, 0, current.siblings.splice(index, 1)[0]!); })}><IconArrowUp aria-hidden="true" size={15} /></button><button type="button" aria-label={`下移${name}`} title="下移" disabled={busy || index === siblings.length - 1} onClick={() => edit(next => { const current = menuEntries(next).find(entry => entry.item.id === item.id)!; const index = current.siblings.indexOf(current.item); current.siblings.splice(index + 1, 0, current.siblings.splice(index, 1)[0]!); })}><IconArrowDown aria-hidden="true" size={15} /></button><button type="button" aria-label={`${item.hidden ? "显示" : "隐藏"}${name}`} title={item.hidden ? "显示" : "隐藏"} aria-pressed={!item.hidden} disabled={busy} onClick={() => edit(next => { const current = menuEntries(next).find(entry => entry.item.id === item.id)!.item; current.hidden = !current.hidden; })}>{item.hidden ? <IconEyeOff aria-hidden="true" size={15} /> : <IconEye aria-hidden="true" size={15} />}</button>{item.children && <button type="button" aria-label={`移除${name}菜单并保留子项`} title="移除菜单，保留子项" disabled={busy} onClick={() => edit(next => { const current = menuEntries(next).find(entry => entry.item.id === item.id)!; current.siblings.splice(current.siblings.indexOf(current.item), 1, ...current.item.children!); })}><IconFolderMinus aria-hidden="true" size={15} /></button>}</div>
      </div>;
    })}</div>
    {status && <p className="settingsStatus" role="status">{status}</p>}{error && <p className="settingsError" role="alert">{error}</p>}
  </section>;
}
