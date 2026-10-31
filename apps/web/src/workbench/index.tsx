import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, useReducedMotion } from "motion/react";
import type { CSSProperties, DragEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Background, BackgroundVariant, getBezierPath, MiniMap, Position, ReactFlow, ReactFlowProvider, SelectionMode, useKeyPress, useReactFlow } from "@xyflow/react";
import { nodeClipboardCommand } from "@/lib/nodeClipboard";
import { findOpenPosition, getCanvasAlignment, type CanvasAlignmentGuide } from "@/lib/canvasAlignment";
import { readClipboardFiles, readClipboardText } from "@/lib/clipboard";
import { canvasShortcutFields, defaultCanvasShortcuts, getShortcutBindings, isShortcutAllowed, normalizeShortcut, shortcutMatches, shortcutPressed, type CanvasShortcuts } from "@/lib/canvasShortcuts";
import { getComposerState } from "@toonflow/nodes-scaffold/pluginRuntime";
import type { Connection, Edge, EdgeChange, NodeChange, Viewport } from "@xyflow/react";
import {
  IconArrowUp, IconArrowBackUp, IconArrowForwardUp, IconAt, IconCheck, IconChevronDown,
  IconCircleFilled, IconCopy, IconDeviceFloppy, IconDownload, IconFileText, IconFocusCentered, IconFolderOpen, IconFolderPlus,
  IconGridDots, IconHandStop, IconHistory, IconLayoutGrid, IconLoader2, IconLock,
  IconPointer, IconPlus, IconPuzzle, IconSearch, IconSettings, IconSitemap, IconTrash, IconUpload,
  IconX, IconZoomIn, IconZoomOut, IconSparkles,
  IconUsers, IconPencil, IconBoxMultiple, IconDeselect, IconClipboard, IconLink, IconLinkOff, IconMap, IconCircleDashed,
} from "@tabler/icons-react";
import NodeView, { nodeIcons } from "./nodeView";
import HeaderIcon from "./headerIcon";
import { menuKeyDown, trapOverlayFocus } from "./overlayFocus";
import { MotionLayer, WorkbenchMotion } from "./uiMotion";
import SettingsPanel, { type SettingsTab } from "./settingsPanel";
import CanvasManager from "./canvasManager";
import ProjectPicker from "./projectPicker";
import { createWorkspaceFiles } from "@/lib/workspaceFileClient";
import AssetLibrary from "./assetLibrary";
import WorkbenchTooltip from "./workbenchTooltip";
import { assetDragType, assetLibraryClient } from "@/lib/assetLibraryClient";
import { filterNodeMenu, normalizeNodeMenu, resolveNodeMenu, type NodeMenuItem } from "@/lib/nodeMenu";
import { workbenchSettingsClient } from "@/lib/workbenchSettingsClient";
import { findMissingProjects, forgetRecentProject, readRecentProjects } from "@/lib/recentProjects";
import type { CanvasNode } from "./nodeView";
import type { CanvasViewOptions, WorkbenchController, WorkbenchNode, WorkbenchPosition } from "./types";
import "@xyflow/react/dist/style.css";
import "./styles.scss";

const nodeTypes = { workbenchNode: NodeView };
// 适应视图时避开顶栏、右侧工具栏和底部输入框。
const fitPadding = { top: "80px", right: "88px", bottom: "128px", left: "40px" } as const;
const starterFlow = [["textNode", "text"], ["imageGenerationNode", "image"], ["videoGenerationNode", "video"]] as const;
function flowShortcutKeys(binding: string) { const keys = getShortcutBindings(binding).filter(value => value !== "None").map(value => value.replace(/\bCtrl\b/g, "Control")); return keys.length ? keys : null; }

function composerDraftKey(directory: string | null, canvasId: string | null, action: { nodeId: string; tool: string } | null, nodeIds: readonly string[]) {
  return JSON.stringify([directory, canvasId, action ? [action.nodeId, action.tool] : [...nodeIds].sort()]);
}

function isEditing(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], dialog, [role='dialog'], [aria-modal='true'], [role='menu']");
}

function orderNodes(nodes: WorkbenchNode[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const depths = new Map<string, number>();
  function depth(node: WorkbenchNode) {
    const path: WorkbenchNode[] = [];
    let current: WorkbenchNode | undefined = node;
    while (current && !depths.has(current.id)) { path.push(current); current = byId.get(current.parentId ?? current.parentNode ?? ""); }
    let value = current ? depths.get(current.id)! + 1 : 0;
    for (const item of path.reverse()) depths.set(item.id, value++);
    return depths.get(node.id)!;
  }
  return [...nodes].sort((left, right) => depth(left) - depth(right));
}


function WorkbenchWorkspace({ controller }: { controller: WorkbenchController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const flow = useReactFlow<CanvasNode>();
  const reducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const selectionToolbarRef = useRef<HTMLDivElement>(null);
  const [selectionToolbarWidth, setSelectionToolbarWidth] = useState(380);
  const dragCommitRef = useRef<Map<string, CanvasNode>>(undefined);
  const alignmentDragRef = useRef<string[]>([]);
  const alignedPositionsRef = useRef<Record<string, WorkbenchPosition>>({});
  const [alignmentGuides, setAlignmentGuides] = useState<CanvasAlignmentGuide[]>([]);
  const copyDragRef = useRef<{ ids: string[]; origin: Record<string, WorkbenchPosition>; withEdges: boolean; pending: boolean } | undefined>(undefined);
  const [openPanel, setOpenPanel] = useState<"project" | "settings" | "history" | "collaboration" | "canvas" | null>(null);
  const [managementPanel, setManagementPanel] = useState<"canvas" | "assets" | null>(null);
  const [batchConnectionOpen, setBatchConnectionOpen] = useState(false);
  const [batchTarget, setBatchTarget] = useState("");
  const [canvasAction, setCanvasAction] = useState<"add" | "rename">("add");
  const [canvasRenameTarget, setCanvasRenameTarget] = useState<{ directory: string; canvasId: string; fileRevision: string }>();
  const [canvasName, setCanvasName] = useState("");
  const [projectPicker, setProjectPicker] = useState({ creating: false, directory: "" });
  const [recentProjects, setRecentProjects] = useState(readRecentProjects);
  const [missingProjects, setMissingProjects] = useState<ReadonlySet<string>>(new Set());
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("host");
  const [palette, setPalette] = useState<"add" | "search" | null>(null);
  const [pickingTargets, setPickingTargets] = useState(false);
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [palettePosition, setPalettePosition] = useState<WorkbenchPosition | null>(null);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [previewPositions, setPreviewPositions] = useState<Record<string, WorkbenchPosition>>({});
  const [previewDimensions, setPreviewDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [measuredDimensions, setMeasuredDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [composerAction, setComposerAction] = useState<{ nodeId: string; tool: string; label: string; placeholder: string; maxLength?: number } | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const promptKey = composerDraftKey(snapshot.directory, snapshot.canvasId, composerAction, snapshot.selectedIds);
  const activePromptKey = useRef(promptKey);
  activePromptKey.current = promptKey;
  const prompt = promptDrafts[promptKey] ?? "";
  function setPrompt(value: string | ((previous: string) => string)) {
    setPromptDrafts(previous => ({ ...previous, [promptKey]: typeof value === "function" ? value(previous[promptKey] ?? "") : value }));
  }
  const [sending, setSending] = useState(false);
  const sendingPromptKey = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptStatus, setPromptStatus] = useState("");
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    function resizeInput() {
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    }
    resizeInput();
    window.addEventListener("resize", resizeInput);
    return () => window.removeEventListener("resize", resizeInput);
  }, [prompt, promptKey]);
  const [zoom, setZoom] = useState(1);
  const [zoomInput, setZoomInput] = useState<string | null>(null);
  const cancelZoomRef = useRef(false);
  const [viewTransform, setViewTransform] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [connectionEndpoint, setConnectionEndpoint] = useState<{ nodeId: string; handleId: string; direction: "source" | "target" } | null>(null);
  const [connectionSelection, setConnectionSelection] = useState<string[] | null>(null);
  const selectionDragRef = useRef<{ nodeIds: string[]; directory: string | null; canvasId: string | null; revision: number | string } | null>(null);
  const [selectionPointer, setSelectionPointer] = useState<{ x: number; y: number; targetId?: string; targetHandle?: string } | null>(null);
  const [compatibleTypes, setCompatibleTypes] = useState<string[] | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; position: WorkbenchPosition } | null>(null);
  const mediaImportRef = useRef<HTMLInputElement>(null);
  const mediaImportTarget = useRef<{ directory: string | null; canvasId: string | null; position: WorkbenchPosition } | undefined>(undefined);
  const [shortcuts, setShortcuts] = useState<CanvasShortcuts>(defaultCanvasShortcuts);
  const shortcutKeys = useMemo(() => ({ pan: flowShortcutKeys(shortcuts.pan), zoom: flowShortcutKeys(shortcuts.zoom), selection: flowShortcutKeys(shortcuts.selection), multiSelection: flowShortcutKeys(shortcuts.multiSelection) }), [shortcuts]);
  const panKeyPressed = useKeyPress(shortcutKeys.pan, { actInsideInputWithModifier: false });
  const [localView, setLocalView] = useState<CanvasViewOptions>({ miniMap: false, snapEnabled: false, showEdges: true, highlight: "both" });
  const viewRef = useRef(localView);
  const canvasView = snapshot.canvasView ?? localView;
  viewRef.current = canvasView;
  const { snapEnabled, showEdges } = canvasView;
  const [edgeAppearance, setEdgeAppearance] = useState({ animated: true, colorMode: "theme", color: "#2dd4bf" });
  const [savedNodeMenu, setSavedNodeMenu] = useState<NodeMenuItem[]>([]);
  const panMode = tool === "pan" || panKeyPressed;
  const editingLocked = snapshot.readOnly || snapshot.transitioning;

  const reportError = useCallback((value: unknown) => {
    setError(value instanceof Error ? value.message : String(value));
  }, []);

  const runCommand = useCallback((name: string, args: Record<string, unknown>) => {
    const current = controller.getSnapshot();
    if (current.readOnly || current.transitioning) return;
    setError(null);
    Promise.resolve().then(() => controller.execute(name, args)).catch(reportError);
  }, [controller, reportError]);

  const finishNodeResize = useCallback((id: string) => {
    const ids = new Set([id, ...(controller.getSnapshot().document?.nodes ?? []).filter(node => (node.parentId ?? node.parentNode) === id).map(node => node.id)]);
    setPreviewPositions(previous => Object.fromEntries(Object.entries(previous).filter(([nodeId]) => !ids.has(nodeId))));
    setPreviewDimensions(previous => Object.fromEntries(Object.entries(previous).filter(([nodeId]) => !ids.has(nodeId))));
  }, [controller]);

  const activeHandles = useMemo(() => {
    const active = new Set([...snapshot.selectedIds, ...Object.keys(previewPositions)]), handles = new Map<string, Set<string>>();
    for (const edge of snapshot.document?.edges ?? []) {
      if (!active.has(edge.source) && !active.has(edge.target)) continue;
      for (const [id, type, port] of [[edge.source, "source", edge.sourceHandle], [edge.target, "target", edge.targetHandle]] as const) {
        if (!port) continue;
        const keys = handles.get(id) ?? new Set<string>(); keys.add(`${type}:${port}`); handles.set(id, keys);
      }
    }
    return handles;
  }, [snapshot.document?.edges, snapshot.selectedIds, previewPositions]);

  const nodes = useMemo<CanvasNode[]>(() => orderNodes(snapshot.document?.nodes ?? []).map(node => {
    const style = node.style && typeof node.style === "object" && !Array.isArray(node.style) ? node.style as CSSProperties : {};
    const width = previewDimensions[node.id]?.width ?? (typeof node.width === "number" && node.width > 0 ? node.width : undefined);
    const height = previewDimensions[node.id]?.height ?? (typeof node.height === "number" && node.height > 0 ? node.height : undefined);
    return {
      ...(node as unknown as CanvasNode),
      id: node.id,
      type: "workbenchNode",
      position: previewPositions[node.id] ?? node.position,
      parentId: node.parentId ?? node.parentNode,
      selected: snapshot.selectedIds.includes(node.id),
      hidden: node.hidden === true,
      data: { documentNode: node, controller, reportError, finishNodeResize, sized: height !== undefined || style.height !== undefined, interactionsEnabled: tool === "select", showEdges, activeHandles: [...activeHandles.get(node.id) ?? []] },
      width,
      height,
      measured: measuredDimensions[node.id],
      style: { ...style, width: width ?? style.width ?? 360, ...(height === undefined ? {} : { height }) },
      draggable: tool === "select" && !editingLocked && node.draggable !== false,
      connectable: tool === "select" && !editingLocked && node.connectable !== false,
      deletable: !editingLocked && node.deletable !== false,
      selectable: tool === "select" && !snapshot.transitioning && node.selectable !== false,
      dragHandle: ".nodeHeader",
    };
  }), [snapshot.document, snapshot.selectedIds, snapshot.transitioning, editingLocked, tool, controller, previewPositions, previewDimensions, measuredDimensions, reportError, finishNodeResize, showEdges, activeHandles]);

  const edges = useMemo<Edge[]>(() => {
    const hiddenNodes = new Set((snapshot.document?.nodes ?? []).filter(node => node.hidden === true).map(node => node.id));
    const active = new Set([...snapshot.selectedIds, ...Object.keys(previewPositions)]);
    return (snapshot.document?.edges ?? []).map(edge => {
      const related = active.has(edge.source) || active.has(edge.target);
      const highlighted = (canvasView.highlight === "both" && related) || (canvasView.highlight === "upstream" && active.has(edge.target)) || (canvasView.highlight === "downstream" && active.has(edge.source));
      return {
      ...(edge as Edge),
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      hidden: (!showEdges && !related) || edge.hidden === true || hiddenNodes.has(edge.source) || hiddenNodes.has(edge.target),
      className: `${typeof edge.className === "string" ? edge.className : ""}${highlighted ? " edgeRelated" : ""}`,
      animated: highlighted && edgeAppearance.animated && !reducedMotion,
      style: { ...(edge.style && typeof edge.style === "object" && !Array.isArray(edge.style) ? edge.style : {}), ...(highlighted && edgeAppearance.colorMode !== "none" ? { stroke: edgeAppearance.colorMode === "custom" ? edgeAppearance.color : "var(--selectionAccent)" } : {}) },
      selected: selectedEdgeIds.includes(edge.id),
      selectable: tool === "select" && !snapshot.transitioning && edge.selectable !== false,
      deletable: !editingLocked && edge.deletable !== false,
      reconnectable: false,
      type: typeof edge.type === "string" && ["default", "straight", "step", "smoothstep", "simplebezier"].includes(edge.type) ? edge.type : "default",
    }; });
  }, [snapshot.document, snapshot.selectedIds, snapshot.transitioning, selectedEdgeIds, tool, editingLocked, showEdges, canvasView.highlight, edgeAppearance, previewPositions, reducedMotion]);

  const selectionBounds = snapshot.selectedIds.length ? flow.getNodesBounds(snapshot.selectedIds) : undefined;
  const selectionAnchor = selectionBounds ? { x: viewTransform.x + (selectionBounds.x + selectionBounds.width + 18) * viewTransform.zoom, y: viewTransform.y + (selectionBounds.y + selectionBounds.height / 2) * viewTransform.zoom } : undefined;
  const selectionPath = selectionAnchor && selectionPointer ? getBezierPath({ sourceX: selectionAnchor.x, sourceY: selectionAnchor.y, sourcePosition: Position.Right, targetX: selectionPointer.x, targetY: selectionPointer.y, targetPosition: Position.Left })[0] : undefined;

  const paletteItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (palette === "search") return (snapshot.document?.nodes ?? []).filter(node => node.hidden !== true && node.selectable !== false).map(node => ({
      id: node.id,
      label: node.data?.label || snapshot.plugins.find(plugin => plugin.type === node.type)?.label || node.type || node.id,
      description: snapshot.plugins.find(plugin => plugin.type.replace(/^remote-/, "") === node.type?.replace(/^remote-/, ""))?.label ?? "节点",
      icon: snapshot.plugins.find(plugin => plugin.type === node.type)?.icon,
      category: "当前画布",
      supported: true,
    })).filter(item => `${item.label} ${item.description} ${item.id}`.toLowerCase().includes(search));
    const plugins = new Map(snapshot.plugins.map(plugin => [plugin.type, plugin]));
    const items = filterNodeMenu(resolveNodeMenu(savedNodeMenu, snapshot.plugins), new Set(snapshot.plugins.filter(plugin => !compatibleTypes || compatibleTypes.includes(plugin.type)).map(plugin => plugin.type)));
    const entries: { id: string; label: string; description: string; icon?: string; category: string; supported: boolean }[] = [];
    function visit(items: NodeMenuItem[], path: string[]) {
      for (const item of items) {
        const plugin = item.type && plugins.get(item.type);
        if (plugin) entries.push({ id: plugin.type, label: item.label, description: plugin.description ?? "", icon: plugin.icon, category: path.join(" / ") || plugin.category || "节点插件", supported: plugin.supported !== false });
        else if (item.children) visit(item.children, [...path, item.label]);
      }
    }
    visit(items, []);
    return entries.filter(item => `${item.label} ${item.description} ${item.category} ${item.id}`.toLowerCase().includes(search));
  }, [palette, query, snapshot.document, snapshot.plugins, compatibleTypes, savedNodeMenu]);

  const activeCanvasName = snapshot.canvasFiles.find(file => file.path === snapshot.canvasId)?.name
    ?? snapshot.canvasId?.split("/").pop()?.replace(/\.json$/i, "") ?? "选择画布";
  const saveLabel = snapshot.transitioning ? "切换中" : snapshot.readOnly ? "只读" : snapshot.saving ? "保存中" : snapshot.error ? "保存失败" : snapshot.dirty ? "待保存" : snapshot.document ? "已保存" : "未打开工程";
  const collaboration = controller.getWorkspacePlugin("collaborationExtension");
  const CollaborationPanel = collaboration?.view;
  const history = openPanel === "history" && snapshot.document ? controller.getHistory() : undefined;
  const selectedGroups = (snapshot.document?.nodes ?? []).filter(node => snapshot.selectedIds.includes(node.id) && ["group", "canvasGroup"].includes(node.type ?? "")).map(node => node.id);
  const selectionToolbarVisible = (snapshot.selectedIds.length > 1 || selectedGroups.length > 0) && !editingLocked && tool === "select" && !palette && !openPanel && !managementPanel && !batchConnectionOpen;
  const selectionToolbarPosition = selectionBounds ? {
    left: Math.max(16, Math.min(viewTransform.x + (selectionBounds.x + selectionBounds.width / 2) * viewTransform.zoom - selectionToolbarWidth / 2, (rootRef.current?.clientWidth ?? innerWidth) - selectionToolbarWidth - 16)),
    top: Math.max(72, Math.min(viewTransform.y + selectionBounds.y * viewTransform.zoom - 52, (rootRef.current?.clientHeight ?? innerHeight) - 240)),
  } : undefined;
  const composerTargets = (snapshot.document?.nodes ?? []).filter(node => snapshot.selectedIds.includes(node.id));
  const selectedComposer = composerTargets.length === 1 ? snapshot.plugins.find(plugin => plugin.type.replace(/^remote-/, "") === composerTargets[0].type?.replace(/^remote-/, ""))?.composer : undefined;
  const composerReferences = (snapshot.document?.edges ?? []).filter(edge => snapshot.selectedIds.includes(edge.target)).length;
  const composerState = composerAction ? getComposerState(selectedComposer, composerTargets[0]?.data ?? {}) : { requiresHost: true };
  const composerNeedsHost = !!composerState.requiresHost && !snapshot.host.canSend;
  const composerDisabledReason = snapshot.readOnly ? "当前为只读协作，无法提交修改" : snapshot.transitioning ? "画布切换中" : composerTargets.length > 20 ? "每次最多操作 20 个节点" : composerState.disabledReason || (composerNeedsHost ? composerAction ? "连接 Agent，或点节点上方的参数按钮选一个已配置的模型；创作要求会保留" : "连接 Agent 后即可发送，创作要求会保留" : "");
  const composerBlocked = !sending && !promptStatus && !!composerDisabledReason && !!prompt.trim();
  const canSendPrompt = !!snapshot.document && !composerDisabledReason;

  useLayoutEffect(() => {
    const toolbar = selectionToolbarRef.current;
    if (!toolbar) return;
    const measure = () => setSelectionToolbarWidth(toolbar.offsetWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar); measure();
    return () => observer.disconnect();
  }, [selectionToolbarVisible]);

  useEffect(() => controller.attachComposer(request => {
    const current = controller.getSnapshot();
    const node = current.document?.nodes.find(node => node.id === request.nodeId);
    const composer = current.plugins.find(plugin => plugin.type.replace(/^remote-/, "") === node?.type?.replace(/^remote-/, ""))?.composer;
    const action = request.action !== false && composer ? { nodeId: request.nodeId, ...composer } : null;
    const key = composerDraftKey(current.directory, current.canvasId, action, current.selectedIds);
    setComposerAction(action);
    const input = composerRef.current;
    const start = key === activePromptKey.current ? input?.selectionStart : undefined, end = key === activePromptKey.current ? input?.selectionEnd : undefined;
    setPromptDrafts(previous => {
      const draft = previous[key] ?? request.prompt ?? "";
      return { ...previous, [key]: request.insertText ? `${draft.slice(0, start ?? draft.length)}${request.insertText}${draft.slice(end ?? draft.length)}` : draft };
    });
    setPromptStatus(""); setPalette(null); setOpenPanel(null); setManagementPanel(null); setContextMenu(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      if (request.insertText && start !== undefined) composerRef.current?.setSelectionRange(start + request.insertText.length, start + request.insertText.length);
    });
  }), [controller]);

  useEffect(() => {
    const current = controller.getSnapshot();
    const node = current.selectedIds.length === 1 ? current.document?.nodes.find(node => node.id === current.selectedIds[0]) : undefined;
    const composer = current.plugins.find(plugin => plugin.type.replace(/^remote-/, "") === node?.type?.replace(/^remote-/, ""))?.composer;
    setComposerAction(previous => previous && node?.id === previous.nodeId ? previous : node && composer?.defaultAction ? { nodeId: node.id, ...composer } : null);
    setPromptStatus("");
  }, [controller, snapshot.selectedIds.join("|"), snapshot.plugins]);

  useEffect(() => controller.attachCanvasView({
    async fit(ids) { await flow.fitView({ ...(ids ? { nodes: ids.map(id => ({ id })) } : {}), padding: fitPadding, duration: 0 }); return flow.getViewport(); },
    measure(id) { const node = flow.getNode(id); const width = node?.measured?.width, height = node?.measured?.height; return width && height ? { width, height } : undefined; },
    getOptions() { return viewRef.current; },
    setOptions(options) { const next = { ...viewRef.current, ...options }; viewRef.current = next; setLocalView(next); },
  }), [controller, flow]);

  useEffect(() => {
    const viewport = snapshot.document?.viewport;
    if (viewport && !snapshot.transitioning) void flow.setViewport(viewport);
  }, [flow, snapshot.document?.viewport, snapshot.transitioning]);

  async function run(operation: () => Promise<unknown> | unknown) {
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (value) {
      reportError(value);
    } finally {
      setPending(false);
    }
  }

  function canvasCenter() {
    const bounds = rootRef.current?.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: bounds ? bounds.x + bounds.width / 2 : innerWidth / 2, y: bounds ? bounds.y + bounds.height / 2 : innerHeight / 2 });
  }

  // 没有明确落点时从视图中心找空位，连续添加、粘贴和导入不会叠在一起。
  function openCanvasPosition() {
    const center = canvasCenter(), size = { width: 360, height: 220 };
    const occupied = flow.getNodes().filter(node => !node.hidden && !node.parentId).map(node => ({ ...node.position, width: node.measured?.width ?? node.width ?? 360, height: node.measured?.height ?? node.height ?? 180 }));
    return findOpenPosition({ x: center.x - size.width / 2, y: center.y - size.height / 2 }, occupied, size);
  }

  async function addStarterFlow() {
    const center = canvasCenter();
    const created: string[] = [];
    for (const [index, [type, handleId]] of starterFlow.entries()) {
      const position = { x: center.x - 580 + index * 420, y: center.y - 110 };
      const previous = created.at(-1);
      if (previous) await controller.addConnectedNode(type, position, { nodeId: previous, handleId: starterFlow[index - 1]![1], direction: "source" }); else await controller.addNode(type, position);
      const nodeId = controller.getSnapshot().selectedIds[0];
      if (!nodeId) throw new Error("示例流程创建中断，请重试");
      created.push(nodeId);
    }
    controller.select([created[0]!]);
    // fitView 只计入已测量的节点，提前调用会把最后一个节点留在视图外。
    for (let attempt = 0; attempt < 40 && !created.every(id => flow.getNode(id)?.measured?.width); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    await moveViewport(() => flow.fitView({ padding: fitPadding, duration: reducedMotion ? 0 : 220 }));
  }

  function showContextMenu(event: { preventDefault(): void; clientX: number; clientY: number }) {
    event.preventDefault();
    setContextMenu({ x: Math.max(16, Math.min(event.clientX, innerWidth - 244)), y: Math.max(16, Math.min(event.clientY, innerHeight - 580)), position: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
  }

  async function pasteContent(files: File[], text: string, position: WorkbenchPosition, target: { directory: string | null; canvasId: string | null }) {
    const current = controller.getSnapshot();
    if (current.directory !== target.directory || current.canvasId !== target.canvasId) throw new Error("读取剪贴板期间画布已切换，请重新粘贴");
    if (files.length) await controller.importMedia(files, position);
    else if (nodeClipboardCommand.test(text)) await controller.execute("pasteNodes", { command: text, position });
    else if (text.trim()) await controller.importMedia([new File([text], "粘贴文本.txt", { type: "text/plain" })], position);
    else throw new Error("剪贴板中没有可粘贴的内容");
    setContextMenu(null);
  }

  async function pasteClipboard(position: WorkbenchPosition) {
    const { directory, canvasId } = controller.getSnapshot();
    const files = typeof navigator.clipboard?.read === "function" ? await readClipboardFiles() : [];
    const text = files.length ? "" : await readClipboardText();
    await pasteContent(files, text, position, { directory, canvasId });
  }

  function showPalette(mode: "add" | "search", position?: WorkbenchPosition, endpoint?: typeof connectionEndpoint, types?: string[], targets = false) {
    if (snapshot.transitioning || (mode === "add" && snapshot.readOnly)) return;
    setPalettePosition(position ?? null);
    setConnectionEndpoint(endpoint ?? null); setCompatibleTypes(types ?? null);
    setConnectionSelection(null);
    selectionDragRef.current = null;
    setContextMenu(null);
    setPalette(mode);
    setPickingTargets(targets);
    setPaletteIndex(0);
    setQuery("");
    setOpenPanel(null);
    setCanvasMenuOpen(false);
  }

  function closePalette() {
    setPalette(null);
    setConnectionSelection(null);
    selectionDragRef.current = null;
    if (pickingTargets) requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function choosePaletteItem(index: number) {
    if (controller.getSnapshot().transitioning) return;
    const item = paletteItems[index];
    if (!item?.supported) return;
    if (palette === "search") {
      if (pickingTargets) {
        const ids = controller.getSnapshot().selectedIds;
        if (ids.includes(item.id)) controller.select(ids.filter(id => id !== item.id));
        else if (ids.length < 20) controller.select([...ids, item.id]);
        return;
      }
      controller.select([item.id]);
      await moveViewport(() => flow.fitView({ nodes: [{ id: item.id }], maxZoom: Math.max(flow.getZoom(), 1), padding: 0.6, duration: reducedMotion ? 0 : 220 }));
    } else {
      if (controller.getSnapshot().readOnly || controller.getSnapshot().transitioning) return;
      if (connectionSelection) {
        const current = controller.getSnapshot(), started = selectionDragRef.current;
        if (!started || current.directory !== started.directory || current.canvasId !== started.canvasId || current.revision !== started.revision) throw new Error("画布已变化，请重新拖动选区连线");
        await controller.execute("addConnectedSelectionNode", { nodeIds: connectionSelection, type: item.id, position: palettePosition ?? openCanvasPosition() });
      }
      else if (connectionEndpoint) await controller.addConnectedNode(item.id, palettePosition ?? openCanvasPosition(), connectionEndpoint);
      else await controller.addNode(item.id, palettePosition ?? openCanvasPosition());
      const current = controller.getSnapshot(), node = current.document?.nodes.find(node => node.id === current.selectedIds[0]);
      if (node && current.plugins.find(plugin => plugin.type.replace(/^remote-/, "") === node.type?.replace(/^remote-/, ""))?.composer?.defaultAction) controller.getNodeService(node.id).focusComposer();
    }
    closePalette();
  }

  function paletteKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setPaletteIndex(index => Math.max(0, Math.min(paletteItems.length - 1, index + direction)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void run(() => choosePaletteItem(paletteIndex));
    }
  }

  function updateNodeChanges(changes: NodeChange<CanvasNode>[]) {
    const dimensions = changes.filter(change => change.type === "dimensions");
    if (dimensions.length) setMeasuredDimensions(previous => {
      let next = previous;
      for (const change of dimensions) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const { width, height } = change.dimensions;
        if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
        if (previous[change.id]?.width === width && previous[change.id]?.height === height) continue;
        if (next === previous) next = { ...previous };
        next[change.id] = { width, height };
      }
      return next;
    });
    if (controller.getSnapshot().transitioning) return;
    const selectionChanges = changes.filter(change => change.type === "select");
    if (selectionChanges.length) {
      const ids = new Set(controller.getSnapshot().selectedIds);
      for (const change of selectionChanges) change.selected ? ids.add(change.id) : ids.delete(change.id);
      controller.select([...ids]);
    }
    if (controller.getSnapshot().readOnly || tool !== "select") return;
    if (dimensions.length) setPreviewDimensions(previous => {
      const next = { ...previous };
      for (const change of dimensions) {
        if (change.type !== "dimensions") continue;
        if (change.resizing === false) delete next[change.id];
        else if (change.resizing && change.dimensions) next[change.id] = change.dimensions;
      }
      return next;
    });
    const positions = changes.filter(change => change.type === "position" && change.position);
    if (!positions.length) return;
    const nextPositions: Record<string, WorkbenchPosition> = {};
    for (const change of positions) if (change.type === "position" && change.position) nextPositions[change.id] = change.position;
    if (alignmentDragRef.current.length) {
      const currentNodes = flow.getNodes();
      const byId = new Map(currentNodes.map(node => [node.id, node]));
      const sizes = new Map(currentNodes.map(node => [node.id, { width: node.measured?.width ?? node.width ?? 360, height: node.measured?.height ?? node.height ?? 180 }]));
      const absolutePositions = new Map<string, WorkbenchPosition>();
      function absolutePosition(id: string): WorkbenchPosition {
        const cached = absolutePositions.get(id);
        if (cached) return cached;
        const node = byId.get(id)!;
        const position = nextPositions[id] ?? node.position;
        const parent = node.parentId && byId.has(node.parentId) ? absolutePosition(node.parentId) : { x: 0, y: 0 };
        const size = sizes.get(id)!;
        const absolute = { x: position.x + parent.x - (node.origin?.[0] ?? 0) * size.width, y: position.y + parent.y - (node.origin?.[1] ?? 0) * size.height };
        absolutePositions.set(id, absolute);
        return absolute;
      }
      const alignment = getCanvasAlignment({
        nodes: currentNodes.map(node => ({ id: node.id, ...absolutePosition(node.id), ...sizes.get(node.id)!, parentId: node.parentId, hidden: node.hidden })),
        movingIds: alignmentDragRef.current,
        zoom: flow.getZoom(),
      });
      const moving = new Set(alignmentDragRef.current);
      const roots: string[] = [];
      const allowedAlignment = { x: true, y: true };
      for (const id of moving) {
        let parentId = byId.get(id)?.parentId;
        while (parentId && !moving.has(parentId)) parentId = byId.get(parentId)?.parentId;
        if (!parentId) roots.push(id);
      }
      for (const id of roots) {
        const node = byId.get(id);
        if (!node?.extent) continue;
        const parentSize = node.extent === "parent" ? sizes.get(node.parentId ?? "") : undefined;
        const extent = parentSize ? [[0, 0], [parentSize.width, parentSize.height]] : node.extent;
        if (!Array.isArray(extent)) continue;
        const position = nextPositions[id] ?? node.position, size = sizes.get(id)!;
        const [left, top] = extent[0], [right, bottom] = extent[1];
        const [originX, originY] = node.origin ?? [0, 0];
        if (position.x + alignment.dx < left + originX * size.width || position.x + alignment.dx > right - (1 - originX) * size.width) allowedAlignment.x = false;
        if (position.y + alignment.dy < top + originY * size.height || position.y + alignment.dy > bottom - (1 - originY) * size.height) allowedAlignment.y = false;
      }
      if (!allowedAlignment.x) alignment.dx = 0;
      if (!allowedAlignment.y) alignment.dy = 0;
      alignment.guides = alignment.guides.filter(guide => allowedAlignment[guide.axis]);
      for (const [id, position] of Object.entries(nextPositions)) {
        let parentId = byId.get(id)?.parentId;
        while (parentId && !moving.has(parentId)) parentId = byId.get(parentId)?.parentId;
        if (!parentId) nextPositions[id] = { x: position.x + alignment.dx, y: position.y + alignment.dy };
      }
      alignedPositionsRef.current = nextPositions;
      setAlignmentGuides(alignment.guides);
      if (positions.every(change => change.type === "position" && change.dragging === false)) {
        const activeDrag = alignmentDragRef.current;
        queueMicrotask(() => {
          // React Flow 的正常 stop 已清理拖动；仅取消路径会保留同一次拖动。
          if (alignmentDragRef.current !== activeDrag) return;
          alignmentDragRef.current = []; alignedPositionsRef.current = {}; copyDragRef.current = undefined;
          setAlignmentGuides([]); setPreviewPositions({});
        });
      }
    }
    setPreviewPositions(previous => {
      return { ...previous, ...nextPositions };
    });
  }

  function updateEdgeChanges(changes: EdgeChange[]) {
    if (controller.getSnapshot().transitioning || tool !== "select") return;
    const selectionChanges = changes.filter(change => change.type === "select");
    if (!selectionChanges.length) return;
    setSelectedEdgeIds(previous => {
      const ids = new Set(previous);
      for (const change of selectionChanges) change.selected ? ids.add(change.id) : ids.delete(change.id);
      return [...ids];
    });
  }

  function commitNodePositions(moved: CanvasNode[]) {
    moved = moved.map(node => ({ ...node, position: alignedPositionsRef.current[node.id] ?? node.position }));
    alignmentDragRef.current = [];
    setAlignmentGuides([]);
    const copy = copyDragRef.current;
    if (copy) {
      if (copy.pending) return;
      copy.pending = true;
      queueMicrotask(() => {
        copyDragRef.current = undefined;
        const first = moved.find(node => copy.origin[node.id]);
        const origin = first && copy.origin[first.id];
        if (first && origin) void run(async () => {
          try { await controller.execute("duplicateNodes", { nodeIds: copy.ids, withEdges: copy.withEdges, reparent: true, offset: { x: first.position.x - origin.x, y: first.position.y - origin.y } }); }
          finally { setPreviewPositions({}); }
        });
        else setPreviewPositions({});
      });
      return;
    }
    const pending = dragCommitRef.current;
    if (pending) { for (const node of moved) pending.set(node.id, node); return; }
    const submitted = new Map(moved.map(node => [node.id, node]));
    const dragTarget = { directory: snapshot.directory, canvasId: snapshot.canvasId };
    dragCommitRef.current = submitted;
    queueMicrotask(() => {
      if (dragCommitRef.current !== submitted) return;
      dragCommitRef.current = undefined;
      const current = controller.getSnapshot();
      if (current.directory !== dragTarget.directory || current.canvasId !== dragTarget.canvasId) return;
      const updates = [...submitted.values()].map(node => ({ id: node.id, position: node.position })).filter(node => {
        const saved = current.document?.nodes.find(item => item.id === node.id)?.position;
        return saved && (saved.x !== node.position.x || saved.y !== node.position.y);
      });
      if (updates.length) runCommand("finishNodeDrag", { nodes: updates });
      setPreviewPositions({});
    });
  }
  function startNodeDrag(event: MouseEvent | TouchEvent | React.MouseEvent, moved: CanvasNode[]) {
    alignmentDragRef.current = moved.map(node => node.id);
    alignedPositionsRef.current = {};
    setAlignmentGuides([]);
    if (!("altKey" in event) || editingLocked) return;
    const withEdges = shortcutPressed(event, shortcuts.duplicateOnDrag, new Set());
    if (!withEdges && !shortcutPressed(event, shortcuts.copyOnDrag, new Set())) return;
    const ids = moved.map(node => node.id);
    copyDragRef.current = { ids, withEdges, pending: false, origin: Object.fromEntries((snapshot.document?.nodes ?? []).filter(node => ids.includes(node.id)).map(node => [node.id, node.position])) };
  }

  function connectNodes(connection: Connection) {
    runCommand("connectNodes", { ...connection });
  }

  function moveSelectionConnection(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!selectionDragRef.current || !canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const inside = element && canvasRef.current.contains(element);
    const handle = inside ? element.closest(".react-flow__handle") : null;
    const target = inside ? element.closest(".react-flow__node") : null;
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, targetId: target?.getAttribute("data-id") ?? undefined, targetHandle: handle?.classList.contains("target") ? handle.getAttribute("data-handleid") ?? undefined : undefined };
    setSelectionPointer(point);
    return { point, blank: !!inside && element.classList.contains("react-flow__pane"), sourceHandle: handle?.classList.contains("source") };
  }

  function startSelectionConnection(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || editingLocked || !snapshot.selectedIds.length) return;
    event.preventDefault(); event.stopPropagation();
    selectionDragRef.current = { nodeIds: [...snapshot.selectedIds], directory: snapshot.directory, canvasId: snapshot.canvasId, revision: snapshot.revision };
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    moveSelectionConnection(event);
  }

  function finishSelectionConnection(event: ReactPointerEvent<HTMLButtonElement>) {
    const started = selectionDragRef.current;
    if (!started) return;
    event.preventDefault(); event.stopPropagation();
    const hovered = moveSelectionConnection(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setSelectionPointer(null);
    void run(async () => {
      const current = controller.getSnapshot();
      if (current.directory !== started.directory || current.canvasId !== started.canvasId || current.revision !== started.revision) throw new Error("画布已变化，请重新拖动选区连线");
      if (hovered?.point.targetId && !hovered.sourceHandle) {
        selectionDragRef.current = null;
        await controller.execute("connectSelection", { nodeIds: started.nodeIds, target: hovered.point.targetId, ...(hovered.point.targetHandle ? { targetHandle: hovered.point.targetHandle } : {}) });
      } else if (hovered?.blank) {
        await showSelectionCreation(started, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      } else selectionDragRef.current = null;
    });
  }

  async function showSelectionCreation(started: NonNullable<typeof selectionDragRef.current>, position: WorkbenchPosition) {
    const result = await controller.execute("getCompatibleSelectionNodeTypes", { nodeIds: started.nodeIds }) as { types: string[] };
    const current = controller.getSnapshot();
    if (current.directory !== started.directory || current.canvasId !== started.canvasId || current.revision !== started.revision) throw new Error("画布已变化，请重新选择创建位置");
    showPalette("add", position, undefined, result.types);
    selectionDragRef.current = started;
    setConnectionSelection(started.nodeIds);
  }

  function applyZoom() {
    if (cancelZoomRef.current) { cancelZoomRef.current = false; setZoomInput(null); return; }
    if (zoomInput === null) return;
    const value = Number(zoomInput);
    setZoomInput(null);
    if (!Number.isFinite(value) || value < 15 || value > 800) { reportError(new Error("缩放比例须为 15% 到 800%")); return; }
    void run(() => moveViewport(() => flow.zoomTo(value / 100, { duration: reducedMotion ? 0 : 160 })));
  }

  function changeCanvasView(options: Partial<CanvasViewOptions>) {
    void run(() => controller.execute("setCanvasView", options));
  }

  function dropNode(event: DragEvent<HTMLDivElement>) {
    const asset = event.dataTransfer.getData(assetDragType);
    if (asset && snapshot.document && !editingLocked) {
      event.preventDefault(); const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), directory = snapshot.directory, canvasId = snapshot.canvasId;
      void run(async () => { const info = await assetLibraryClient.stat(asset), file = await assetLibraryClient.readFile(asset, undefined, info.fileRevision), current = controller.getSnapshot(); if (current.directory !== directory || current.canvasId !== canvasId) throw new Error("读取素材期间画布已切换，请重新拖入"); await controller.importMedia([file], position); }); setManagementPanel(null); return;
    }
    if (event.dataTransfer.files.length && snapshot.document && !editingLocked) {
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void run(() => controller.importMedia(files, position)); return;
    }
    const type = event.dataTransfer.getData("application/opencinema-node");
    if (!type || !snapshot.document || editingLocked) return;
    event.preventDefault();
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    void run(() => controller.addNode(type, position));
    setPalette(null);
  }

  function openDirectory(directory: string) {
    return run(async () => {
      await controller.openProject(directory);
      setOpenPanel(null);
    });
  }

  function showProjectPicker(creating = false) {
    setProjectPicker({ creating, directory: creating ? "" : snapshot.directory ?? "" });
    setOpenPanel("project");
  }

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab);
    setOpenPanel("settings");
  }

  // 节点插件通过这个事件跳到设置页，不需要依赖工作台内部组件。
  useEffect(() => {
    function open(event: Event) {
      const tab = (event as CustomEvent<{ tab?: SettingsTab }>).detail?.tab;
      openSettings(tab ?? "host");
    }
    window.addEventListener("openCinema:open-settings", open);
    return () => window.removeEventListener("openCinema:open-settings", open);
  }, []);

  async function sendPrompt(event?: FormEvent) {
    event?.preventDefault();
    if (!prompt.trim() || sending || !canSendPrompt) return;
    sendingPromptKey.current = promptKey;
    setSending(true);
    setError(null);
    setPromptStatus("");
    const target = { directory: snapshot.directory, canvasId: snapshot.canvasId };
    const submitted = prompt;
    const submittedKey = promptKey;
    const nodeIds = [...snapshot.selectedIds];
    const action = composerAction ? { nodeId: composerAction.nodeId, tool: composerAction.tool } : undefined;
    try {
      const response = await controller.sendPrompt(submitted.trim(), { nodeIds, action });
      const current = controller.getSnapshot();
      if (current.directory === target.directory && current.canvasId === target.canvasId) {
        setPromptDrafts(previous => previous[submittedKey] === submitted ? { ...previous, [submittedKey]: "" } : previous);
        if (activePromptKey.current === submittedKey) setPromptStatus(response.status === "completed" ? `Agent 已完成${response.text?.trim() ? ` · ${response.text.trim()}` : ""}` : action ? "已发起创作 · 请在节点查看进度" : "宿主已接收 · 等待 Agent 处理");
      }
    } catch (value) {
      if (activePromptKey.current === submittedKey) reportError(value);
    } finally {
      sendingPromptKey.current = null;
      setSending(false);
    }
  }

  useEffect(() => {
    setPreviewPositions({});
    alignmentDragRef.current = []; alignedPositionsRef.current = {}; setAlignmentGuides([]);
    setPreviewDimensions({});
    setSelectedEdgeIds([]);
    setPalette(null);
    setPromptStatus("");
    setComposerAction(null);
    setContextMenu(null); setBatchConnectionOpen(false); copyDragRef.current = undefined;
    setConnectionSelection(null); setSelectionPointer(null); selectionDragRef.current = null; setZoomInput(null);
  }, [snapshot.directory, snapshot.canvasId]);
  useEffect(() => {
    if (openPanel === "project") setRecentProjects(readRecentProjects());
  }, [openPanel]);
  useEffect(() => {
    const operation = new AbortController();
    void findMissingProjects(recentProjects.map(project => project.directory), operation.signal).then(missing => { if (!operation.signal.aborted) setMissingProjects(missing); });
    return () => operation.abort();
  }, [recentProjects]);
  useEffect(() => {
    if (window.openCinemaTransport || !snapshot.directory || !snapshot.canvasId) return;
    const url = new URL(location.href);
    url.searchParams.set("directory", snapshot.directory); url.searchParams.set("canvas", snapshot.canvasId);
    window.history.replaceState(null, "", url);
  }, [snapshot.directory, snapshot.canvasId]);

  useEffect(() => {
    const operation = new AbortController();
    async function refresh() { try {
      const { general } = await workbenchSettingsClient.generalConfiguration(operation.signal);
      if (operation.signal.aborted) return;
      const saved = general.canvasShortcuts && typeof general.canvasShortcuts === "object" && !Array.isArray(general.canvasShortcuts) ? general.canvasShortcuts : {};
      const next = { ...defaultCanvasShortcuts };
      for (const field of canvasShortcutFields) { const configured = saved[field.id], value = typeof configured === "string" ? normalizeShortcut(configured) : undefined; if (value !== undefined && isShortcutAllowed(field, value)) next[field.id] = value; }
      setShortcuts(next);
      setEdgeAppearance({ animated: general.canvasEdgeAnimationEnabled !== false, colorMode: typeof general.canvasEdgeColorMode === "string" && ["none", "theme", "custom"].includes(general.canvasEdgeColorMode) ? general.canvasEdgeColorMode : "theme", color: typeof general.canvasEdgeColor === "string" && /^#[a-f\d]{3,8}$/i.test(general.canvasEdgeColor) ? general.canvasEdgeColor : "#2dd4bf" });
      setSavedNodeMenu(normalizeNodeMenu(general.nodeMenu));
    } catch (value) { if (!operation.signal.aborted) reportError(value); } }
    void refresh();
    window.addEventListener("openCinema:general-settings-changed", refresh);
    return () => { operation.abort(); window.removeEventListener("openCinema:general-settings-changed", refresh); };
  }, [openPanel, reportError]);

  useEffect(() => {
    if (editingLocked || tool !== "select") {
      setPreviewPositions({});
      alignmentDragRef.current = []; alignedPositionsRef.current = {}; setAlignmentGuides([]);
      setPreviewDimensions({});
    }
  }, [editingLocked, tool]);

  useEffect(() => {
    const ids = new Set(snapshot.document?.edges.map(edge => edge.id));
    setSelectedEdgeIds(previous => {
      const next = previous.filter(id => ids.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [snapshot.document?.edges]);

  useEffect(() => {
    if (palette) paletteInputRef.current?.focus();
  }, [palette]);

  useEffect(() => {
    if (!canvasMenuOpen && !contextMenu) return;
    function closeOutside(event: PointerEvent) {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".canvasSwitcher")) setCanvasMenuOpen(false);
      if (!event.target.closest(".contextMenu")) setContextMenu(null);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [canvasMenuOpen, contextMenu]);

  useEffect(() => {
    if (!palette) return;
    const active = document.querySelector<HTMLElement>(".openCinemaWorkbench .paletteItemActive");
    active?.scrollIntoView({ block: "nearest" });
  }, [paletteIndex, palette]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.isComposing) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (snapshot.document && !editingLocked) void run(() => controller.save());
        return;
      }
      if (event.key === "Escape" && !isEditing(event.target)) {
        setPalette(null);
        setOpenPanel(null);
        setCanvasMenuOpen(false);
        return;
      }
      if (isEditing(event.target) || openPanel || palette || managementPanel === "canvas" || batchConnectionOpen) return;
      if (shortcutMatches(event, shortcuts.paste) && !editingLocked && !(modifier && event.code === "KeyV" && !event.altKey && !event.shiftKey)) {
        event.preventDefault(); void run(() => pasteClipboard(openCanvasPosition())); return;
      }
      if (shortcutMatches(event, shortcuts.search)) { event.preventDefault(); showPalette("search"); return; }
      if (shortcutMatches(event, shortcuts.moveTool)) { event.preventDefault(); setTool("select"); return; }
      if (shortcutMatches(event, shortcuts.handTool)) { event.preventDefault(); setTool("pan"); return; }
      if (shortcutMatches(event, shortcuts.arrange) && !editingLocked) { event.preventDefault(); void run(() => controller.execute("arrangeCanvas", {})); return; }
      if (shortcutMatches(event, shortcuts.zoomIn) || shortcutMatches(event, shortcuts.zoomOut) || shortcutMatches(event, shortcuts.fitView)) {
        event.preventDefault(); void run(() => moveViewport(() => shortcutMatches(event, shortcuts.fitView) ? flow.fitView({ padding: fitPadding, duration: reducedMotion ? 0 : 220 }) : shortcutMatches(event, shortcuts.zoomIn) ? flow.zoomIn({ duration: reducedMotion ? 0 : 160 }) : flow.zoomOut({ duration: reducedMotion ? 0 : 160 }))); return;
      }
      if (shortcutMatches(event, shortcuts.mergeGroup) && snapshot.selectedIds.length && !editingLocked) { event.preventDefault(); runCommand("mergeGroups", { nodeIds: selectedGroups }); return; }
      if (shortcutMatches(event, shortcuts.copy) && snapshot.selectedIds.length) {
        event.preventDefault(); void run(() => controller.execute("copyNodes", { nodeIds: snapshot.selectedIds, preferImage: true }));
      } else if (modifier && event.key.toLowerCase() === "d" && snapshot.selectedIds.length && !editingLocked) {
        event.preventDefault(); runCommand("duplicateNodes", { nodeIds: snapshot.selectedIds });
      } else if ((shortcutMatches(event, shortcuts.group) || shortcutMatches(event, shortcuts.ungroup)) && snapshot.selectedIds.length && !editingLocked) {
        event.preventDefault(); runCommand(shortcutMatches(event, shortcuts.ungroup) ? "ungroupNodes" : "groupNodes", { nodeIds: shortcutMatches(event, shortcuts.ungroup) ? selectedGroups : snapshot.selectedIds });
      } else if ((shortcutMatches(event, shortcuts.undo) || shortcutMatches(event, shortcuts.redo))) {
        event.preventDefault();
        if (!editingLocked && (shortcutMatches(event, shortcuts.redo) ? snapshot.canRedo : snapshot.canUndo)) void run(() => shortcutMatches(event, shortcuts.redo) ? controller.redo() : controller.undo());
      } else if ((shortcutMatches(event, shortcuts.delete) || event.key === "Delete") && snapshot.document && !editingLocked && (snapshot.selectedIds.length || selectedEdgeIds.length)) {
        event.preventDefault();
        runCommand("removeElements", { nodeIds: snapshot.selectedIds, edgeIds: selectedEdgeIds });
      } else if (shortcutMatches(event, shortcuts.addNode) && snapshot.document && event.target instanceof HTMLElement && (event.target.classList.contains("canvasSurface") || event.target.classList.contains("react-flow__pane") || event.target.classList.contains("react-flow__node"))) {
        event.preventDefault();
        showPalette("add");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    function paste(event: ClipboardEvent) {
      if (isEditing(event.target) || openPanel || palette || managementPanel === "canvas" || batchConnectionOpen || !snapshot.document || editingLocked) return;
      const files = [...(event.clipboardData?.files ?? [])];
      const command = event.clipboardData?.getData("text/plain") ?? "";
      if (files.length || command.trim()) { event.preventDefault(); void run(() => pasteContent(files, command, openCanvasPosition(), { directory: snapshot.directory, canvasId: snapshot.canvasId })); }
    }
    window.addEventListener("paste", paste);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("paste", paste); };
  });

  function viewportChanged(_event: MouseEvent | TouchEvent | null, viewport: Viewport) {
    setZoom(viewport.zoom);
    setViewTransform(viewport);
  }

  async function moveViewport(operation: () => Promise<boolean>) {
    const before = controller.getSnapshot();
    await operation();
    const current = controller.getSnapshot();
    if (before.directory === current.directory && before.canvasId === current.canvasId && current.document && !current.readOnly && !current.transitioning) await controller.execute("setViewport", { viewport: flow.getViewport() });
  }

  const otherProjects = recentProjects.filter(project => project.directory !== snapshot.directory);
  const recentProjectList = otherProjects.length > 0 && <div className="recentProjects" role="group" aria-label="最近工程">
    <span>最近工程</span>
    {otherProjects.map(({ directory, name }) => <div className={`recentProject${missingProjects.has(directory) ? " recentProjectMissing" : ""}`} key={directory}>
      <button type="button" title={directory} disabled={pending || snapshot.transitioning || missingProjects.has(directory)} onClick={() => void openDirectory(directory)}><IconFolderOpen aria-hidden="true" focusable="false" size={16} /><strong>{name}</strong><small>{missingProjects.has(directory) ? `文件夹已不存在 · ${directory}` : directory}</small></button>
      <button type="button" aria-label={`从列表移除 ${name}`} title="从列表移除，不删除文件" onClick={() => setRecentProjects(forgetRecentProject(directory))}><IconX aria-hidden="true" focusable="false" size={14} /></button>
    </div>)}
  </div>;

  return <div className="openCinemaWorkbench" ref={rootRef}>
    <WorkbenchTooltip containerRef={rootRef} />
    <input ref={mediaImportRef} type="file" multiple hidden aria-label="导入画布素材" onChange={event => { const files = [...event.target.files ?? []], target = mediaImportTarget.current; event.target.value = ""; if (files.length && target) void run(() => { const current = controller.getSnapshot(); if (current.directory !== target.directory || current.canvasId !== target.canvasId) throw new Error("选择文件期间画布已切换，请重新导入"); return controller.importMedia(files, target.position); }); setContextMenu(null); }} />
    <main className="canvasSurface" data-single-selection={snapshot.selectedIds.length === 1} inert={!!(palette || openPanel || managementPanel === "canvas" || batchConnectionOpen)} ref={canvasRef} aria-label="OpenCinema 画布" tabIndex={0} onDrop={dropNode} onDoubleClick={event => {
      if (snapshot.document && event.target instanceof HTMLElement && event.target.classList.contains("react-flow__pane")) showPalette("add", flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }} onDragOver={event => {
      if (event.dataTransfer.types.includes("application/opencinema-node") || event.dataTransfer.types.includes(assetDragType) || event.dataTransfer.types.includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    }}>
      <ReactFlow<CanvasNode>
        key={`${snapshot.directory}:${snapshot.canvasId}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={updateNodeChanges}
        onEdgesChange={updateEdgeChanges}
        onNodeClick={(event, node) => { if (tool === "select" && !snapshot.transitioning && snapshot.selectedIds.length > 1 && !shortcutPressed(event, shortcuts.multiSelection, new Set())) controller.select([node.id]); }}
        onNodeDoubleClick={(event, node) => {
          if (panMode || snapshot.transitioning || node.selectable === false || event.defaultPrevented || (event.target instanceof Element && event.target.closest("button, input, textarea, select, a, video, audio, .nodeTitle, .nodrag, [contenteditable='true']"))) return;
          void run(async () => {
            controller.select([node.id]);
            await moveViewport(() => flow.fitView({ nodes: [{ id: node.id }], padding: .3, maxZoom: 1.5, duration: reducedMotion ? 0 : 220 }));
          });
        }}
        onNodeDragStart={(event, node, moved) => startNodeDrag(event, moved.length ? moved : [node])}
        onSelectionDragStart={(event, moved) => startNodeDrag(event, moved)}
        onNodeDragStop={(_event, node, moved) => commitNodePositions(moved.length ? moved : [node])}
        onSelectionDragStop={(_event, moved) => commitNodePositions(moved)}
        onConnect={connectNodes}
        isValidConnection={connection => controller.validateConnection(connection)}
        onConnectEnd={(event, state) => {
          if (event.type === "touchcancel" || state.isValid || state.toNode || !state.fromNode || !state.fromHandle?.id || editingLocked) return;
          const point = "changedTouches" in event ? event.changedTouches[0] : event;
          if (!point) return;
          const element = document.elementFromPoint(point.clientX, point.clientY);
          if (!element?.classList.contains("react-flow__pane") || !canvasRef.current?.contains(element)) return;
          const endpoint = { nodeId: state.fromNode.id, handleId: state.fromHandle.id, direction: state.fromHandle.type };
          const position = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
          void run(async () => showPalette("add", position, endpoint, await controller.compatibleNodeTypes(endpoint.nodeId, endpoint.handleId, endpoint.direction)));
        }}
        onMove={viewportChanged}
        onMoveEnd={(event, viewport) => { if (event && snapshot.document && !editingLocked) runCommand("setViewport", { viewport }); }}
        onInit={instance => { setZoom(instance.getZoom()); setViewTransform(instance.getViewport()); }}
        defaultViewport={snapshot.document?.viewport ?? { x: 0, y: 0, zoom: 1 }}
        onPaneClick={() => { setCanvasMenuOpen(false); setContextMenu(null); canvasRef.current?.focus(); }}
        onPaneContextMenu={showContextMenu}
        onSelectionContextMenu={showContextMenu}
        onNodeContextMenu={(event, node) => { if (!snapshot.selectedIds.includes(node.id)) controller.select([node.id]); showContextMenu(event); }}
        zoomOnDoubleClick={false}
        nodesDraggable={!!snapshot.document && !panMode && !editingLocked}
        nodesConnectable={!!snapshot.document && !editingLocked}
        elementsSelectable={!panMode && !snapshot.transitioning}
        panOnDrag={panMode ? true : [1, 2]}
        selectionOnDrag={!panMode && getShortcutBindings(shortcuts.selection).includes("None")}
        selectionKeyCode={shortcutKeys.selection}
        multiSelectionKeyCode={shortcutKeys.multiSelection}
        panActivationKeyCode={shortcutKeys.pan}
        zoomActivationKeyCode={shortcutKeys.zoom}
        selectionMode={SelectionMode.Partial}
        snapToGrid={snapEnabled}
        snapGrid={[16, 16]}
        panOnScroll={!getShortcutBindings(shortcuts.zoom).includes("None")}
        zoomOnScroll={getShortcutBindings(shortcuts.zoom).includes("None")}
        deleteKeyCode={null}
        minZoom={0.15}
        maxZoom={8}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20 * (zoom < .4 ? 4 : zoom < .7 ? 2 : 1)} size={Math.min(3, 1 / zoom)} color="var(--canvasDot)" />
        {canvasView.miniMap && <MiniMap className="canvasMiniMap" position="bottom-left" pannable zoomable nodeColor={node => snapshot.selectedIds.includes(node.id) ? "var(--selectionAccent)" : "var(--surfaceRaised)"} maskColor="rgba(11, 13, 17, .65)" aria-label="画布导航地图" />}
      </ReactFlow>
      {!!alignmentGuides.length && <svg className="canvasAlignmentGuides" aria-hidden="true">{alignmentGuides.map(guide => {
        const vertical = guide.axis === "x";
        const position = (vertical ? viewTransform.x : viewTransform.y) + guide.position * viewTransform.zoom;
        const start = (vertical ? viewTransform.y : viewTransform.x) + guide.start * viewTransform.zoom;
        const end = (vertical ? viewTransform.y : viewTransform.x) + guide.end * viewTransform.zoom;
        return <g key={guide.axis}><line x1={vertical ? position : start} y1={vertical ? start : position} x2={vertical ? position : end} y2={vertical ? end : position} /><circle cx={vertical ? position : start} cy={vertical ? start : position} r={2} /><circle cx={vertical ? position : end} cy={vertical ? end : position} r={2} /></g>;
      })}</svg>}
      {selectionPath && <svg className="selectionConnection" aria-hidden="true"><path d={selectionPath} /></svg>}
      {selectionAnchor && (snapshot.selectedIds.length > 1 || selectedGroups.length > 0) && !editingLocked && tool === "select" && !palette && <button className="selectionConnectHandle nodrag nopan" type="button" style={{ left: selectionAnchor.x, top: selectionAnchor.y }} aria-label="拖动连接选区；拖至空白创建并连接节点" title="拖到节点批量连接，拖到空白创建并连接" onPointerDown={startSelectionConnection} onPointerMove={moveSelectionConnection} onPointerUp={finishSelectionConnection} onPointerCancel={() => { setSelectionPointer(null); selectionDragRef.current = null; }} onKeyDown={event => { if (event.key === "Escape") { setSelectionPointer(null); selectionDragRef.current = null; } if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setBatchTarget(""); setBatchConnectionOpen(true); } }}><IconCircleDashed aria-hidden="true" focusable="false" size={19} /></button>}
    </main>

    <div className="workspaceChrome">
      <div className="workspaceCapsule">
        <button className="brandButton" type="button" title="打开工程" disabled={snapshot.transitioning} onClick={() => showProjectPicker()}>
          <span className="brandMark"><HeaderIcon name="movieFilter" size={20} /></span>
          <span className="brandName">OpenCinema</span>
          <span className="brandBadge">Studio</span>
        </button>
        <span className="headerSlash" aria-hidden="true">/</span>
        <button type="button" className="projectName" title={snapshot.directory ?? "打开工程"} disabled={snapshot.transitioning} onClick={() => showProjectPicker()}>{snapshot.projectName || "打开工程"}</button>
        <div className="canvasSwitcher">
          <button id="canvasMenuTrigger" className="canvasSwitchTrigger" type="button" aria-haspopup="menu" aria-controls="canvasMenu" disabled={!snapshot.canvasFiles.length || snapshot.transitioning} aria-expanded={canvasMenuOpen} onClick={() => setCanvasMenuOpen(open => !open)}><HeaderIcon name="description" size={13} /><span>{activeCanvasName}</span><IconChevronDown aria-hidden="true" focusable="false" size={12} /></button>
          <AnimatePresence>{canvasMenuOpen && <MotionLayer key="canvasMenu" id="canvasMenu" kind="menu" className="canvasMenu" role="menu" aria-labelledby="canvasMenuTrigger" onKeyDown={event => menuKeyDown(event, () => setCanvasMenuOpen(false))}>
            {snapshot.canvasFiles.map(file => <button type="button" role="menuitem" disabled={snapshot.transitioning || pending} className={file.path === snapshot.canvasId ? "activeCanvas" : ""} key={file.path} onClick={() => void run(async () => { await controller.switchCanvas(file.path); setCanvasMenuOpen(false); })}><IconLayoutGrid aria-hidden="true" focusable="false" size={16} /><span>{file.name}</span>{file.path === snapshot.canvasId && <IconCheck aria-hidden="true" focusable="false" size={15} />}</button>)}
            <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { setCanvasRenameTarget(undefined); setCanvasAction("add"); setCanvasName(""); setOpenPanel("canvas"); setCanvasMenuOpen(false); }}><IconPlus aria-hidden="true" focusable="false" size={16} />新建画布</button>
            <button type="button" role="menuitem" disabled={editingLocked || pending} onClick={() => void run(async () => { const target = controller.getSnapshot(); if (!target.directory || !target.canvasId) throw new Error("请先打开画布"); await controller.save(); const info = await createWorkspaceFiles(target.directory).stat(target.canvasId); const current = controller.getSnapshot(); if (current.directory !== target.directory || current.canvasId !== target.canvasId) throw new Error("画布已切换，请重新选择"); setCanvasRenameTarget({ directory: target.directory, canvasId: target.canvasId, fileRevision: info.fileRevision }); setCanvasAction("rename"); setCanvasName(activeCanvasName); setOpenPanel("canvas"); setCanvasMenuOpen(false); })}><IconPencil aria-hidden="true" focusable="false" size={16} />重命名当前画布</button>
            <button type="button" role="menuitem" disabled={snapshot.transitioning} onClick={() => { setManagementPanel("canvas"); setCanvasMenuOpen(false); }}><IconFolderOpen aria-hidden="true" focusable="false" size={16} />管理画布与文件夹</button>
          </MotionLayer>}</AnimatePresence>
        </div>
        <button className={`saveStatus${snapshot.error ? " saveStatusError" : ""}`} type="button" title={snapshot.error || saveLabel} disabled={!snapshot.document || snapshot.saving || editingLocked} onClick={() => void run(() => controller.save())}>
          {snapshot.saving || snapshot.transitioning ? <IconLoader2 aria-hidden="true" focusable="false" className="spin" size={14} /> : snapshot.readOnly ? <IconLock aria-hidden="true" focusable="false" size={14} /> : snapshot.dirty || snapshot.error || !snapshot.document ? <IconDeviceFloppy aria-hidden="true" focusable="false" size={14} /> : <IconCheck aria-hidden="true" focusable="false" size={14} />}<span>{saveLabel}</span>
        </button>
      </div>

      <div className="workspaceActions">
        <button type="button" className={`hostConnection${snapshot.host.connected ? " hostConnected" : ""}`} title={snapshot.host.connected ? "Agent 已连接，查看连接设置" : "连接 Agent"} onClick={() => openSettings("host")}><IconCircleFilled aria-hidden="true" focusable="false" size={8} /><span>{snapshot.host.name || "宿主未连接"}</span></button>
        <span className="capsuleDivider" />
        <button type="button" disabled={!CollaborationPanel || !snapshot.directory || snapshot.transitioning} title="多人协作" aria-label="多人协作" aria-haspopup="dialog" onClick={() => setOpenPanel("collaboration")}><IconUsers aria-hidden="true" focusable="false" size={18} /></button>
        <button className="exportAction" type="button" title="下载工程包" aria-label="导出工程" disabled={!snapshot.directory || pending || snapshot.transitioning} onClick={() => void run(() => controller.exportProject())}><IconDownload aria-hidden="true" focusable="false" size={16} /><span>导出工程</span></button>
      </div>

      <aside className="canvasToolRail" aria-label="画布工具">
        <div className="primaryTools">
          <button type="button" className={tool === "select" ? "activeTool" : ""} onClick={() => setTool("select")} title="选择" aria-label="选择" aria-pressed={tool === "select"}><IconPointer aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" className={tool === "pan" ? "activeTool" : ""} onClick={() => setTool("pan")} title="平移画布" aria-label="平移画布" aria-pressed={tool === "pan"}><IconHandStop aria-hidden="true" focusable="false" size={16} /></button>
          <span className="toolDivider" />
          <button type="button" ref={paletteTriggerRef} disabled={!snapshot.document || editingLocked} onClick={() => showPalette("add")} title="添加节点 (Tab)" aria-label="添加节点"><IconPlus aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" disabled={!snapshot.document} onClick={() => showPalette("search")} title="搜索画布节点" aria-label="搜索画布节点"><IconSearch aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" disabled={!snapshot.directory} onClick={() => setManagementPanel("assets")} title="素材库" aria-label="素材库"><IconFolderOpen aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" title="工作台设置" aria-label="工作台设置" onClick={() => openSettings("host")}><IconSettings aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" disabled={!nodes.length || editingLocked} title="整理画布" aria-label="整理画布" onClick={() => void run(() => controller.execute("arrangeCanvas", {}))}><IconLayoutGrid aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" className={snapEnabled ? "activeTool" : ""} disabled={editingLocked} title="网格吸附" aria-label="网格吸附" aria-pressed={snapEnabled} onClick={() => changeCanvasView({ snapEnabled: !snapEnabled })}><IconGridDots aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" className={!showEdges ? "activeTool" : ""} title={showEdges ? "隐藏连线（保留选中节点相关连线）" : "显示连线"} aria-label="显示连线" aria-pressed={showEdges} onClick={() => { changeCanvasView({ showEdges: !showEdges }); setSelectedEdgeIds([]); }}>{showEdges ? <IconLink aria-hidden="true" focusable="false" size={16} /> : <IconLinkOff aria-hidden="true" focusable="false" size={16} />}</button>
          <button type="button" className={canvasView.miniMap ? "activeTool" : ""} title={canvasView.miniMap ? "隐藏导航地图" : "显示导航地图"} aria-label="显示导航地图" aria-pressed={canvasView.miniMap} onClick={() => changeCanvasView({ miniMap: !canvasView.miniMap })}><IconMap aria-hidden="true" focusable="false" size={16} /></button>
        </div>
      </aside>

        {snapshot.directory && <div className="viewportControls" role="group" aria-label="画布视图与历史操作">
          <button type="button" disabled={!snapshot.canUndo || pending || editingLocked} onClick={() => void run(() => controller.undo())} title="撤销 (⌘/Ctrl Z)" aria-label="撤销"><IconArrowBackUp aria-hidden="true" focusable="false" size={16} /></button>
          <button type="button" disabled={!snapshot.canRedo || pending || editingLocked} onClick={() => void run(() => controller.redo())} title="重做 (⌘/Ctrl ⇧ Z)" aria-label="重做"><IconArrowForwardUp aria-hidden="true" focusable="false" size={16} /></button>
          <span className="toolDivider" />
          <button type="button" onClick={() => void run(() => moveViewport(() => flow.zoomIn({ duration: reducedMotion ? 0 : 160 })))} title="放大" aria-label="放大"><IconZoomIn aria-hidden="true" focusable="false" size={16} /></button>
          <label className="zoomValue"><input type="number" min={15} max={800} step={1} aria-label="画布缩放百分比" value={zoomInput ?? Math.round(zoom * 100)} onChange={event => setZoomInput(event.target.value)} onBlur={applyZoom} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { cancelZoomRef.current = true; event.currentTarget.blur(); } }} /><span aria-hidden="true">%</span></label>
          <button type="button" onClick={() => void run(() => moveViewport(() => flow.zoomOut({ duration: reducedMotion ? 0 : 160 })))} title="缩小" aria-label="缩小"><IconZoomOut aria-hidden="true" focusable="false" size={16} /></button>
          <span className="toolDivider" />
          <button type="button" disabled={!nodes.length} onClick={() => void run(() => moveViewport(() => flow.fitView({ padding: fitPadding, duration: reducedMotion ? 0 : 220 })))} title="适应视图" aria-label="适应视图"><IconFocusCentered aria-hidden="true" focusable="false" size={16} /></button>
        </div>}

      <AnimatePresence>{managementPanel && <MotionLayer key={managementPanel} kind="backdrop" className={`panelBackdrop managementBackdrop${managementPanel === "assets" ? " assetLibraryBackdrop" : ""}`} onKeyDownCapture={managementPanel === "canvas" ? trapOverlayFocus : undefined}>
        {managementPanel === "canvas" ? <CanvasManager controller={controller} onClose={() => setManagementPanel(null)} /> : <AssetLibrary controller={controller} onClose={() => setManagementPanel(null)} onImport={files => controller.importMedia(files, openCanvasPosition())} />}
      </MotionLayer>}</AnimatePresence>

      <AnimatePresence>{contextMenu && <MotionLayer key="contextMenu" kind="menu" className="contextMenu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={event => menuKeyDown(event, () => setContextMenu(null))}>
        <button type="button" role="menuitem" disabled={editingLocked} onClick={() => showPalette("add", contextMenu.position)}><IconPlus aria-hidden="true" focusable="false" size={14} />添加节点</button>
        <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { mediaImportTarget.current = { directory: snapshot.directory, canvasId: snapshot.canvasId, position: contextMenu.position }; mediaImportRef.current?.click(); }}><IconUpload aria-hidden="true" focusable="false" size={14} />导入素材</button>
        {snapshot.selectedIds.length > 0 && <>
          <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { runCommand("groupNodes", { nodeIds: snapshot.selectedIds }); setContextMenu(null); }}><IconBoxMultiple aria-hidden="true" focusable="false" size={14} />成组</button>
          {selectedGroups.length > 0 && <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { runCommand("ungroupNodes", { nodeIds: selectedGroups }); setContextMenu(null); }}><IconDeselect aria-hidden="true" focusable="false" size={14} />解组</button>}
          {selectedGroups.length > 1 && <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { runCommand("mergeGroups", { nodeIds: selectedGroups }); setContextMenu(null); }}><IconBoxMultiple aria-hidden="true" focusable="false" size={14} />合并分组</button>}
          {snapshot.selectedIds.length > 1 && ([['horizontal', '横向排列'], ['vertical', '纵向排列'], ['grid', '网格排列']] as const).map(([mode, label]) => <button type="button" role="menuitem" key={mode} disabled={editingLocked} onClick={() => { runCommand("arrangeSelection", { nodeIds: snapshot.selectedIds, mode }); setContextMenu(null); }}><IconLayoutGrid aria-hidden="true" focusable="false" size={14} />{label}</button>)}
          <div className="contextMenuDivider" role="separator" />
          <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { runCommand("duplicateNodes", { nodeIds: snapshot.selectedIds, withEdges: false }); setContextMenu(null); }}><IconCopy aria-hidden="true" focusable="false" size={14} />复制节点</button>
          <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { runCommand("duplicateNodes", { nodeIds: snapshot.selectedIds, withEdges: true }); setContextMenu(null); }}><IconBoxMultiple aria-hidden="true" focusable="false" size={14} />创建副本（含输入连线）</button>
          <button type="button" role="menuitem" onClick={() => { void run(() => controller.execute("copyNodes", { nodeIds: snapshot.selectedIds, preferImage: true })); setContextMenu(null); }}><IconClipboard aria-hidden="true" focusable="false" size={14} />复制到剪贴板</button>
          <button type="button" role="menuitem" disabled={editingLocked} onClick={() => { runCommand("removeElements", { nodeIds: snapshot.selectedIds, edgeIds: selectedEdgeIds }); setContextMenu(null); }}><IconTrash aria-hidden="true" focusable="false" size={14} />删除选中节点</button>
        </>}
        <button type="button" role="menuitem" disabled={editingLocked} onClick={() => void run(() => pasteClipboard(contextMenu.position))}><IconClipboard aria-hidden="true" focusable="false" size={14} />粘贴</button>
        <button type="button" role="menuitem" disabled={!snapshot.canUndo || editingLocked} onClick={() => { void run(() => controller.undo()); setContextMenu(null); }}><IconArrowBackUp aria-hidden="true" focusable="false" size={14} />撤销</button>
        <button type="button" role="menuitem" disabled={!snapshot.canRedo || editingLocked} onClick={() => { void run(() => controller.redo()); setContextMenu(null); }}><IconArrowForwardUp aria-hidden="true" focusable="false" size={14} />重做</button>
        <label className="edgeHighlightControl"><span>关联连线高亮</span><select aria-label="关联连线高亮" value={canvasView.highlight} onChange={event => changeCanvasView({ highlight: event.target.value as CanvasViewOptions["highlight"] })}><option value="both">上游与下游</option><option value="upstream">仅上游</option><option value="downstream">仅下游</option><option value="none">关闭</option></select></label>
      </MotionLayer>}</AnimatePresence>

      <AnimatePresence>{batchConnectionOpen && <MotionLayer key="batchConnection" kind="backdrop" className="panelBackdrop" onKeyDownCapture={trapOverlayFocus} onPointerDown={event => { if (event.target === event.currentTarget) setBatchConnectionOpen(false); }}><MotionLayer className="workspacePanel" role="dialog" aria-modal="true" aria-label="批量连接选区" onKeyDown={event => { if (event.key === "Escape") setBatchConnectionOpen(false); }}><header><span>批量连接选区</span><button type="button" aria-label="关闭批量连接" onClick={() => setBatchConnectionOpen(false)}><IconX aria-hidden="true" focusable="false" size={16} /></button></header><form className="projectForm" onSubmit={event => { event.preventDefault(); void run(async () => { const [target, targetHandle] = JSON.parse(batchTarget); await controller.execute("connectSelection", { nodeIds: snapshot.selectedIds, target, targetHandle }); await controller.save(); setBatchConnectionOpen(false); }); }}><label htmlFor="batchTarget">目标节点及输入端口</label><select id="batchTarget" autoFocus value={batchTarget} onChange={event => setBatchTarget(event.target.value)}><option value="" disabled>选择输入端口</option>{(snapshot.document?.nodes ?? []).filter(node => !snapshot.selectedIds.includes(node.id)).flatMap(node => node.data?.handles?.filter(handle => handle.type === "target").map(handle => <option key={`${node.id}:${handle.id}`} value={JSON.stringify([node.id, handle.id])}>{node.data?.label || node.id} · {handle.label || handle.id}</option>) ?? [])}</select><button type="submit" disabled={!batchTarget || pending || editingLocked}>连接选区</button></form></MotionLayer></MotionLayer>}</AnimatePresence>
      {selectedEdgeIds.length > 0 && !editingLocked && <button className="disconnectEdges" type="button" onClick={() => runCommand("removeElements", { nodeIds: [], edgeIds: selectedEdgeIds })}>断开 {selectedEdgeIds.length} 条连线</button>}

      {selectionToolbarVisible && <div ref={selectionToolbarRef} className="selectionToolbar" role="toolbar" aria-label="选区操作" style={selectionToolbarPosition}><span>{snapshot.selectedIds.length} 个节点</span><button className="selectionGroupAction" type="button" title="成组 (⌘/Ctrl G)" aria-label="成组选中节点" onClick={() => runCommand("groupNodes", { nodeIds: snapshot.selectedIds })}><IconBoxMultiple aria-hidden="true" focusable="false" size={17} />成组</button>{selectedGroups.length > 0 && <button className="selectionGroupAction" type="button" title="解组 (⌘/Ctrl ⇧ G)" aria-label="解组选中分组" onClick={() => runCommand("ungroupNodes", { nodeIds: selectedGroups })}><IconDeselect aria-hidden="true" focusable="false" size={17} />解组</button>}<button type="button" title="复制节点（不含输入连线）" aria-label="复制选中节点" onClick={() => runCommand("duplicateNodes", { nodeIds: snapshot.selectedIds, withEdges: false })}><IconCopy aria-hidden="true" focusable="false" size={17} /></button>
        <details className="selectionArrangeMenu" key={snapshot.selectedIds.join("|")} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary aria-label="排列与连接选区" title="排列与连接选区"><IconLayoutGrid aria-hidden="true" focusable="false" size={17} /></summary><div className="selectionArrangeActions" aria-label="选区排列" onClick={event => { if (event.target instanceof Element && event.target.closest("button")) event.currentTarget.parentElement?.removeAttribute("open"); }}>
          {snapshot.selectedIds.length > 1 && ([['horizontal', '横向排列'], ['vertical', '纵向排列'], ['grid', '网格排列']] as const).map(([mode, label]) => <button type="button" key={mode} onClick={() => runCommand("arrangeSelection", { nodeIds: snapshot.selectedIds, mode })}>{label}</button>)}
          {selectedGroups.length > 1 && <button type="button" onClick={() => runCommand("mergeGroups", { nodeIds: selectedGroups })}>合并分组</button>}
          <button type="button" onClick={() => { setBatchTarget(""); setBatchConnectionOpen(true); }}>批量连接到…</button>
          <button type="button" onClick={() => void run(() => { const current = controller.getSnapshot(); return showSelectionCreation({ nodeIds: [...current.selectedIds], directory: current.directory, canvasId: current.canvasId, revision: current.revision }, openCanvasPosition()); })}>创建并批量连接…</button>
        </div></details>
        <button type="button" title="删除选中节点" data-tone="danger" aria-label="删除选中节点" onClick={() => runCommand("removeElements", { nodeIds: snapshot.selectedIds, edgeIds: selectedEdgeIds })}><IconTrash aria-hidden="true" focusable="false" size={17} /></button></div>}

      {!snapshot.directory && <section className="projectWelcome" aria-label="开始使用"><strong>新建或打开一个工程</strong><p>工程就是本机的一个文件夹，画布和素材都保存在里面。</p><div className="welcomeActions"><button className="openProjectAction newProjectAction" type="button" disabled={snapshot.transitioning} onClick={() => showProjectPicker(true)}><IconFolderPlus aria-hidden="true" focusable="false" size={20} />新建工程</button><button className="openProjectAction" type="button" disabled={snapshot.transitioning} onClick={() => showProjectPicker()}><IconFolderOpen aria-hidden="true" focusable="false" size={20} />打开工程</button></div>{recentProjectList}</section>}

      {snapshot.document && !snapshot.document.nodes.length && !editingLocked && !palette && <section className="canvasEmptyGuide" aria-label="开始创作"><strong>把素材拖到这里，或添加第一个节点</strong><p>支持图片、视频、音频和文本文件。也可以在下方直接告诉 Agent 你想做什么。</p><div><button type="button" onClick={() => showPalette("add", openCanvasPosition())}><IconPlus aria-hidden="true" focusable="false" size={16} />添加节点<kbd>Tab</kbd></button><button type="button" onClick={() => { mediaImportTarget.current = { directory: snapshot.directory, canvasId: snapshot.canvasId, position: openCanvasPosition() }; mediaImportRef.current?.click(); }}><IconUpload aria-hidden="true" focusable="false" size={16} />导入素材</button>{starterFlow.every(([type]) => snapshot.plugins.some(plugin => plugin.type.replace(/^remote-/, "") === type)) && <button type="button" title="文本 → 图片生成 → 视频生成" disabled={pending} onClick={() => void run(addStarterFlow)}><IconSitemap aria-hidden="true" focusable="false" size={16} />搭示例流程</button>}<button type="button" onClick={() => openSettings("models")}><IconSettings aria-hidden="true" focusable="false" size={16} />配置媒体服务</button></div></section>}

      {snapshot.directory && <button className="historyTrigger" type="button" title="历史记录" aria-label="历史记录" disabled={!snapshot.document || snapshot.transitioning} onClick={() => setOpenPanel("history")}><IconHistory aria-hidden="true" focusable="false" size={14} /><span>历史记录</span></button>}

      {snapshot.directory && <div className="composerArea">
        <form className={`hostComposer${promptStatus || sending || composerBlocked ? " composerHasStatus" : ""}`} onSubmit={event => void sendPrompt(event)}>
          {composerTargets.length > 0 || composerAction ? <div className="composerContext" id="composerScope" aria-live="polite">
            <span className="composerMode">{composerAction?.label ?? (composerTargets.length ? "操作选中节点" : "画布指令")}</span>
            {selectedComposer?.defaultAction && <button type="button" className="composerModeSwitch" onClick={() => { setComposerAction(composerAction ? null : { nodeId: composerTargets[0].id, ...selectedComposer }); setPromptStatus(""); }} title={composerAction ? "让 Agent 调整此节点，不发起生成" : "使用此节点的生成能力"}>{composerAction ? "调整节点" : selectedComposer.label}</button>}
            <button type="button" className="composerTargetPicker" disabled={!snapshot.document || snapshot.transitioning} title={composerTargets.map(node => node.data?.label || node.id).join("、") || "未选中节点时，Agent 操作整个画布"} aria-label="选择操作对象" onClick={() => showPalette("search", undefined, undefined, undefined, true)}><IconFocusCentered aria-hidden="true" focusable="false" size={13} /><span>{composerTargets.length ? `${composerTargets.length > 1 ? `${composerTargets.length} 个节点 · ` : ""}${composerTargets.slice(0, 3).map(node => node.data?.label || "未命名节点").join("、")}${composerTargets.length > 3 ? "…" : ""}` : "整个画布"}</span><IconChevronDown aria-hidden="true" focusable="false" size={12} /></button>
            {composerTargets.length > 0 && <button type="button" className="composerTargetClear" onClick={() => controller.select([])} aria-label="退出选区" title="退出选区，操作整个画布"><IconX aria-hidden="true" focusable="false" size={12} /></button>}
            {composerReferences > 0 && <span className="composerReferences">{composerReferences} 条参考</span>}
          </div> : <span className="composerScopeHint" id="composerScope">操作整个画布</span>}
          <div className="composerInputRow">
          <IconSparkles className="composerMark" aria-hidden="true" focusable="false" size={18} stroke={1.6} />
          <textarea ref={composerRef} value={prompt} maxLength={composerAction?.maxLength ?? 16000} onChange={event => { setPrompt(event.target.value); setPromptStatus(""); }} disabled={sending && sendingPromptKey.current === promptKey} placeholder={composerAction?.placeholder ?? (composerTargets.length ? `让 Agent 对${composerTargets.length === 1 ? "这个" : `这 ${composerTargets.length} 个`}节点做什么…` : "描述你的创作意图…")} aria-label="Agent 创作指令" aria-describedby="composerScope" rows={1} onKeyDown={event => {
            if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void sendPrompt();
            }
          }} />
          <div className="composerFooter">
            <span className={`composerHost${snapshot.host.connected ? " composerHostConnected" : ""}`} title={snapshot.host.name || "等待宿主连接"}><IconCircleFilled aria-hidden="true" focusable="false" size={6} /><span>{snapshot.host.name || "等待宿主连接"}</span></span>
            <button type="button" disabled={!snapshot.document} className="composerReference" title="添加或移除操作节点" aria-label="添加或移除操作节点" onClick={() => showPalette("search", undefined, undefined, undefined, true)}><IconAt aria-hidden="true" focusable="false" size={17} /></button>
            <kbd className="composerShortcut" title="⌘ / Ctrl + Enter 发送">⌘ ↵</kbd>
            <button type="submit" className="sendAction" disabled={!prompt.trim() || !canSendPrompt || sending} title={composerDisabledReason || composerAction?.label || "发送画布指令"} aria-describedby={composerDisabledReason ? "composerAvailability" : undefined} aria-label={composerAction?.label ?? "发送画布指令"}>{sending && sendingPromptKey.current === promptKey ? <IconLoader2 aria-hidden="true" focusable="false" className="spin" size={16} /> : <IconArrowUp aria-hidden="true" focusable="false" size={16} />}</button>
            {composerDisabledReason && <span id="composerAvailability" className="composerScopeHint">{composerDisabledReason}</span>}
          </div>
          </div>
          {(promptStatus || sending) && <div className="composerStatus" role="status">{sending ? sendingPromptKey.current !== promptKey ? "上一条指令处理中 · 可继续写" : composerAction ? "正在发起创作" : "Agent 处理中" : promptStatus}</div>}
          {composerBlocked && <div className="composerStatus composerBlocked"><span>{composerDisabledReason}</span>{composerNeedsHost && <button type="button" onClick={() => openSettings("host")}>连接 Agent</button>}{composerNeedsHost && composerAction && <button type="button" onClick={() => openSettings("models")}>配置模型</button>}</div>}
        </form>
      </div>}

      <AnimatePresence>{palette && <MotionLayer key={palette} kind="backdrop" className="paletteBackdrop" onPointerDown={event => { if (event.target === event.currentTarget) closePalette(); }}>
        <MotionLayer kind="menu" className="nodePalette" role="dialog" aria-modal="true" aria-label={palette === "add" ? "添加节点" : pickingTargets ? "选择操作对象" : "搜索画布节点"} onDragStartCapture={event => { if (connectionSelection || connectionEndpoint) event.preventDefault(); }} onKeyDown={event => { trapOverlayFocus(event); if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); closePalette(); } }}>
          <div className="paletteSearch"><IconSearch aria-hidden="true" focusable="false" size={19} /><input ref={paletteInputRef} value={query} onChange={event => { setQuery(event.target.value); setPaletteIndex(0); }} onKeyDown={paletteKeyDown} placeholder={palette === "add" ? "搜索节点插件…" : "搜索当前画布节点…"} role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="nodePaletteResults" aria-activedescendant={paletteItems[paletteIndex] ? `paletteOption${paletteIndex}` : undefined} aria-label={palette === "add" ? "搜索节点插件" : "搜索当前画布节点"} /><button type="button" onClick={closePalette} aria-label="关闭搜索"><kbd>Esc</kbd></button></div>
          <div className="paletteHeading"><IconGridDots aria-hidden="true" focusable="false" size={14} /><span>{palette === "add" ? "节点插件" : pickingTargets ? "点击勾选操作节点" : "当前画布"}</span><span>{pickingTargets ? `${snapshot.selectedIds.length} / 20` : paletteItems.length}</span></div>
          <div id="nodePaletteResults" className="paletteResults" role="listbox" aria-label="搜索结果" aria-multiselectable={pickingTargets || undefined}>
            {paletteItems.map((item, index) => <button key={item.id} id={`paletteOption${index}`} type="button" role="option" aria-selected={pickingTargets ? snapshot.selectedIds.includes(item.id) : index === paletteIndex} className={`paletteItem${index === paletteIndex ? " paletteItemActive" : ""}`} disabled={!item.supported || pending || snapshot.transitioning || (palette === "add" && editingLocked) || (pickingTargets && !snapshot.selectedIds.includes(item.id) && snapshot.selectedIds.length >= 20)} onPointerMove={() => setPaletteIndex(index)} onClick={() => void run(() => choosePaletteItem(index))} draggable={palette === "add" && item.supported && !editingLocked} onDragStart={event => { event.dataTransfer.setData("application/opencinema-node", item.id); event.dataTransfer.effectAllowed = "copy"; }}><span className="paletteItemIcon">{createElement(nodeIcons[item.icon ?? ""] ?? IconPuzzle, { size: 16 })}</span><span className="paletteItemText"><strong>{item.label}</strong>{item.description && <span>{item.description}</span>}</span><span className="paletteItemCategory">{pickingTargets ? snapshot.selectedIds.includes(item.id) ? <IconCheck aria-label="已选中" size={18} /> : "选择" : item.supported ? item.category : "插件未就绪"}</span></button>)}
            {!paletteItems.length && <p className="paletteEmpty" role="status">没有匹配的节点</p>}
          </div>
          <footer className="paletteFooter"><span>↑ ↓ 选择 · Enter {palette === "add" ? connectionSelection ? `创建并连接 ${connectionSelection.length} 个来源` : connectionEndpoint ? "创建并连接" : palettePosition ? "放置到指定位置" : "放置中心" : pickingTargets ? "勾选 / 取消" : "定位节点"}</span>{pickingTargets ? <button type="button" onClick={closePalette}>完成选择{snapshot.selectedIds.length ? ` · ${snapshot.selectedIds.length} 个节点` : " · 整个画布"}</button> : palette === "add" && !connectionSelection && !connectionEndpoint && <span>可拖至画布</span>}</footer>
        </MotionLayer>
      </MotionLayer>}</AnimatePresence>

      <AnimatePresence>{openPanel && <MotionLayer key={openPanel} kind="backdrop" className="panelBackdrop" onPointerDown={event => { if (event.target === event.currentTarget && !pending) setOpenPanel(null); }}>
        <MotionLayer className={`workspacePanel ${openPanel}Panel`} role="dialog" aria-modal="true" aria-label={({ project: projectPicker.creating ? "新建工程" : "打开工程", canvas: canvasAction === "add" ? "新建画布" : "重命名画布", settings: "工作台设置", history: "历史记录", collaboration: "多人协作" })[openPanel]} onKeyDownCapture={event => {
          trapOverlayFocus(event);
          if (event.key === "Escape" && !event.nativeEvent.isComposing && !pending && event.target instanceof Element && event.target.closest("dialog, [role='dialog']") === event.currentTarget) { event.preventDefault(); event.stopPropagation(); setOpenPanel(null); }
        }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && !pending) { event.preventDefault(); setOpenPanel(null); return; }
          trapOverlayFocus(event);
        }}>
          <header><span>{({ project: projectPicker.creating ? "新建工程" : "打开工程", canvas: canvasAction === "add" ? "新建画布" : "重命名画布", settings: "工作台设置", history: "历史记录", collaboration: "多人协作" })[openPanel]}</span><button type="button" disabled={pending} onClick={() => setOpenPanel(null)} aria-label="关闭面板"><IconX aria-hidden="true" focusable="false" size={19} /></button></header>
          {openPanel === "project" && <ProjectPicker creating={projectPicker.creating} initialDirectory={projectPicker.directory} pending={pending} onOpen={openDirectory} onToggleCreating={() => setProjectPicker(current => ({ ...current, creating: !current.creating }))}>{!projectPicker.creating && recentProjectList}</ProjectPicker>}
          {openPanel === "canvas" && <form className="projectForm" onSubmit={event => { event.preventDefault(); void run(async () => { if (canvasAction === "add") await controller.addCanvas(canvasName.trim() || undefined); else { const current = controller.getSnapshot(); if (!canvasRenameTarget || current.directory !== canvasRenameTarget.directory || current.canvasId !== canvasRenameTarget.canvasId) throw new Error("画布已切换，请重新打开改名对话框"); await controller.renameCanvas(canvasName.trim(), canvasRenameTarget.fileRevision); } setOpenPanel(null); }); }}><label htmlFor="canvasName">画布名称</label><input id="canvasName" autoFocus value={canvasName} onChange={event => setCanvasName(event.target.value)} autoComplete="off" disabled={pending} /><button type="submit" disabled={pending || (canvasAction === "rename" && !canvasName.trim())}>{canvasAction === "add" ? "创建画布" : "保存名称"}</button></form>}
          {openPanel === "settings" && <SettingsPanel controller={controller} initialTab={settingsTab} />}
          {openPanel === "collaboration" && CollaborationPanel && <CollaborationPanel service={collaboration.service} />}
          {openPanel === "history" && history && <div className="historyPanelBody"><div className="historySummary"><span>{history.mode === "collaboration" ? "协作会话历史" : "当前编辑会话"}</span><span>修订 {history.revision} · 已保存 {history.savedRevision}</span></div><div className="historyActions"><button type="button" disabled={!snapshot.canUndo || pending || editingLocked} onClick={() => void run(() => controller.undo())}><IconArrowBackUp aria-hidden="true" focusable="false" size={16} />撤销</button><button type="button" disabled={!snapshot.canRedo || pending || editingLocked} onClick={() => void run(() => controller.redo())}><IconArrowForwardUp aria-hidden="true" focusable="false" size={16} />重做</button></div>{history.entries.map(entry => <div className="historyEntry" key={`${entry.direction}:${entry.steps}`}><IconHistory aria-hidden="true" focusable="false" size={16} /><span>{entry.direction === "undo" ? "回退" : "重做"}第 {entry.steps} 步</span><small>{entry.nodes} 节点 · {entry.edges} 连线</small></div>)}</div>}
        </MotionLayer>
      </MotionLayer>}</AnimatePresence>

      <AnimatePresence>{(error || snapshot.error) && <MotionLayer key="error" kind="fade" className="workspaceError" role="alert"><span>{error || snapshot.error}</span>{error && <button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><IconX aria-hidden="true" focusable="false" size={16} /></button>}</MotionLayer>}</AnimatePresence>
    </div>
  </div>;
}

export default function Workbench({ controller }: { controller: WorkbenchController }) {
  return <WorkbenchMotion><ReactFlowProvider><WorkbenchWorkspace controller={controller} /></ReactFlowProvider></WorkbenchMotion>;
}

export type { WorkbenchController, WorkbenchNodeViewProps, WorkbenchSnapshot } from "./types";
