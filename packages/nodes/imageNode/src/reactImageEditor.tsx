import NodeIcon from "@toonflow/node-shared/reactIcon";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { errorText, readMedia, useMediaUrl, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import { canvasBlob, drawImageStrokes, readImageSnapshot, type ImageStroke } from "./reactImageProcessing";
import { imageEditor, strokesSchema } from "./imageEditor";
import { useEditorSession } from "@toonflow/node-shared/editorSession";
import { lightingPresets, readLightingSettings } from "./imageLighting";
import { multiAnglePresets, readMultiAngleSettings } from "./imageMultiAngle";
import ImageStage from "./reactImageStage";
import PanoramaPreview from "./reactPanoramaPreview";
import type { PanoramaSettings } from "./panoramaRenderer";
import "./imageWorkbench.scss";

const imageTasks = [
  { id: "mark", label: "局部重绘 / 标记", icon: "brush" }, { id: "crop", label: "裁剪 / 变换", icon: "cut" },
  { id: "grid", label: "宫格切分", icon: "grid" }, { id: "lighting", label: "打光", icon: "generate" },
  { id: "angle", label: "机位", icon: "camera" }, { id: "panorama", label: "全景", icon: "expand" },
] as const;
type ImageTask = typeof imageTasks[number]["id"];
type CropRect = { x: number; y: number; width: number; height: number };
type CropCorner = "nw" | "ne" | "sw" | "se";
const cropCorners: { id: CropCorner; label: string }[] = [{ id: "nw", label: "左上角" }, { id: "ne", label: "右上角" }, { id: "sw", label: "左下角" }, { id: "se", label: "右下角" }];
const panoramaCorrections = [
  { key: "lensEnabled", label: "镜头畸变", fields: [["lensStrength", "强度", 0, 100, 40]] },
  { key: "perspectiveEnabled", label: "透视与水平", fields: [["horizontalPerspective", "水平透视", -40, 40, 0], ["verticalPerspective", "垂直透视", -40, 40, 0], ["levelRotation", "水平旋转", -15, 15, 0]] },
  { key: "stretchEnabled", label: "环绕拉伸", fields: [["horizontalStretch", "水平拉伸", -50, 50, 0], ["verticalStretch", "垂直拉伸", -50, 50, 0], ["stretchCenter", "中心方向", 0, 360, 0]] },
  { key: "horizonEnabled", label: "地平线", fields: [["horizonOffset", "高度偏移", -12, 12, 0], ["waveAmplitude", "起伏强度", -12, 12, 0], ["wavePhase", "起伏方向", 0, 360, 0], ["waveCount", "起伏次数", 1, 4, 1]] },
  { key: "seamEnabled", label: "首尾接缝", fields: [["seamWidth", "融合范围", .5, 8, 3]] },
] as const;
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

export default function ImageEditor({ node, controller, readOnly, toolbar }: NodeViewProps & { toolbar?: boolean }) {
  const source = readMedia(node.data, "image");
  const { url, error: mediaError } = useMediaUrl(controller, source);
  const draft = imageEditor(controller.getNodeService(node.id), source?.url ?? "", node.data);
  const { value: state } = useEditorSession(draft);
  const history = draft.history;
  const setField = <K extends keyof typeof state>(key: K, value: typeof state[K]) => draft.replace({ ...draft.read().value, [key]: value });
  const open = state.open, task = state.task, rows = state.rows, columns = state.columns, lighting = state.lighting, angle = state.angle, panorama = state.panorama, crop = state.crop;
  const setOpen = (value: boolean) => setField("open", value), setTask = (value: ImageTask) => setField("task", value);
  const setRows = (value: number) => { if (Number.isInteger(value) && value >= 1 && value <= 10) setField("rows", value); }, setColumns = (value: number) => { if (Number.isInteger(value) && value >= 1 && value <= 10) setField("columns", value); };
  const setLighting = (value: typeof lighting) => setField("lighting", value), setAngle = (value: typeof angle) => setField("angle", value);
  const setPanorama = (value: typeof panorama) => setField("panorama", value), setCrop = (value: CropRect) => setField("crop", value);
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null), cropFrame = useRef<HTMLDivElement>(null);
  const [dialogRoot, setDialogRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setDialogRoot(document.querySelector<HTMLElement>(".openCinemaWorkbench") ?? document.body); }, []);
  const original = useRef<HTMLCanvasElement | undefined>(undefined);
  const strokes = useRef<ImageStroke[]>([]), strokeCount = useRef(0), active = useRef<ImageStroke | undefined>(undefined);
  const markPointer = useRef<number | undefined>(undefined);
  const stagePointer = useRef<{ element: HTMLElement; id: number } | undefined>(undefined);
  const wheelGestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cropDrag = useRef<{ pointerId: number; mode: "draw" | "move" | CropCorner; origin: { x: number; y: number }; crop: CropRect } | undefined>(undefined);
  strokes.current = state.strokes; strokeCount.current = state.strokeCount;
  const [opened, setOpened] = useState(false);
  const [visited, setVisited] = useState<Set<ImageTask>>(() => new Set(["mark"]));
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [editorUrl, setEditorUrl] = useState("");
  const [loadedSourceRevision, setLoadedSourceRevision] = useState("");
  const [sourceReload, setSourceReload] = useState(0);
  const activeUrl = editorUrl || url;
  const [version, setVersion] = useState(0), [color, setColor] = useState("#ff3333"), [width, setWidth] = useState(16);
  const [tool, setTool] = useState<NonNullable<ImageStroke["tool"]>>("brush"), [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const locked = readOnly || busy || !dimensions.width || !state.sourceRevision || loadedSourceRevision !== state.sourceRevision;
  const imageStyle = { "--imageRatio": dimensions.width / Math.max(1, dimensions.height) } as CSSProperties;
  useEffect(() => { if (state.sourceRevision && loadedSourceRevision && state.sourceRevision !== loadedSourceRevision) setSourceReload(value => value + 1); }, [state.sourceRevision]);
  useEffect(() => { setLighting(readLightingSettings(node.data?.lighting)); }, [JSON.stringify(node.data?.lighting)]);
  useEffect(() => { setAngle(readMultiAngleSettings(node.data?.multiAngle)); }, [JSON.stringify(node.data?.multiAngle)]);
  useEffect(() => { if (open) setOpened(true); setVisited(previous => new Set([...previous, task])); const element = dialog.current; if (open && element && !element.open) element.showModal(); else if (!open && element?.open) element.close(); }, [open, task, url, dialogRoot]);
  useEffect(() => () => dialog.current?.close(), []);
  useEffect(() => () => { if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current); draft.endGesture(); }, [draft]);
  function finishControlGesture() {
    if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
    wheelGestureTimer.current = undefined; draft.endGesture();
  }
  function redraw() {
    const element = canvas.current, image = original.current;
    if (!element || !image) return;
    const painter = element.getContext("2d"); if (!painter) return;
    painter.clearRect(0, 0, element.width, element.height); painter.drawImage(image, 0, 0);
    drawImageStrokes(element, [...strokes.current.slice(0, strokeCount.current), ...(active.current ? [active.current] : [])]);
  }
  function commit(stroke: ImageStroke) {
    if ((stroke.tool === "rectangle" || stroke.tool === "circle") && (!stroke.points[1] || Math.abs(stroke.points[1].x - stroke.points[0]!.x) * dimensions.width < 1 || Math.abs(stroke.points[1].y - stroke.points[0]!.y) * dimensions.height < 1)) return;
    const next = [...strokes.current.slice(0, strokeCount.current), stroke];
    if (!strokesSchema.safeParse(next).success) { setError("标记数量已达上限，请清除部分标记后继续"); return; }
    draft.replace({ ...draft.read().value, strokes: next, strokeCount: next.length }, undefined, stroke.tool === "eraser" ? "擦除标记" : stroke.tool === "text" ? "添加文字" : "绘制标记");
    setNotice(""); setVersion(value => value + 1);
  }
  useEffect(() => {
    let disposed = false;
    const operation = new AbortController(); let imageUrl = "";
    original.current = undefined; active.current = undefined;
    if (draft.read().value.source !== source?.url) draft.replace({ ...draft.read().value, source: source?.url ?? "", sourceRevision: null, strokes: [], strokeCount: 0, crop: { x: 0, y: 0, width: 1, height: 1 } });
    setDimensions({ width: 0, height: 0 }); setLoadedSourceRevision(""); setEditorUrl(""); setVersion(value => value + 1);
    if (!opened || !source) return;
    void readImageSnapshot(controller.getNodeService(node.id), source, operation.signal).then(async ({ canvas: image, revision }) => {
      if (disposed || !canvas.current) return;
      imageUrl = URL.createObjectURL(await canvasBlob(image)); if (disposed) { URL.revokeObjectURL(imageUrl); return; }
      original.current = image; canvas.current.width = image.width; canvas.current.height = image.height;
      const stored = draft.read().value;
      if (stored.sourceRevision === null) draft.replace({ ...stored, sourceRevision: revision });
      setLoadedSourceRevision(revision); setEditorUrl(imageUrl);
      setDimensions({ width: image.width, height: image.height }); setError(stored.sourceRevision && stored.sourceRevision !== revision ? "源图片文件已变化，旧选区草稿保留但不能采用；请重新观察图片并明确建立新草稿" : ""); redraw();
    }).catch(reason => { if (!disposed) setError(errorText(reason)); });
    return () => { disposed = true; operation.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); original.current = undefined; };
  }, [url, opened, sourceReload]);
  useEffect(redraw, [version, url, state.strokes, state.strokeCount]);
  function cancelPointerEdit() {
    const marking = !!active.current;
    active.current = undefined;
    const cropPointer = cropDrag.current?.pointerId;
    const stage = stagePointer.current; stagePointer.current = undefined;
    if (cropDrag.current || marking || stage) { cropDrag.current = undefined; draft.cancelGesture(); }
    if (cropPointer !== undefined && cropFrame.current?.hasPointerCapture(cropPointer)) cropFrame.current.releasePointerCapture(cropPointer);
    const pointer = markPointer.current;
    markPointer.current = undefined;
    if (pointer !== undefined && canvas.current?.hasPointerCapture(pointer)) canvas.current.releasePointerCapture(pointer);
    if (stage?.element.hasPointerCapture(stage.id)) stage.element.releasePointerCapture(stage.id);
    redraw();
  }
  function close() {
    if (busy) return;
    cancelPointerEdit(); finishControlGesture(); dialog.current?.close(); setOpen(false);
  }
  function changeHistory(direction: "undo" | "redo") {
    if (locked || active.current || cropDrag.current || stagePointer.current) return;
    finishControlGesture();
    const label = direction === "undo" ? draft.history.undoLabel : draft.history.redoLabel;
    if (!label) return;
    draft[direction](); setError(""); setNotice(`已${direction === "undo" ? "撤销" : "重做"}：${label}`);
  }
  function editorKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === "Escape" && (active.current || cropDrag.current || stagePointer.current)) { event.preventDefault(); cancelPointerEdit(); return; }
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("textarea, input:not([type='range']):not([type='color']):not([type='checkbox']):not([type='radio'])"))) return;
    event.preventDefault(); changeHistory(key === "y" || event.shiftKey ? "redo" : "undo");
  }
  function chooseTask(next: ImageTask) { finishControlGesture(); setTask(next); setVisited(previous => new Set([...previous, next])); setNotice(""); }
  async function call(name: string, args: Record<string, unknown>, handoff = false) {
    if (locked) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await controller.callNodeTool(node.id, name, { ...args, ...(name === "setImageEditSettings" ? {} : { sourceRevision: draft.read().value.sourceRevision }) });
      if (handoff) {
        const childId = (result as { nodeId?: unknown } | undefined)?.nodeId;
        if (typeof childId !== "string" || !childId) throw new Error("未取得新创作节点");
        const service = controller.getNodeService(childId), prompt = service.readNodes().find(value => value.id === childId)?.data?.prompt;
        close();
        try { service.focusComposer(typeof prompt === "string" ? { prompt } : {}); } catch (reason) { setOpen(true); throw reason; }
      } else setNotice(name === "setImageEditSettings" ? "设置已保存" : "已创建新副本，原图保留");
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); requestAnimationFrame(() => { if (dialog.current?.open) dialog.current.querySelector<HTMLElement>(".imageWorkbenchFeedback")?.focus(); }); }
  }
  function point(event: PointerEvent<HTMLCanvasElement>) { const bounds = event.currentTarget.getBoundingClientRect(); return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) }; }
  const minCropWidth = 1 / Math.max(1, dimensions.width), minCropHeight = 1 / Math.max(1, dimensions.height);
  function normalizeCrop(next: CropRect) {
    const width = clamp(Number.isFinite(next.width) ? next.width : crop.width, minCropWidth, 1), height = clamp(Number.isFinite(next.height) ? next.height : crop.height, minCropHeight, 1);
    return { x: clamp(Number.isFinite(next.x) ? next.x : crop.x, 0, 1 - width), y: clamp(Number.isFinite(next.y) ? next.y : crop.y, 0, 1 - height), width, height };
  }
  function cropPoint(event: PointerEvent<HTMLElement>) { const bounds = cropFrame.current!.getBoundingClientRect(); return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) }; }
  function startCrop(event: PointerEvent<HTMLElement>, mode: "draw" | "move" | CropCorner) {
    if (locked || event.button !== 0 || !event.isPrimary || cropDrag.current || !cropFrame.current) return;
    event.preventDefault(); event.stopPropagation(); draft.beginGesture("调整裁剪"); cropDrag.current = { pointerId: event.pointerId, mode, origin: cropPoint(event), crop }; cropFrame.current.setPointerCapture(event.pointerId);
  }
  function resizeCrop(rect: CropRect, corner: CropCorner, x: number, y: number) {
    let left = rect.x, right = left + rect.width, top = rect.y, bottom = top + rect.height;
    if (corner.includes("w")) left = clamp(x, 0, right - minCropWidth); else right = clamp(x, left + minCropWidth, 1);
    if (corner.includes("n")) top = clamp(y, 0, bottom - minCropHeight); else bottom = clamp(y, top + minCropHeight, 1);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  function moveCrop(event: PointerEvent<HTMLDivElement>) {
    const drag = cropDrag.current; if (!drag || event.pointerId !== drag.pointerId || locked) return;
    const current = cropPoint(event);
    if (drag.mode === "move") setCrop(normalizeCrop({ ...drag.crop, x: drag.crop.x + current.x - drag.origin.x, y: drag.crop.y + current.y - drag.origin.y }));
    else if (drag.mode === "draw") setCrop(normalizeCrop({ x: Math.min(current.x, drag.origin.x), y: Math.min(current.y, drag.origin.y), width: Math.abs(current.x - drag.origin.x), height: Math.abs(current.y - drag.origin.y) }));
    else setCrop(resizeCrop(drag.crop, drag.mode, current.x, current.y));
  }
  function nudgeCrop(event: KeyboardEvent<HTMLElement>, corner?: CropCorner) {
    if (locked || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); draft.beginGesture("微调裁剪"); const step = event.shiftKey ? 10 : 1;
    const dx = (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0) / Math.max(1, dimensions.width), dy = (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) / Math.max(1, dimensions.height);
    setCrop(corner ? resizeCrop(crop, corner, crop.x + (corner.includes("w") ? 0 : crop.width) + dx, crop.y + (corner.includes("n") ? 0 : crop.height) + dy) : normalizeCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }));
  }
  function frameCrop(ratio?: number) {
    if (!ratio) { setCrop({ x: 0, y: 0, width: 1, height: 1 }); return; }
    const relative = ratio / (dimensions.width / dimensions.height), width = Math.min(1, relative), height = Math.min(1, 1 / relative);
    setCrop({ x: (1 - width) / 2, y: (1 - height) / 2, width, height });
  }
  function range(label: string, value: number, min: number, max: number, change: (value: number) => void, step = 1) {
    return <label className="nodeField"><span>{label}<output>{value}</output></span><input type="range" min={min} max={max} step={step} value={value} disabled={locked} onChange={event => change(Number(event.target.value))} /></label>;
  }
  const drawing = strokes.current.slice(0, strokeCount.current), lastClear = drawing.findLastIndex(stroke => stroke.tool === "clear");
  const hasDrawing = drawing.slice(lastClear + 1).some(stroke => stroke.tool !== "eraser");
  const gridValid = Number.isInteger(rows) && Number.isInteger(columns) && rows >= 1 && rows <= 10 && columns >= 1 && columns <= 10;
  if (!source || !url) return null;
  return <><button type="button" className={toolbar ? "nodeMediaTool nodeMediaToolPrimary" : "nodeComposerAction imageEditorEntry"} title="打开图片编辑台" aria-label="编辑图片" disabled={readOnly || busy} onClick={() => { setOpened(true); setOpen(true); }}><NodeIcon name="brush" />{!toolbar && "编辑图片"}</button>
    {dialogRoot && createPortal(<dialog ref={dialog} className="nodeControls imageWorkbenchDialog nodrag nopan nowheel" aria-label="图片编辑台" aria-busy={busy}
      onClose={() => setOpen(false)} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={editorKeyDown}
      onKeyDownCapture={event => {
        if (task === "mark" || locked || event.ctrlKey || event.metaKey || !(event.target instanceof HTMLElement)) return;
        const direction = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "+", "=", "-"].includes(event.key);
        const typing = event.target.matches("input[type='number'], input[type='text'], textarea") && (event.key.length === 1 || ["Backspace", "Delete"].includes(event.key) || direction);
        if (typing || direction && (event.target.matches("input[type='range']") || event.target.closest(".imagePanoramaStage"))) draft.beginGesture();
      }}
      onKeyUpCapture={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Enter", "+", "=", "-"].includes(event.key) && !cropDrag.current && !active.current && !stagePointer.current) finishControlGesture(); }}
      onFocusCapture={event => { if (task !== "mark" && !locked && event.target instanceof HTMLElement && event.target.matches("input, select, textarea")) draft.beginGesture(); }}
      onBlurCapture={() => { if (!cropDrag.current && !active.current && !stagePointer.current) finishControlGesture(); }} onPointerDownCapture={event => {
        if (wheelGestureTimer.current) finishControlGesture();
        if (task === "mark" || locked || event.button !== 0 || !event.isPrimary || !(event.target instanceof HTMLElement)) return;
        const stage = event.target.closest<HTMLElement>(".imageSpatialStage canvas, .imagePanoramaStage");
        if (stage) stagePointer.current = { element: stage, id: event.pointerId };
        if (stage || event.target.matches("input[type='range']")) draft.beginGesture();
      }} onPointerUpCapture={event => {
        if (stagePointer.current && stagePointer.current.id !== event.pointerId) return;
        const stage = stagePointer.current;
        stagePointer.current = undefined;
        if (!cropDrag.current && !active.current && (stage || event.target instanceof HTMLElement && event.target.matches("input[type='range']"))) finishControlGesture();
      }} onPointerCancelCapture={() => { if (stagePointer.current) cancelPointerEdit(); else if (!cropDrag.current && !active.current) draft.cancelGesture(); }}
      onLostPointerCaptureCapture={event => { if (stagePointer.current?.id === event.pointerId) cancelPointerEdit(); }}
      onWheelCapture={event => {
        if (locked || !(event.target instanceof HTMLElement) || !event.target.closest(".imagePanoramaStage")) return;
        draft.beginGesture("调整全景视野");
        if (wheelGestureTimer.current) clearTimeout(wheelGestureTimer.current);
        wheelGestureTimer.current = setTimeout(() => { wheelGestureTimer.current = undefined; draft.endGesture(); }, 180);
      }} onPointerDown={event => { if (event.target === event.currentTarget) close(); }}>
      <header className="imageWorkbenchHeader"><div><strong>图片编辑</strong><span>{String(node.data?.label ?? "图片")}{dimensions.width > 0 ? ` · ${dimensions.width} × ${dimensions.height}` : ""}</span></div><div className="imageWorkbenchHeaderActions"><div className="imageHistoryToolbar" role="toolbar" aria-label="图片编辑历史">
        <button type="button" aria-label="撤销图片编辑" aria-keyshortcuts="Meta+Z Control+Z" title={`${history.undoLabel ? `撤销：${history.undoLabel}` : "撤销"}（⌘/Ctrl Z）`} disabled={locked || !history.canUndo} onClick={() => changeHistory("undo")}><NodeIcon name="undo" /></button>
        <button type="button" aria-label="重做图片编辑" aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y" title={`${history.redoLabel ? `重做：${history.redoLabel}` : "重做"}（⌘/Ctrl ⇧ Z）`} disabled={locked || !history.canRedo} onClick={() => changeHistory("redo")}><NodeIcon name="redo" /></button>
      </div><button type="button" title="关闭图片编辑台，保留当前工作台草稿" aria-label="关闭图片编辑台" disabled={busy} onClick={close}><NodeIcon name="close" /></button></div></header>
      <nav className="imageWorkbenchTasks" role="tablist" aria-label="图片编辑任务">{imageTasks.map(item => <button key={item.id} id={`imageTask${node.id}${item.id}`} type="button" role="tab" aria-selected={task === item.id} aria-controls={`imagePanel${node.id}${item.id}`} tabIndex={task === item.id ? 0 : -1} disabled={busy} onClick={() => chooseTask(item.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const index = imageTasks.findIndex(value => value.id === item.id), next = event.key === "Home" ? 0 : event.key === "End" ? imageTasks.length - 1 : (index + (event.key === "ArrowLeft" ? imageTasks.length - 1 : 1)) % imageTasks.length;
        chooseTask(imageTasks[next]!.id); (event.currentTarget.parentElement?.querySelectorAll("button")[next] as HTMLButtonElement | undefined)?.focus();
      }}><NodeIcon name={item.icon} />{item.label}</button>)}</nav>
      <section className="imageWorkbenchPanel" id={`imagePanel${node.id}mark`} role="tabpanel" aria-labelledby={`imageTask${node.id}mark`} hidden={task !== "mark"}>
        <div className="imageWorkbenchStage"><div className="imageWorkbenchImage" style={imageStyle}><canvas ref={canvas} className="imageMarkCanvas" aria-label="图像标记画布" onPointerDown={event => {
          if (locked || !original.current || event.button !== 0 || !event.isPrimary || active.current) return;
          if (tool === "eraser" && !hasDrawing) return;
          if (strokeCount.current >= 500) { setError("标记数量已达上限，请清除标记后继续"); return; }
          event.stopPropagation(); if (tool === "text") { if (text.trim()) commit({ tool, text, color, width, points: [point(event)] }); return; }
          draft.beginGesture(tool === "eraser" ? "擦除标记" : "绘制标记"); markPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); active.current = { tool, color, width, points: [point(event)] }; redraw();
        }} onPointerMove={event => { if (!active.current || event.pointerId !== markPointer.current || active.current.points.length >= 20000) return; event.stopPropagation(); if (active.current.tool === "rectangle" || active.current.tool === "circle") active.current.points[1] = point(event); else active.current.points.push(point(event)); redraw(); }} onPointerUp={event => {
          if (!active.current || event.pointerId !== markPointer.current) return; event.stopPropagation(); if ((active.current.tool === "rectangle" || active.current.tool === "circle") && active.current.points.length < 2) active.current.points[1] = point(event); commit(active.current); active.current = undefined; markPointer.current = undefined; draft.endGesture(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={cancelPointerEdit} onLostPointerCapture={() => { if (active.current) cancelPointerEdit(); }} /></div></div>
        <aside className="imageWorkbenchControls"><h4>选区与标记</h4><div className="imageToolGrid" role="group" aria-label="标记工具">{([['brush', '画笔'], ['rectangle', '矩形'], ['circle', '圆形'], ['text', '文字'], ['eraser', '橡皮擦']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={tool === key} disabled={locked} onClick={() => setTool(key)}><NodeIcon name={key} />{label}</button>)}</div>
          <label className="nodeField"><span>颜色</span><input type="color" aria-label="标记颜色" value={color} disabled={locked} onChange={event => setColor(event.target.value)} /></label>{range(tool === "text" ? "字号" : "笔宽", width, 1, 200, setWidth)}
          {tool === "text" && <label className="nodeField"><span>标记文字，点击图片放置</span><textarea aria-label="标记文字" value={text} maxLength={2000} disabled={locked} onChange={event => setText(event.target.value)} /></label>}
          <div className="nodeActions"><button type="button" disabled={locked || !hasDrawing} onClick={() => { draft.replace({ ...draft.read().value, strokes: [], strokeCount: 0 }, undefined, "清除标记"); setNotice("已清除标记，可撤销恢复"); }}><NodeIcon name="trash" />清除标记</button></div><p className="imageWorkbenchHint">涂抹需要修改的区域，再到下方描述创作要求；保存标记副本则直接保留画面上的标记。</p>
        </aside>
      </section>
      <section className="imageWorkbenchPanel" id={`imagePanel${node.id}crop`} role="tabpanel" aria-labelledby={`imageTask${node.id}crop`} hidden={task !== "crop"}>
        <div className="imageWorkbenchStage"><div ref={cropFrame} className="imageWorkbenchImage imageCropFrame" style={imageStyle} onPointerDown={event => startCrop(event, "draw")} onPointerMove={moveCrop} onPointerUp={event => { if (cropDrag.current?.pointerId !== event.pointerId) return; cropDrag.current = undefined; draft.endGesture(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={cancelPointerEdit} onLostPointerCapture={() => { if (cropDrag.current) cancelPointerEdit(); }}><img src={activeUrl} alt="裁剪原图" draggable={false} /><div className="imageCropSelection" role="group" aria-label="裁剪选区，方向键移动，Shift加速" tabIndex={0} style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={event => startCrop(event, "move")} onKeyDown={event => nudgeCrop(event)}><span className="imageCropGrid" aria-hidden="true" />{cropCorners.map(corner => <button key={corner.id} type="button" className={`imageCropHandle imageCropHandle${corner.id}`} aria-label={`调整裁剪${corner.label}，方向键微调`} disabled={locked} onPointerDown={event => startCrop(event, corner.id)} onKeyDown={event => nudgeCrop(event, corner.id)} />)}</div></div></div>
        <aside className="imageWorkbenchControls"><h4>裁剪构图</h4><div className="imagePresetGrid"><button type="button" disabled={locked} onClick={() => frameCrop()}>原图</button>{([["1:1", 1], ["16:9", 16 / 9], ["9:16", 9 / 16], ["4:3", 4 / 3], ["3:4", 3 / 4]] as const).map(([label, ratio]) => <button type="button" key={label} disabled={locked} onClick={() => frameCrop(ratio)}>{label}</button>)}</div><output className="imageCropSize">{Math.max(1, Math.round(crop.width * dimensions.width))} × {Math.max(1, Math.round(crop.height * dimensions.height))} px</output><p className="imageWorkbenchHint">拖动选区移动，拖动角点缩放；方向键微调，按住 Shift 加速。</p>
          <details className="nodeDetails"><summary>旋转与翻转副本</summary><div className="nodeActions"><button type="button" disabled={locked} onClick={() => void call("transformImage", { rotation: 90 })}><NodeIcon name="reset" />另存旋转 90°</button><button type="button" disabled={locked} onClick={() => void call("transformImage", { flipX: true })}>另存水平翻转</button><button type="button" disabled={locked} onClick={() => void call("transformImage", { flipY: true })}>另存垂直翻转</button></div></details><details className="nodeDetails"><summary>精确裁剪参数</summary><div className="nodeFields">{([['x', '左边'], ['y', '上边'], ['width', '宽度'], ['height', '高度']] as const).map(([key, label]) => <label className="nodeField" key={key}><span>{label}（0–1）</span><input type="number" min="0" max="1" step=".001" value={crop[key]} disabled={locked} onChange={event => setCrop(normalizeCrop({ ...crop, [key]: Number(event.target.value) }))} /></label>)}</div></details>
        </aside>
      </section>
      <section className="imageWorkbenchPanel" id={`imagePanel${node.id}grid`} role="tabpanel" aria-labelledby={`imageTask${node.id}grid`} hidden={task !== "grid"}>
        <div className="imageWorkbenchStage"><div className="imageWorkbenchImage imageWorkbenchGrid" style={imageStyle}><img src={activeUrl} alt="宫格切分预览" draggable={false} />{gridValid && <div style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>{Array.from({ length: rows * columns }, (_, index) => <span key={index}>{index + 1}</span>)}</div>}</div></div><aside className="imageWorkbenchControls"><h4>宫格切分</h4><div className="imagePresetGrid">{[2, 3, 4].map(count => <button type="button" key={count} disabled={locked} onClick={() => draft.replace({ ...draft.read().value, rows: count, columns: count }, undefined, "调整宫格")}>{count} × {count}</button>)}</div><div className="nodeFields"><label className="nodeField"><span>行数</span><input type="number" min="1" max="10" value={rows} disabled={locked} onChange={event => setRows(Number(event.target.value))} /></label><label className="nodeField"><span>列数</span><input type="number" min="1" max="10" value={columns} disabled={locked} onChange={event => setColumns(Number(event.target.value))} /></label></div><p className="imageWorkbenchHint">切分为独立图片并在画布成组，原图保留。</p></aside>
      </section>
      <section className="imageWorkbenchPanel" id={`imagePanel${node.id}lighting`} role="tabpanel" aria-labelledby={`imageTask${node.id}lighting`} hidden={task !== "lighting"}>
        <div className="imageWorkbenchStage">{visited.has("lighting") && <ImageStage url={activeUrl} mode="lighting" settings={lighting} onChange={setLighting} disabled={locked} />}</div><aside className="imageWorkbenchControls"><h4>灯光设置</h4><label className="nodeField"><span>预设</span><select value={lighting.preset} disabled={locked} onChange={event => { const preset = lightingPresets.find(value => value.id === event.target.value); setLighting(readLightingSettings({ ...lighting, ...preset?.settings, preset: event.target.value })); }}><option value="">自定义</option>{lightingPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
          <div className="imagePresetGrid" role="group" aria-label="主光方向">{([{ label: "前光", azimuth: 0, elevation: 0 }, { label: "左光", azimuth: -90, elevation: 0 }, { label: "右光", azimuth: 90, elevation: 0 }, { label: "背光", azimuth: -180, elevation: 0 }, { label: "顶光", azimuth: 0, elevation: 90 }, { label: "底光", azimuth: 0, elevation: -90 }]).map(direction => <button type="button" key={direction.label} disabled={locked} onClick={() => setLighting({ ...lighting, azimuth: direction.azimuth, elevation: direction.elevation, preset: "" })}>{direction.label}</button>)}</div>{range("亮度", lighting.brightness, 0, 100, value => setLighting({ ...lighting, brightness: value }))}<label className="nodeField"><span>主光颜色</span><input type="color" aria-label="主光颜色" value={lighting.lightColor} disabled={locked} onChange={event => setLighting({ ...lighting, lightColor: event.target.value })} /></label><label className="imageCheckField"><input type="checkbox" checked={lighting.rimLight} disabled={locked} onChange={event => setLighting({ ...lighting, rimLight: event.target.checked })} />轮廓光</label>
          <details className="nodeDetails"><summary>高级灯光参数</summary><div className="imageAdvancedFields">{range("方位角", lighting.azimuth, -180, 180, value => setLighting({ ...lighting, azimuth: value }))}{range("仰角", lighting.elevation, -90, 90, value => setLighting({ ...lighting, elevation: value }))}{lighting.rimLight && <>{range("轮廓光方位", lighting.rimAzimuth, -180, 180, value => setLighting({ ...lighting, rimAzimuth: value }))}{range("轮廓光仰角", lighting.rimElevation, -90, 90, value => setLighting({ ...lighting, rimElevation: value }))}{range("轮廓光强度", lighting.rimBrightness, 0, 100, value => setLighting({ ...lighting, rimBrightness: value }))}<label className="nodeField"><span>轮廓光颜色</span><input type="color" aria-label="轮廓光颜色" value={lighting.rimColor} disabled={locked} onChange={event => setLighting({ ...lighting, rimColor: event.target.value })} /></label></>}<label className="imageCheckField"><input type="checkbox" checked={lighting.smartMode} disabled={locked} onChange={event => setLighting({ ...lighting, smartMode: event.target.checked })} />智能模式</label>{lighting.smartMode && lighting.smartDesc && <div className="nodeField"><span>已保存的打光说明</span><p className="nodeSavedInstruction">{lighting.smartDesc}</p></div>}</div></details>
        </aside>
      </section>
      <section className="imageWorkbenchPanel" id={`imagePanel${node.id}angle`} role="tabpanel" aria-labelledby={`imageTask${node.id}angle`} hidden={task !== "angle"}>
        <div className="imageWorkbenchStage">{visited.has("angle") && <ImageStage url={activeUrl} mode="angle" settings={angle} onChange={setAngle} disabled={locked} />}</div><aside className="imageWorkbenchControls"><h4>参考机位</h4><select aria-label="机位预览方式" value={angle.viewMode} disabled={locked} onChange={event => setAngle({ ...angle, viewMode: event.target.value as typeof angle.viewMode })}><option value="orbit">机位总览</option><option value="camera">相机视角</option></select><div className="imagePresetGrid">{multiAnglePresets.map(preset => <button type="button" key={preset.id} disabled={locked} onClick={() => setAngle({ ...angle, ...preset.settings })}>{preset.label}</button>)}</div>{range("距离", angle.distance, 2, 10, value => setAngle({ ...angle, distance: value }), .1)}<label className="nodeField"><span>镜头</span><select value={angle.lens} disabled={locked} onChange={event => setAngle({ ...angle, lens: event.target.value as typeof angle.lens })}><option value="standard">标准 50 mm</option><option value="wide">广角 24 mm</option></select></label><button type="button" disabled={locked} onClick={() => setAngle(readMultiAngleSettings({ model: angle.model, size: angle.size, ratio: angle.ratio }))}>重置机位</button><details className="nodeDetails"><summary>精确机位参数</summary><div className="imageAdvancedFields">{([['azimuth', '方位角', -180, 180], ['elevation', '俯仰角', -80, 80], ['distance', '距离', 2, 10]] as const).map(([key, label, min, max]) => <label className="nodeField" key={key}><span>{label}</span><input type="number" min={min} max={max} step=".1" value={angle[key]} disabled={locked} onChange={event => setAngle(readMultiAngleSettings({ ...angle, [key]: Number(event.target.value) }))} /></label>)}</div></details></aside>
      </section>
      <section className="imageWorkbenchPanel" id={`imagePanel${node.id}panorama`} role="tabpanel" aria-labelledby={`imageTask${node.id}panorama`} hidden={task !== "panorama"}>
        <div className="imageWorkbenchStage imagePanoramaWorkbench">{visited.has("panorama") && <PanoramaPreview url={activeUrl} settings={panorama} onChange={setPanorama} disabled={locked} />}</div><aside className="imageWorkbenchControls"><h4>全景透视</h4><div className="nodeFields"><label className="nodeField"><span>投影</span><select value={panorama.mode} disabled={locked} onChange={event => setPanorama({ ...panorama, mode: event.target.value as PanoramaSettings["mode"] })}><option value="sphere">球面 720°</option><option value="cylinder">柱面 360°</option></select></label><label className="nodeField"><span>视角数量</span><select value={panorama.count} disabled={locked} onChange={event => setPanorama({ ...panorama, count: Number(event.target.value) as PanoramaSettings["count"] })}>{[1, 4, 12].map(count => <option key={count} value={count}>{count}</option>)}</select></label></div>{range("方位角", panorama.yaw ?? 0, -180, 180, value => setPanorama({ ...panorama, yaw: value }))}{range("俯仰角", panorama.pitch ?? 0, -80, 80, value => setPanorama({ ...panorama, pitch: value }))}{range("视野", panorama.fov ?? 60, 20, 120, value => setPanorama({ ...panorama, fov: value }))}<label className="nodeField"><span>输出方式</span><select value={panorama.layout ?? "separate"} disabled={locked} onChange={event => setPanorama({ ...panorama, layout: event.target.value as PanoramaSettings["layout"] })}><option value="separate">分图并成组</option><option value="combined">拼成一张</option></select></label><details className="nodeDetails"><summary>高级投影校正</summary><div className="imageAdvancedFields">{panoramaCorrections.map(group => <details className="nodeDetails" key={group.key}><summary>{group.label}</summary><label className="imageCheckField"><input type="checkbox" checked={!!panorama[group.key]} disabled={locked} onChange={event => setPanorama({ ...panorama, [group.key]: event.target.checked })} />启用校正</label>{panorama[group.key] && <div className="imageAdvancedFields">{group.fields.map(([key, label, min, max, initial]) => <div key={key}>{range(label, Number(panorama[key] ?? initial), min, max, value => setPanorama({ ...panorama, [key]: value }), key === "waveCount" ? 1 : .5)}</div>)}{group.key === "lensEnabled" && <select aria-label="镜头畸变类型" value={panorama.lensMode ?? "barrel"} disabled={locked} onChange={event => setPanorama({ ...panorama, lensMode: event.target.value as PanoramaSettings["lensMode"] })}><option value="barrel">桶形校正</option><option value="pincushion">枕形校正</option></select>}</div>}</details>)}</div></details></aside>
      </section>
      <footer className="imageWorkbenchFooter"><div className="imageWorkbenchFeedback" tabIndex={-1}>{error || mediaError ? <p className="nodeError" role="alert">{error || mediaError}</p> : <span className="nodeStatus" role="status">{busy ? "正在处理图片…" : notice || "草稿保留在当前工作台，关闭后可继续编辑"}</span>}</div><div className="nodeActions">
        {task === "mark" && <><button type="button" disabled={locked || !hasDrawing} onClick={() => void call("markImage", { strokes: drawing })}>保存标记副本</button><button type="button" className="nodePrimary" disabled={locked || !hasDrawing} onClick={() => void call("createInpaint", { strokes: drawing }, true)}>使用选区创作<NodeIcon name="arrowRight" /></button></>}
        {task === "crop" && <button type="button" className="nodePrimary" disabled={locked} onClick={() => void call("transformImage", { crop })}>保存裁剪副本</button>}
        {task === "grid" && <button type="button" className="nodePrimary" disabled={locked || !gridValid} onClick={() => void call("splitGrid", { rows, columns })}>切分并创建节点组</button>}
        {task === "lighting" && <><button type="button" disabled={locked} onClick={() => void call("setImageEditSettings", { lighting })}>保存设置</button><button type="button" className="nodePrimary" disabled={locked} onClick={() => void call("createLighting", { settings: lighting }, true)}>使用灯光创作<NodeIcon name="arrowRight" /></button></>}
        {task === "angle" && <><button type="button" disabled={locked} onClick={() => void call("setImageEditSettings", { multiAngle: angle })}>保存设置</button><button type="button" className="nodePrimary" disabled={locked} onClick={() => void call("createMultiAngle", { settings: angle }, true)}>使用机位创作<NodeIcon name="arrowRight" /></button></>}
        {task === "panorama" && <button type="button" className="nodePrimary" disabled={locked} onClick={() => void call("capturePanorama", { ...panorama })}><NodeIcon name="camera" />保存全景视角</button>}
      </div></footer>
    </dialog>, dialogRoot)}
  </>;
}
