import { Component, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { Handle, NodeResizer, NodeToolbar, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { IconActivity, IconAdjustmentsHorizontal, IconAlertTriangle, IconBox, IconBoxMultiple, IconClipboard, IconCopy, IconDots, IconFileText, IconInfoCircle, IconLoader2, IconMovie, IconMusic, IconPhoto, IconPuzzle, IconTrash, IconVideo, IconX } from "@tabler/icons-react";
import type { NodeEditorViewAdapter, NodeEditorViewState, WorkbenchController, WorkbenchNode, WorkbenchPlugin } from "./types";
import { trapOverlayFocus } from "./overlayFocus";
import { MotionLayer } from "./uiMotion";

export type CanvasNodeData = {
  documentNode: WorkbenchNode;
  controller: WorkbenchController;
  reportError: (error: unknown) => void;
  finishNodeResize: (nodeId: string) => void;
  sized: boolean;
  interactionsEnabled: boolean;
  showEdges: boolean;
  activeHandles: string[];
};

export type CanvasNode = Node<CanvasNodeData, "workbenchNode">;
export const nodeIcons: Record<string, typeof IconPuzzle> = { text: IconFileText, image: IconPhoto, video: IconVideo, audio: IconMusic, spatial: IconBox, motion: IconActivity, info: IconInfoCircle, frames: IconMovie };

class NodeViewBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : "节点视图加载失败" };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="nodeUnavailable" role="alert"><IconAlertTriangle aria-hidden="true" focusable="false" size={20} /><span>{this.state.error}</span><button type="button" onClick={() => this.setState({ error: null })}>重新加载视图</button></div>;
  }
}

function PluginUnavailable({ pluginId, plugin, error, locked, onEnable }: { pluginId: string; plugin?: WorkbenchPlugin; error?: string; locked: boolean; onEnable(): void }) {
  const openPlugins = () => window.dispatchEvent(new CustomEvent("openCinema:open-settings", { detail: { tab: "plugins", pluginId } }));
  const notice = error ? { message: error, action: "查看插件设置", run: openPlugins }
    : !plugin ? { message: `缺少插件 ${pluginId}`, action: "在插件市场查找", run: openPlugins }
    : plugin.supported === false ? { message: `插件「${plugin.label}」已停用`, action: "启用插件", run: onEnable }
    : { message: "节点插件尚未就绪，请在插件设置中检查安装与启用状态", action: "查看插件设置", run: openPlugins };
  return <div className="nodeUnavailable" role="status"><IconPuzzle aria-hidden="true" focusable="false" size={22} /><span>{notice.message}</span><button type="button" className="nodrag" disabled={locked && notice.run === onEnable} onClick={notice.run}>{notice.action}</button></div>;
}

export default function NodeView({ id, data, selected, isConnectable }: NodeProps<CanvasNode>) {
  const { documentNode: node, controller, reportError } = data;
  const snapshot = controller.getSnapshot();
  const locked = snapshot.readOnly || snapshot.transitioning;
  const interactionLocked = locked || !data.interactionsEnabled;
  const group = node.type === "group" || node.type === "canvasGroup";
  const pluginId = node.type?.replace(/^remote-/, "") ?? "";
  // 节点数据不随插件目录变化，这里单独订阅，安装或启用后才会刷新。
  const plugin = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().plugins).find(item => item.type.replace(/^remote-/, "") === pluginId);
  const NodeIcon = nodeIcons[plugin?.icon ?? ""] ?? IconPuzzle;
  const PluginView = controller.getNodeView?.(node.type ?? "");
  const pluginError = controller.getNodeError?.(id);
  const handles = Array.isArray(node.data?.handles) ? node.data.handles : [];
  const updateNodeInternals = useUpdateNodeInternals();
  const handleSignature = handles.map(handle => `${handle.type}:${handle.id}`).join("|");
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [inlineHeight, setInlineHeight] = useState<number>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contentMount] = useState(() => { const element = document.createElement("div"); element.className = "nodeContentMount"; return element; });
  const [toolbarMount] = useState(() => { const element = document.createElement("div"); element.className = "nodePluginActions"; return element; });
  const inlineBody = useRef<HTMLDivElement>(null), expandedBody = useRef<HTMLDivElement>(null);
  const inlineToolbar = useRef<HTMLDivElement>(null), expandedToolbar = useRef<HTMLDivElement>(null);
  const actionMenu = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const cancelRenameRef = useRef(false);
  const editorState = useRef<NodeEditorViewState>({ nodeId: id, open: false, phase: "inline", viewRevision: 0, ready: false, available: false });
  editorState.current.available = !!PluginView && !group;
  const pendingEditorChanges = useRef(new Set<{ revision: number; resolve(value: NodeEditorViewState): void; reject(error: unknown): void }>());
  const editorAdapter = useRef<NodeEditorViewAdapter | undefined>(undefined);

  function readEditorView(): NodeEditorViewState {
    const state = editorState.current;
    const destination = state.phase === "open" ? expandedBody.current : state.phase === "inline" ? inlineBody.current : null;
    return { ...state, ready: !!destination?.isConnected && contentMount.parentElement === destination };
  }
  function settleEditorChanges() {
    const state = readEditorView();
    for (const pending of pendingEditorChanges.current) {
      if (pending.revision !== state.viewRevision) {
        pendingEditorChanges.current.delete(pending);
        pending.reject(Object.assign(new Error("节点编辑器视图已被更新，请重新读取"), { code: "nodeEditorViewChanged", actualRevision: state.viewRevision }));
      } else if (state.ready) { pendingEditorChanges.current.delete(pending); pending.resolve(state); }
    }
  }
  async function changeEditor(open: boolean, expectedViewRevision?: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const state = editorState.current;
    if (expectedViewRevision !== undefined && expectedViewRevision !== state.viewRevision) throw Object.assign(new Error("节点编辑器视图已变化，请重新读取"), { code: "nodeEditorViewRevisionConflict", actualRevision: state.viewRevision });
    if (open && !state.available) throw Object.assign(new Error("此节点没有可展开的插件编辑器"), { code: "nodeEditorUnavailable" });
    if (controller.getSnapshot().transitioning) throw Object.assign(new Error("工作区正在切换，请重新读取节点视图"), { code: "nodeEditorUnavailable" });
    if (state.open !== open) {
      editorState.current = { ...state, open, phase: open ? "opening" : "closing", ready: false, viewRevision: state.viewRevision + 1 };
      if (open) {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setInlineHeight(inlineBody.current?.offsetHeight); setClosing(false); setExpanded(true);
      } else setClosing(true);
      settleEditorChanges();
    }
    const current = readEditorView();
    if (current.ready) return current;
    return new Promise<NodeEditorViewState>((resolve, reject) => {
      const pending = { revision: current.viewRevision, resolve, reject };
      const abort = () => { pendingEditorChanges.current.delete(pending); reject(signal?.reason ?? new DOMException("操作已取消", "AbortError")); };
      pending.resolve = value => { signal?.removeEventListener("abort", abort); resolve(value); };
      pending.reject = error => { signal?.removeEventListener("abort", abort); reject(error); };
      pendingEditorChanges.current.add(pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else settleEditorChanges();
    });
  }
  editorAdapter.current = { read: readEditorView, set: (input, signal) => changeEditor(input.open, input.expectedViewRevision, signal) };

  useEffect(() => updateNodeInternals(id), [id, handleSignature, updateNodeInternals]);
  useEffect(() => {
    const detach = controller.attachNodeEditorView(id, { read: () => editorAdapter.current!.read(), set: (input, signal) => editorAdapter.current!.set(input, signal) });
    return () => {
      detach();
      for (const pending of pendingEditorChanges.current) pending.reject(Object.assign(new Error("节点编辑器已卸载，请重新读取当前画布"), { code: "nodeEditorUnavailable" }));
      pendingEditorChanges.current.clear();
    };
  }, [controller, id]);
  useLayoutEffect(() => {
    const destination = expanded ? expandedBody.current : inlineBody.current;
    if (destination && contentMount.parentElement !== destination) destination.appendChild(contentMount);
    if (!expanded && returnFocus.current?.isConnected) { returnFocus.current.focus(); returnFocus.current = null; }
    if (!expanded && !editorState.current.open) editorState.current.phase = "inline";
    settleEditorChanges();
  }, [expanded, closing, contentMount]);
  useLayoutEffect(() => {
    const destination = expanded ? expandedToolbar.current : inlineToolbar.current;
    if (destination && toolbarMount.parentElement !== destination) destination.appendChild(toolbarMount);
  }, [expanded, selected, snapshot.selectedIds.length, interactionLocked, toolbarMount]);
  useEffect(() => () => { contentMount.remove(); toolbarMount.remove(); }, [contentMount, toolbarMount]);
  useEffect(() => { if (!selected || expanded || interactionLocked) setMenuOpen(false); }, [selected, expanded, interactionLocked]);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof globalThis.Node && !actionMenu.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener("pointerdown", dismiss, true);
    actionMenu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [menuOpen]);
  useEffect(() => {
    const layer = expandedBody.current?.closest<HTMLElement>(".expandedNode");
    if (!expanded || !layer) return;
    layer.addEventListener("keydown", trapOverlayFocus, true);
    return () => layer.removeEventListener("keydown", trapOverlayFocus, true);
  }, [expanded]);
  useEffect(() => controller.attachComposer(() => {
    if (!expanded) return;
    returnFocus.current = null;
    void changeEditor(false).catch(reportError);
  }), [controller, expanded]);
  function expand() {
    void changeEditor(true).catch(reportError);
  }

  function runAction(name: string, args: Record<string, unknown>) {
    if (controller.getSnapshot().readOnly || controller.getSnapshot().transitioning) return Promise.resolve();
    return Promise.resolve().then(() => controller.execute(name, args)).catch(reportError);
  }

  function startRename() {
    if (!interactionLocked) { setLabel(node.data?.label || plugin?.label || ""); setRenaming(true); }
  }

  function finishRename() {
    setRenaming(false);
    if (!cancelRenameRef.current && !interactionLocked && label.trim() && label.trim() !== node.data?.label) runAction("renameNode", { id, label: label.trim() });
    cancelRenameRef.current = false;
  }

  const content = <NodeViewBoundary key={`${id}:${node.type}:${pluginError ?? ""}`}>
    {PluginView && pluginError && <p className="nodePluginError" role="alert">节点插件更新失败，当前保留原版本。{pluginError}</p>}
    {PluginView ? <Suspense fallback={<div className="nodeLoading" role="status"><IconLoader2 aria-hidden="true" focusable="false" className="spin" size={18} /><span>加载节点视图</span></div>}><PluginView node={node} controller={controller} readOnly={locked} toolbarMount={toolbarMount} /></Suspense> : !group && (snapshot.transitioning && !pluginError ? <div className="nodeLoading" role="status"><IconLoader2 aria-hidden="true" focusable="false" className="spin" size={18} /><span>读取节点</span></div> : <PluginUnavailable pluginId={pluginId} plugin={plugin} error={pluginError ?? controller.getPluginError(pluginId)} locked={locked} onEnable={() => void controller.setPluginEnabled(pluginId, true).catch(reportError)} />)}
  </NodeViewBoundary>;

  return <article className={`nodeFrame${selected ? " nodeFrameSelected" : ""}${group ? " groupFrame" : data.sized ? " nodeFrameSized" : ""}`} aria-label={node.data?.label || plugin?.label || node.type || "节点"}>
    <NodeResizer isVisible={selected && !interactionLocked && node.resizable !== false} minWidth={220} minHeight={120} shouldResize={() => !controller.getSnapshot().readOnly && !controller.getSnapshot().transitioning && data.interactionsEnabled && node.resizable !== false} onResizeEnd={(_event, size) => { void runAction("resizeNode", { id, width: size.width, height: size.height, position: { x: size.x, y: size.y } }).finally(() => data.finishNodeResize(id)); }} />
    <NodeToolbar isVisible={selected && !group && snapshot.selectedIds.length === 1 && !interactionLocked} position={Position.Top} offset={14}>
      <div className="nodeActionBar nodrag nopan">
        <div ref={inlineToolbar} className="nodeActionSlot" />
        {PluginView && <button type="button" className="nodeEditorAction" onClick={expand} aria-label="展开节点编辑器" title="展开编辑器与参数"><IconAdjustmentsHorizontal aria-hidden="true" focusable="false" size={16} /></button>}
        <div className="nodeActionMenu" ref={actionMenu} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); menuButton.current?.focus(); }
          if (!menuOpen || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
          const index = items.findIndex(item => item === event.target);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? items.length - 1 : 1)) % items.length;
          event.preventDefault(); event.stopPropagation(); items[next]?.focus();
        }}>
          <button ref={menuButton} type="button" aria-label="更多节点操作" title="更多节点操作" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><IconDots aria-hidden="true" focusable="false" size={16} /></button>
          {menuOpen && <div className="nodeActionMenuItems" role="menu" aria-label="更多节点操作" onClick={() => { setMenuOpen(false); menuButton.current?.focus(); }}>
            <button type="button" role="menuitem" onClick={() => runAction("duplicateNodes", { nodeIds: [id], withEdges: false })}><IconCopy aria-hidden="true" focusable="false" size={16} />复制节点</button>
            <button type="button" role="menuitem" onClick={() => runAction("duplicateNodes", { nodeIds: [id], withEdges: true })}><IconBoxMultiple aria-hidden="true" focusable="false" size={16} />创建含连线副本</button>
            <button type="button" role="menuitem" onClick={() => runAction("copyNodes", { nodeIds: [id], preferImage: true })}><IconClipboard aria-hidden="true" focusable="false" size={16} />复制到剪贴板</button>
            <button type="button" role="menuitem" disabled={node.deletable === false} onClick={() => runAction("removeElements", { nodeIds: [id], edgeIds: [] })} data-tone="danger"><IconTrash aria-hidden="true" focusable="false" size={16} />删除节点</button>
          </div>}
        </div>
      </div>
    </NodeToolbar>
    <header className="nodeHeader">
      <span className="nodeTypeMark"><NodeIcon aria-hidden="true" focusable="false" size={14} /></span>
      {renaming ? <input className="nodeTitleInput nodrag" value={label} onChange={event => setLabel(event.target.value)} onBlur={finishRename} autoFocus disabled={interactionLocked} aria-label="节点名称" onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); cancelRenameRef.current = true; event.currentTarget.blur(); }
      }} /> : <span className="nodeTitle" role={interactionLocked ? undefined : "button"} tabIndex={interactionLocked ? undefined : 0} aria-label={interactionLocked ? undefined : `重命名${node.data?.label || plugin?.label || "节点"}`} title={interactionLocked ? undefined : "双击或按 Enter 修改节点名称"} onDoubleClick={event => { event.stopPropagation(); startRename(); }} onKeyDown={event => { if (!event.nativeEvent.isComposing && (event.key === "Enter" || event.key === "F2")) { event.preventDefault(); event.stopPropagation(); startRename(); } }}>{node.data?.label || plugin?.label || node.type || "节点"}</span>}
      {plugin?.category && <span className="nodeCategory">{plugin.category}</span>}
    </header>
    <div className="nodeBody" ref={inlineBody} style={expanded && inlineHeight ? { minHeight: inlineHeight } : undefined} />
    {createPortal(content, contentMount)}
    {createPortal(<AnimatePresence onExitComplete={() => { if (!editorState.current.open) { setExpanded(false); setClosing(false); } }}>{expanded && !closing && <MotionLayer key="expandedNode" kind="backdrop" className="expandedNodeBackdrop"><MotionLayer className="expandedNode" role="dialog" aria-modal="true" aria-label={`${node.data?.label ?? "节点"}编辑器`} onAnimationComplete={() => { if (editorState.current.open && expandedBody.current?.isConnected) { editorState.current.phase = "open"; settleEditorChanges(); } }} onKeyDownCapture={trapOverlayFocus} onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); void changeEditor(false).catch(reportError); } }}><header><strong>{node.data?.label || plugin?.label}</strong><button type="button" autoFocus onClick={() => void changeEditor(false).catch(reportError)} aria-label="关闭展开编辑器"><IconX aria-hidden="true" focusable="false" size={20} /></button></header><div className="expandedNodeTools" ref={expandedToolbar} /><div className="expandedNodeBody" ref={expandedBody} /></MotionLayer></MotionLayer>}</AnimatePresence>, document.querySelector(".openCinemaWorkbench") ?? document.body)}
    {(["target", "source"] as const).flatMap(type => {
      const ports = handles.filter(handle => handle.type === type);
      return ports.map((handle, index) => <Handle
        key={`${type}:${handle.id}`}
        id={handle.id}
        type={type}
        isConnectable={!interactionLocked && isConnectable}
        isConnectableStart={!interactionLocked && isConnectable}
        isConnectableEnd={!interactionLocked && isConnectable}
        position={type === "target" ? Position.Left : Position.Right}
        style={{ top: `${((index + 1) / (ports.length + 1)) * 100}%`, visibility: !data.showEdges && !data.activeHandles.includes(`${type}:${handle.id}`) ? "hidden" : undefined }}
        title={handle.label || handle.id}
        aria-label={handle.label || handle.id}
      />);
    })}
  </article>;
}
