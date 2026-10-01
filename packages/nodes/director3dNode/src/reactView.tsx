import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import { Raycaster, Vector2 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { getObjectByThreeJsonId, type SceneRuntime } from "threejson/core";
import { errorText, useMediaUrl, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import { createStage, captureCamera, disposeStage, type SceneDocument } from "./scene";
import { prepareSceneAnimation } from "./sceneAnimation";
import { applyCamera, prepareMotion, sampleMotion } from "./motion";
import { directorView } from "./editorView";
import { useEditorSession } from "@toonflow/node-shared/editorSession";
import { mannequinJoints } from "@toonflow/node-shared/director/schema";
import type { DirectorService } from "./reactService";
import "./reactStyles.scss";

type Snapshot = Awaited<ReturnType<DirectorService["read"]>>;
type Props = NodeViewProps & {
  controller: NodeViewProps["controller"] & { getPluginService(id: string): unknown };
};
function DirectorViewport({
  snapshot,
  selected,
  mode,
  time,
  disabled,
  runtimeRef,
  select,
  change,
  freeView,
  aspect,
  pause,
  capture,
  previews,
}: {
  snapshot: Snapshot;
  selected: string;
  mode: "translate" | "rotate" | "scale";
  time: number;
  disabled: boolean;
  runtimeRef: { current: SceneRuntime | undefined };
  select(id: string): void;
  change(id: string, value: Partial<SceneDocument["objectList"][number]>): void;
  freeView: boolean;
  aspect: number;
  pause(): void;
  capture(): void;
  previews(value: Record<string, string>): void;
}) {
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    props = useRef({
      selected,
      mode,
      time,
      disabled,
      select,
      change,
      freeView,
      aspect,
      pause,
      capture,
    });
  const latestSnapshot = useRef(snapshot); latestSnapshot.current = snapshot;
  const previewCallback = useRef(previews); previewCallback.current = previews;
  const refreshPreviews = useRef<(() => void) | undefined>(undefined);
  props.current = {
    selected,
    mode,
    time,
    disabled,
    select,
    change,
    freeView,
    aspect,
    pause,
    capture,
  };
  const [error, setError] = useState("");
  const [lens, setLens] = useState(35),
    [controlling, setControlling] = useState(false),
    [dragLook, setDragLook] = useState(false);
  useEffect(() => {
    let disposed = false,
      frame = 0,
      resize: ResizeObserver | undefined,
      controls: OrbitControls | undefined,
      flight: PointerLockControls | undefined,
      gizmo: TransformControls | undefined,
      runtime: SceneRuntime | undefined,
      animation: ReturnType<typeof prepareSceneAnimation> | undefined;
    let drag = false,
      start = { x: 0, y: 0 },
      manualLook = false,
      lookDragging = false,
      lookPoint = { x: 0, y: 0 };
    const pressed = new Set<string>();
    const movementKeys = new Set([
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "Space",
      "ShiftLeft",
      "ShiftRight",
    ]);
    const exit = () => {
      pressed.clear();
      manualLook = false;
      lookDragging = false;
      setDragLook(false);
      setControlling(false);
      if (flight?.isLocked) flight.unlock();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        event.preventDefault();
        exit();
        return;
      }
      if (
        (!flight?.isLocked && !manualLook) ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !movementKeys.has(event.code)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      pressed.add(event.code);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (movementKeys.has(event.code)) {
        pressed.delete(event.code);
        if (flight?.isLocked || manualLook) event.preventDefault();
      }
    };
    const context = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!props.current.disabled) props.current.capture();
    };
    const lockError = () => {
      if (!props.current.freeView) return;
      manualLook = true;
      setDragLook(true);
      setControlling(true);
      setError("");
      canvas.current?.focus({ preventScroll: true });
    };
    const wheel = (event: WheelEvent) => {
      if (!runtime || !props.current.freeView || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      props.current.pause();
      const steps = [12, 16, 18, 21, 24, 28, 35, 40, 50, 65, 75, 85, 100, 135, 180, 200];
      const current = runtime.camera.getFocalLength();
      runtime.camera.setFocalLength(
        event.deltaY < 0
          ? (steps.find((value) => value > current + 0.000001) ?? steps.at(-1)!)
          : (steps.findLast((value) => value < current - 0.000001) ?? steps[0]!),
      );
      setLens(runtime.camera.getFocalLength());
    };
    const pointerDown = (event: PointerEvent) => {
      start = { x: event.clientX, y: event.clientY };
      if (manualLook && props.current.freeView && event.button === 0) {
        lookDragging = true;
        lookPoint = { x: event.clientX, y: event.clientY };
        canvas.current?.setPointerCapture(event.pointerId);
      }
    };
    const pointerMove = (event: PointerEvent) => {
      if (!runtime || !manualLook || !lookDragging || !props.current.freeView) return;
      runtime.camera.rotation.reorder("YXZ");
      runtime.camera.rotation.y -= (event.clientX - lookPoint.x) * 0.002;
      runtime.camera.rotation.x = Math.max(
        -Math.PI / 2,
        Math.min(Math.PI / 2, runtime.camera.rotation.x - (event.clientY - lookPoint.y) * 0.002),
      );
      lookPoint = { x: event.clientX, y: event.clientY };
    };
    const pointerUp = (event: PointerEvent) => {
      if (props.current.freeView) {
        if (event.button !== 0) return;
        props.current.pause();
        if (manualLook) {
          lookDragging = false;
          if (canvas.current?.hasPointerCapture(event.pointerId))
            canvas.current.releasePointerCapture(event.pointerId);
          return;
        }
        if (flight?.isLocked) exit();
        else {
          canvas.current?.focus({ preventScroll: true });
          try {
            flight?.lock();
          } catch {
            lockError();
          }
        }
        return;
      }
      if (event.button !== 0) return;
      if (
        !runtime ||
        drag ||
        gizmo?.axis ||
        Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4
      )
        return;
      const bounds = canvas.current!.getBoundingClientRect(),
        raycaster = new Raycaster();
      raycaster.setFromCamera(
        new Vector2(
          ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
          1 - ((event.clientY - bounds.top) / bounds.height) * 2,
        ),
        runtime.camera,
      );
      for (const hit of raycaster.intersectObjects(runtime.scene.children, true)) {
        const object = snapshot.document.scene.objectList.find((item) => {
          const root = getObjectByThreeJsonId(item.threeJsonId, runtime!.scene);
          for (let candidate = hit.object; candidate; candidate = candidate.parent!)
            if (root === candidate) return true;
          return false;
        });
        if (object) {
          props.current.select(object.threeJsonId);
          return;
        }
      }
      props.current.select("");
    };
    void createStage(
      canvas.current!,
      snapshot.document.scene,
      undefined,
      props.current.aspect,
      snapshot.lighting,
      snapshot.sceneSettings,
    )
      .then((value) => {
        if (disposed) {
          disposeStage(value);
          return;
        }
        runtime = value;
        runtimeRef.current = value;
        setError("");
        controls = new OrbitControls(value.camera, canvas.current!);
        flight = new PointerLockControls(value.camera, canvas.current!);
        flight.addEventListener("lock", () => {
          setControlling(true);
          if (controls) controls.enabled = false;
        });
        flight.addEventListener("unlock", () => {
          setControlling(false);
          pressed.clear();
          if (controls) controls.enabled = !props.current.freeView;
        });
        const target = snapshot.document.scene.sceneConfig.controls.target;
        controls.target.set(target.x, target.y, target.z);
        controls.update();
        gizmo = new TransformControls(value.camera, canvas.current!);
        value.scene.add(gizmo.getHelper());
        gizmo.addEventListener("dragging-changed", (event) => {
          drag = Boolean(event.value);
          if (controls) controls.enabled = !drag && !props.current.freeView;
        });
        gizmo.addEventListener("mouseUp", () => {
          const object = gizmo!.object;
          if (!object || props.current.disabled || !props.current.selected) return;
          props.current.change(props.current.selected, {
            position: { x: object.position.x, y: object.position.y, z: object.position.z },
            rotation: {
              rotationX: object.rotation.x,
              rotationY: object.rotation.y,
              rotationZ: object.rotation.z,
            },
            scale: { scaleX: object.scale.x, scaleY: object.scale.y, scaleZ: object.scale.z },
          });
        });
        const plan = snapshot.document.plans.find((item) => item.id === snapshot.selectedPlanId);
        if (plan) animation = prepareSceneAnimation(value, plan);
        const cameraFrames = plan ? prepareMotion(plan.cameraFrames) : undefined;
        const capturePreviews = () => {
          const original = captureCamera(value), originalAspect = value.camera.aspect;
          const helper = gizmo!.getHelper(), helperVisible = helper.visible;
          const thumbnail = document.createElement("canvas"), result: Record<string, string> = {};
          thumbnail.width = 192; thumbnail.height = Math.round(192 / props.current.aspect);
          try {
            helper.visible = false;
            value.camera.aspect = props.current.aspect; value.camera.updateProjectionMatrix();
            for (const anchor of latestSnapshot.current.anchors) {
              animation?.setTime(Math.min(plan?.duration ?? 0, anchor.time ?? 0));
              applyCamera(value.camera, anchor);
              value.renderer.render(value.scene, value.camera);
              thumbnail.getContext("2d")!.drawImage(value.renderer.domElement, 0, 0, thumbnail.width, thumbnail.height);
              result[anchor.id] = thumbnail.toDataURL("image/jpeg", .75);
            }
            previewCallback.current(result);
          } catch (failure) { previewCallback.current({}); setError(errorText(failure)); }
          finally {
            animation?.setTime(props.current.time); applyCamera(value.camera, original);
            value.camera.aspect = originalAspect; value.camera.updateProjectionMatrix();
            helper.visible = helperVisible;
            value.renderer.render(value.scene, value.camera);
          }
        };
        refreshPreviews.current = capturePreviews;
        capturePreviews();
        let previousTime = performance.now();
        const draw = () => {
          if (disposed) return;
          const next = props.current,
            width = container.current!.clientWidth,
            height = container.current!.clientHeight;
          if (width && height) {
            const fittedWidth = Math.min(width, height * next.aspect),
              fittedHeight = fittedWidth / next.aspect;
            value.renderer.setSize(fittedWidth, fittedHeight, false);
            canvas.current!.style.width = `${fittedWidth}px`;
            canvas.current!.style.height = `${fittedHeight}px`;
            value.camera.aspect = next.aspect;
            value.camera.updateProjectionMatrix();
          }
          if (!next.freeView && (flight?.isLocked || manualLook)) exit();
          controls!.enabled = !drag && !next.freeView;
          const now = performance.now(),
            delta = Math.min(0.1, (now - previousTime) / 1000);
          previousTime = now;
          if (flight && (flight.isLocked || manualLook)) {
            const speed = 4 * delta;
            flight.moveForward((Number(pressed.has("KeyW")) - Number(pressed.has("KeyS"))) * speed);
            flight.moveRight((Number(pressed.has("KeyD")) - Number(pressed.has("KeyA"))) * speed);
            value.camera.position.y +=
              (Number(pressed.has("Space")) -
                Number(pressed.has("ShiftLeft") || pressed.has("ShiftRight"))) *
              speed;
          }
          gizmo!.enabled = !next.disabled && !next.freeView;
          gizmo!.setMode(next.mode);
          const object = next.selected
            ? getObjectByThreeJsonId(next.selected, value.scene)
            : undefined;
          if (object && !next.disabled && !plan && !next.freeView) {
            if (gizmo!.object !== object) gizmo!.attach(object);
          } else gizmo!.detach();
          if (animation && plan) {
            animation.setTime(next.time);
            if (cameraFrames && !next.freeView) sampleMotion(value.camera, cameraFrames, next.time);
          } else {
            const target = value.camera.userData.directorTarget;
            if (target) {
              controls!.target.set(target.x, target.y, target.z);
              delete value.camera.userData.directorTarget;
            }
            if (!next.freeView) controls!.update();
          }
          value.renderer.render(value.scene, value.camera);
          frame = requestAnimationFrame(draw);
        };
        canvas.current!.addEventListener("pointerdown", pointerDown);
        canvas.current!.addEventListener("pointerup", pointerUp);
        canvas.current!.addEventListener("pointermove", pointerMove);
        canvas.current!.addEventListener("contextmenu", context);
        canvas.current!.addEventListener("keydown", keyDown);
        canvas.current!.addEventListener("keyup", keyUp);
        canvas.current!.addEventListener("blur", exit);
        canvas.current!.addEventListener("wheel", wheel, { passive: false });
        document.addEventListener("pointerlockerror", lockError);
        resize = new ResizeObserver(() => value.invalidate());
        resize.observe(container.current!);
        draw();
      })
      .catch((failure) => {
        if (!disposed) setError(errorText(failure));
      });
    return () => {
      disposed = true;
      refreshPreviews.current = undefined;
      cancelAnimationFrame(frame);
      resize?.disconnect();
      canvas.current?.removeEventListener("pointerdown", pointerDown);
      canvas.current?.removeEventListener("pointerup", pointerUp);
      canvas.current?.removeEventListener("pointermove", pointerMove);
      canvas.current?.removeEventListener("contextmenu", context);
      canvas.current?.removeEventListener("keydown", keyDown);
      canvas.current?.removeEventListener("keyup", keyUp);
      canvas.current?.removeEventListener("blur", exit);
      canvas.current?.removeEventListener("wheel", wheel);
      document.removeEventListener("pointerlockerror", lockError);
      exit();
      flight?.dispose();
      controls?.dispose();
      gizmo?.dispose();
      animation?.dispose();
      if (runtime) disposeStage(runtime);
      if (runtimeRef.current === runtime) runtimeRef.current = undefined;
    };
  }, [
    snapshot.revision,
    snapshot.selectedPlanId,
    JSON.stringify(snapshot.lighting),
    JSON.stringify(snapshot.sceneSettings),
  ]);
  useEffect(() => { refreshPreviews.current?.(); }, [snapshot.anchors, aspect]);
  return (
    <div className="directorReactViewport" ref={container}>
      <canvas tabIndex={0} ref={canvas} aria-label="导演台三维场景" />
      {freeView && (
        <small className="directorFlightInfo">
          {controlling
            ? `${dragLook ? "鼠标锁定不可用，按住左键拖动取景 · " : ""}WASD 移动 · 空格上升 · Shift 下降 · Esc 退出`
            : "点击画面进入自由取景"}{" "}
          · 滚轮调焦 · 右键记录 · {Math.round(lens)} mm
        </small>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Numeric({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Number(value.toFixed(4)))), [value]);
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        step="0.1"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (draft && Number.isFinite(next) && next !== value) onChange(next);
          else setDraft(String(value));
        }}
      />
    </label>
  );
}
export default function DirectorNodeView({ node, controller, readOnly }: Props) {
  const viewSession = directorView(controller.getNodeService(node.id));
  const { value: viewState } = useEditorSession(viewSession);
  const field = <K extends keyof typeof viewState>(key: K) => (value: typeof viewState[K] | ((current: typeof viewState[K]) => typeof viewState[K])) => { const current = viewSession.read().value; viewSession.replace({ ...current, [key]: typeof value === "function" ? value(current[key]) : value }); };
  const { open, selected, mode, time, playing, freeView, aspectRatio } = viewState;
  const setOpen = field("open"), setSelected = field("selected"), setMode = field("mode"), setTime = field("time"), setPlaying = field("playing"), setFreeView = field("freeView"), setAspectRatio = field("aspectRatio");
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [panel, setPanel] = useState("scene"),
    [json, setJson] = useState(""),
    [jsonRevision, setJsonRevision] = useState(""),
    [draftPreview, setDraftPreview] = useState<{
      value: { name?: string; duration?: number; tracks?: unknown[]; cameraFrames?: unknown[] };
      valid: boolean;
      issues: string[];
    }>(),
    [phase, setPhase] = useState(""),
    [progress, setProgress] = useState(0),
    [running, setRunning] = useState(false);
  const [anchorPreviews, setAnchorPreviews] = useState<Record<string, string>>({});
  const anchorDrag = useRef<{ id: string; anchors: Snapshot["anchors"] } | undefined>(undefined);
  const runtime = useRef<SceneRuntime>(undefined),
    image = (node.data?.outputs as any)?.image?.value,
    { url: imageUrl } = useMediaUrl(controller, image);
  const locked = readOnly || busy || running;
  useEffect(() => (controller.getPluginService(node.id) as DirectorService | undefined)?.bindCamera({ read: () => runtime.current ? captureCamera(runtime.current) : null, apply(value) { const current = runtime.current; if (!current) throw new Error("导演视口未就绪"); applyCamera(current.camera, value); current.camera.userData.directorTarget = value.controls.target; } }), [controller, node.id]);
  const [aspectWidth, aspectHeight] = aspectRatio.split(":").map(Number),
    aspect = aspectWidth! / aspectHeight!;
  async function refresh() {
    try {
      const value = (await controller.callNodeTool(node.id, "getDirectorDocument", {})) as Snapshot;
      setSnapshot(value);
      setError("");
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  useEffect(() => {
    void refresh();
  }, [
    node.id,
    node.data?.modelPath,
    node.data?.selectedPlanId,
    node.data?.anchors,
    node.data?.lighting,
    node.data?.sceneSettings,
  ]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const value = (controller.getPluginService(node.id) as DirectorService | undefined)?.state();
      if (value) {
        setPhase(value.phase);
        setProgress(value.progress);
        setRunning(value.busy);
      }
    }, 350);
    return () => clearInterval(timer);
  }, [open]);
  const plan = snapshot?.document.plans.find((item) => item.id === snapshot.selectedPlanId),
    object = snapshot?.document.scene.objectList.find((item) => item.threeJsonId === selected);
  useEffect(() => {
    if (!playing || !plan) return;
    let frame = 0,
      last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(0.1, (now - last) / 1000);
      last = now;
      setTime((value) => {
        if (value + delta >= plan.duration) {
          setPlaying(false);
          return 0;
        }
        return value + delta;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, plan?.duration]);
  async function action(name: string, args: Record<string, unknown>) {
    if (locked) return;
    setBusy(true);
    setError("");
    try {
      const value = (await controller.callNodeTool(node.id, name, args)) as any;
      if (value?.document && value?.revision) setSnapshot(value);
      else await refresh();
      return value;
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  function focusComposer(prompt?: string) {
    if (locked) return;
    try {
      controller.getNodeService(node.id).focusComposer(prompt === undefined ? undefined : { prompt });
      setPlaying(false);
      setOpen(false);
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  function changeScene(scene: SceneDocument, expectedRevision = snapshot?.revision) {
    if (snapshot) return action("setDirectorScene", { expectedRevision, scene });
  }
  function changeObject(id: string, patch: Partial<SceneDocument["objectList"][number]>) {
    if (!snapshot) return;
    const scene = structuredClone(snapshot.document.scene),
      value = scene.objectList.find((item) => item.threeJsonId === id);
    if (value) {
      Object.assign(value, patch);
      void changeScene(scene);
    }
  }
  function addShape(type: SceneDocument["objectList"][number]["objType"]) {
    if (!snapshot) return;
    const scene = structuredClone(snapshot.document.scene),
      id = crypto.randomUUID();
    scene.objectList.push({
      threeJsonId: id,
      objType: type,
      name: type,
      position: { x: 0, y: 0, z: 0 },
      geometry:
        type === "box"
          ? { width: 1, height: 1, depth: 1 }
          : type === "plane"
            ? { width: 10, height: 10 }
            : { radius: 1 },
      material: { type: "standard", color: "#9eaaa8", roughness: 0.65 },
    });
    setSelected(id);
    void changeScene(scene);
  }
  async function captureAnchor() {
    if (!snapshot || !runtime.current) return;
    const anchor = { id: crypto.randomUUID(), time, ...captureCamera(runtime.current) };
    await action("setDirectorSettings", { anchors: [...snapshot.anchors, anchor], expectedAnchors: snapshot.anchors });
  }
  async function reorderAnchor(targetId: string) {
    const drag = anchorDrag.current; anchorDrag.current = undefined;
    if (!snapshot || !drag || locked || drag.id === targetId) return;
    if (JSON.stringify(drag.anchors) !== JSON.stringify(snapshot.anchors)) { setError("关键帧已变化，原顺序保留，请重新拖动"); return; }
    const anchors = [...snapshot.anchors], from = anchors.findIndex(value => value.id === drag.id), to = anchors.findIndex(value => value.id === targetId);
    if (from < 0 || to < 0) return;
    anchors.splice(to, 0, anchors.splice(from, 1)[0]!);
    await action("setDirectorSettings", { anchors, expectedAnchors: drag.anchors });
  }
  async function makePlan() {
    if (!snapshot) return;
    await action("setDirectorPlan", {
      expectedRevision: snapshot.revision,
      plan: {
        name: `方案 ${snapshot.document.plans.length + 1}`,
        duration: 5,
        tracks: [],
        cameraFrames: [
          {
            time: 0,
            easing: "linear",
            view: snapshot.anchors[0]
              ? { camera: snapshot.anchors[0].camera, controls: snapshot.anchors[0].controls }
              : {
                  camera: snapshot.document.scene.sceneConfig.camera,
                  controls: snapshot.document.scene.sceneConfig.controls,
                },
          },
        ],
      },
    });
  }
  return (
    <div className="directorReactNode nodrag nopan nowheel">
      <button
        className="directorOpen"
        disabled={!snapshot}
        onClick={() => {
          setOpen(true);
          if (snapshot) {
            setJson(JSON.stringify(snapshot.document.scene, null, 2));
            setJsonRevision(snapshot.revision);
          }
        }}>
        {imageUrl ? (
          <img src={imageUrl} alt="导演台导出关键帧" />
        ) : (
          <>
            <span>◈</span>
            <strong>3D 导演台</strong>
            {snapshot && (
              <small>
                {snapshot.document.scene.objectList.length} 物体 · {snapshot.document.plans.length}{" "}
                方案
              </small>
            )}
          </>
        )}
      </button>
      {error && (
        <p className="directorError" role="alert">
          {error}
        </p>
      )}
      {open &&
        snapshot &&
        createPortal(
          <div
            className="openCinemaWorkbench directorReactDialog"
            role="dialog"
            aria-modal="true"
            aria-label="3D 导演台"
            onKeyDown={(event) => event.stopPropagation()}>
            <header>
              <strong>3D 导演台</strong>
              <span>场景 · 相机 · 动画</span>
              <small>{busy ? phase || "正在保存…" : "OpenCinema"}</small>
              {(busy || running) && (
                <button
                  onClick={() =>
                    void controller
                      .callNodeTool(node.id, "cancelDirector", {})
                      .catch((failure) => setError(errorText(failure)))
                  }>
                  取消任务
                </button>
              )}
              <button
                disabled={busy || running}
                onClick={() => {
                  setPlaying(false);
                  setOpen(false);
                }}>
                关闭
              </button>
            </header>
            {error && (
              <p className="directorError" role="alert">
                {error}
              </p>
            )}
            <nav>
              <button
                disabled={locked}
                onClick={() =>
                  void action("addDirectorMannequin", { expectedRevision: snapshot.revision })
                }>
                添加人偶
              </button>
              <select
                aria-label="添加几何体"
                value=""
                disabled={locked}
                onChange={(event) => addShape(event.target.value as any)}>
                <option value="">添加几何体</option>
                {["box", "sphere", "cylinder", "cone", "ring", "torus", "capsule", "plane"].map(
                  (type) => (
                    <option key={type}>{type}</option>
                  ),
                )}
              </select>
              {(["translate", "rotate", "scale"] as const).map((value, index) => (
                <button
                  className={mode === value ? "active" : ""}
                  key={value}
                  onClick={() => setMode(value)}
                  disabled={locked}>
                  {["移动", "旋转", "缩放"][index]}
                </button>
              ))}
              <select
                aria-label="动画方案"
                value={snapshot.selectedPlanId ?? ""}
                disabled={locked}
                onChange={(event) => {
                  setTime(0);
                  setPlaying(false);
                  void action("setDirectorSettings", { selectedPlanId: event.target.value });
                }}>
                <option value="">静态场景</option>
                {snapshot.document.plans.map((value) => (
                  <option value={value.id} key={value.id}>
                    {value.name}
                  </option>
                ))}
              </select>
              <button disabled={locked} onClick={() => void makePlan()}>
                新方案
              </button>
              <button
                className={freeView ? "active" : ""}
                onClick={() => {
                  setPlaying(false);
                  setFreeView((value) => !value);
                }}>
                自由取景
              </button>
              <select
                aria-label="导演画幅"
                value={aspectRatio}
                onChange={(event) => setAspectRatio(event.target.value as typeof aspectRatio)}>
                {["16:9", "9:16", "4:3", "1:1"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </nav>
            <div className="directorBody">
              <aside className="directorObjects">
                <h3>场景物体</h3>
                {snapshot.document.scene.objectList.map((value) => (
                  <button
                    key={value.threeJsonId}
                    className={selected === value.threeJsonId ? "active" : ""}
                    onClick={() => setSelected(value.threeJsonId)}>
                    {value.name ?? value.objType}
                  </button>
                ))}
                <h3>相机锚点</h3>
                <button disabled={locked} onClick={() => void captureAnchor()}>
                  捕捉当前相机
                </button>
                {snapshot.anchors.map((value, index) => (
                  <div className="directorAnchor" key={value.id} onDragStart={event => { if (locked) { event.preventDefault(); return; } anchorDrag.current = { id: value.id, anchors: snapshot.anchors }; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-opencinema-director-anchor", value.id); }} onDragEnd={() => { anchorDrag.current = undefined; }} onDragOver={event => { if (!locked && anchorDrag.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => { if (!anchorDrag.current) return; event.preventDefault(); event.stopPropagation(); void reorderAnchor(value.id); }}>
                    <button
                      type="button" className="directorAnchorPreview" title="回看关键帧；拖动可调整顺序" draggable={!locked}
                      onClick={() => {
                        setPlaying(false);
                        setFreeView(true);
                        if (value.time !== undefined) setTime(Math.min(plan?.duration ?? 0, value.time));
                        if (runtime.current) {
                          runtime.current.camera.position.set(
                            value.camera.position.x,
                            value.camera.position.y,
                            value.camera.position.z,
                          );
                          runtime.current.camera.lookAt(
                            value.controls.target.x,
                            value.controls.target.y,
                            value.controls.target.z,
                          );
                          runtime.current.camera.fov = value.camera.fov;
                          runtime.current.camera.updateProjectionMatrix();
                          runtime.current.camera.userData.directorTarget = {
                            ...value.controls.target,
                          };
                        }
                      }}>
                      {anchorPreviews[value.id] && <img src={anchorPreviews[value.id]} alt={`关键帧 ${index + 1}`} draggable={false} />}
                      <span>{index + 1} · {(value.time ?? 0).toFixed(2)}s</span>
                    </button>
                    <button
                      disabled={locked || index === 0}
                      title="前移锚点" aria-label={`前移锚点 ${index + 1}`}
                      onClick={() => {
                        const anchors = [...snapshot.anchors];
                        [anchors[index - 1], anchors[index]] = [
                          anchors[index]!,
                          anchors[index - 1]!,
                        ];
                        void action("setDirectorSettings", { anchors, expectedAnchors: snapshot.anchors });
                      }}>
                      <NodeIcon name="arrowUp" />
                    </button>
                    <button
                      disabled={locked || index === snapshot.anchors.length - 1}
                      title="后移锚点" aria-label={`后移锚点 ${index + 1}`}
                      onClick={() => {
                        const anchors = [...snapshot.anchors];
                        [anchors[index], anchors[index + 1]] = [
                          anchors[index + 1]!,
                          anchors[index]!,
                        ];
                        void action("setDirectorSettings", { anchors, expectedAnchors: snapshot.anchors });
                      }}>
                      <NodeIcon name="arrowDown" />
                    </button>
                    <button
                      type="button" title="删除锚点" aria-label={`删除锚点 ${index + 1}`}
                      disabled={locked}
                      onClick={() =>
                        void action("setDirectorSettings", {
                          anchors: snapshot.anchors.filter((item) => item.id !== value.id),
                          expectedAnchors: snapshot.anchors,
                        })
                      }>
                      <NodeIcon name="close" />
                    </button>
                  </div>
                ))}
              </aside>
              <section className="directorStage">
                <DirectorViewport
                  snapshot={snapshot}
                  selected={selected}
                  mode={mode}
                  time={time}
                  disabled={!!locked}
                  runtimeRef={runtime}
                  select={setSelected}
                  change={changeObject}
                  freeView={freeView}
                  aspect={aspect}
                  pause={() => setPlaying(false)}
                  capture={() => void captureAnchor()}
                  previews={setAnchorPreviews}
                />
                <div className="directorPlayback">
                  <button
                    disabled={!plan}
                    onClick={() => {
                      setFreeView(false);
                      setPlaying((value) => !value);
                    }}>
                    {playing ? "暂停" : "播放"}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={plan?.duration ?? 5}
                    step={1 / 30}
                    value={time}
                    aria-label="导演台时间轴"
                    onChange={(event) => {
                      setPlaying(false);
                      setTime(Number(event.target.value));
                    }}
                  />
                  <span>
                    {time.toFixed(2)} / {(plan?.duration ?? 0).toFixed(2)} s
                  </span>
                </div>
                <div className="directorTabs">
                  {[
                    ["scene", "场景文档"],
                    ["plan", "动画方案"],
                    ["agent", "宿主 Agent"],
                    ["export", "导出"],
                  ].map(([id, title]) => (
                    <button
                      key={id}
                      className={panel === id ? "active" : ""}
                      onClick={() => {
                        setPanel(id!);
                        setJsonRevision(snapshot.revision);
                        setJson(
                          JSON.stringify(id === "plan" ? plan : snapshot.document.scene, null, 2) ??
                            "",
                        );
                      }}>
                      {title}
                    </button>
                  ))}
                </div>
                {(panel === "scene" || panel === "plan") && (
                  <div className="directorDocument">
                    <textarea
                      key={`${panel}:${snapshot.revision}`}
                      aria-label={panel === "scene" ? "导演台场景 JSON" : "导演台动画方案 JSON"}
                      readOnly={locked}
                      value={json}
                      onChange={(event) => setJson(event.target.value)}
                    />
                    <button
                      disabled={locked || !json}
                      onClick={() => {
                        try {
                          const value = JSON.parse(json);
                          if (panel === "scene") void changeScene(value, jsonRevision);
                          else {
                            const { id: _id, instruction: _instruction, ...next } = value;
                            void action("setDirectorPlan", {
                              expectedRevision: jsonRevision,
                              plan: next,
                            });
                          }
                        } catch (failure) {
                          setError(errorText(failure));
                        }
                      }}>
                      验证并保存{panel === "plan" ? "新方案" : "场景"}
                    </button>
                  </div>
                )}
                {panel === "agent" && (
                  <div className="directorPrompt">
                    <button
                      disabled={locked}
                      onClick={() => focusComposer()}>
                      创作导演方案
                    </button>
                    {plan?.instruction && (
                      <details>
                        <summary>此方案原始指令</summary>
                        <p>{plan.instruction}</p>
                        <button disabled={locked} onClick={() => focusComposer(plan.instruction)}>
                          继续此方案
                        </button>
                      </details>
                    )}
                    <button
                      disabled={locked}
                      onClick={async () => {
                        const value = await action("readDocument", { section: "plan" });
                        if (value) setDraftPreview(value);
                      }}>
                      查看待采用草稿
                    </button>
                    {draftPreview && (
                      <div className="directorDraft">
                        <strong>{draftPreview.value.name ?? "未命名草稿"}</strong>
                        <small>
                          {draftPreview.value.duration ?? "未设置"}s ·{" "}
                          {draftPreview.value.tracks?.length ?? 0} 条物体 / 关节轨道 ·{" "}
                          {draftPreview.value.cameraFrames?.length ?? 0} 个摄影关键帧
                        </small>
                        {draftPreview.issues.map((issue, index) => (
                          <p key={index} role="alert">
                            {issue}
                          </p>
                        ))}
                        <button
                          disabled={locked || !draftPreview.valid}
                          onClick={() =>
                            void action("applyDirectorDraft", {
                              expectedRevision: snapshot.revision,
                            }).then((value) => {
                              if (value) setDraftPreview(undefined);
                            })
                          }>
                          采用完整草稿为新方案
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {panel === "export" && (
                  <div className="directorExports">
                    <button
                      disabled={locked}
                      onClick={() =>
                        void action("exportDirectorImage", {
                          expectedRevision: snapshot.revision,
                          time,
                          aspect,
                          ...(runtime.current
                            ? {
                                anchor: {
                                  id: crypto.randomUUID(),
                                  ...captureCamera(runtime.current),
                                },
                              }
                            : {}),
                        })
                      }>
                      导出当前关键帧
                    </button>
                    <button
                      disabled={locked || !plan}
                      onClick={() =>
                        void action("exportDirectorVideo", {
                          expectedRevision: snapshot.revision,
                          planId: plan?.id,
                          aspect,
                        })
                      }>
                      导出场景动画 MP4
                    </button>
                    {(busy || running) && (
                      <>
                        <progress value={progress} max={100} />
                        <small>{phase}</small>
                        <button
                          onClick={() =>
                            void controller.callNodeTool(node.id, "cancelDirector", {})
                          }>
                          取消
                        </button>
                      </>
                    )}
                    {Object.entries((node.data?.outputs as Record<string, any>) ?? {})
                      .filter(([, output]) => output?.value?.url)
                      .map(([name, output]) => (
                        <div key={name} className="directorOutputActions">
                          <button
                            onClick={async () => {
                              const value = await controller.acquireMedia(
                                  output.value.url,
                                  output.value.mimeType,
                                ),
                                link = document.createElement("a");
                              link.href = value.url;
                              link.download = output.value.url.split("/").at(-1);
                              link.click();
                              setTimeout(value.release, 30000);
                            }}>
                            下载 {name}
                          </button>
                          {["image", "video"].includes(name) && (
                            <button
                              disabled={locked}
                              onClick={() =>
                                void action("createDirectorOutputNode", {
                                  kind: name,
                                  expectedPath: output.value.url,
                                })
                              }>
                              放入画布
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </section>
              <aside className="directorInspector">
                <h3>场景与照明</h3>
                <label>
                  <span>背景</span>
                  <input
                    type="color"
                    value={snapshot.document.scene.sceneConfig.scene.background}
                    disabled={locked}
                    onChange={(event) => {
                      const scene = structuredClone(snapshot.document.scene);
                      scene.sceneConfig.scene.background = event.target.value;
                      void changeScene(scene);
                    }}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={snapshot.sceneSettings.gridVisible}
                    disabled={locked}
                    onChange={(event) =>
                      void action("setDirectorSettings", {
                        sceneSettings: {
                          ...snapshot.sceneSettings,
                          gridVisible: event.target.checked,
                        },
                      })
                    }
                  />
                  显示网格
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={snapshot.sceneSettings.skyVisible}
                    disabled={locked}
                    onChange={(event) =>
                      void action("setDirectorSettings", {
                        sceneSettings: {
                          ...snapshot.sceneSettings,
                          skyVisible: event.target.checked,
                        },
                      })
                    }
                  />
                  显示天空
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={snapshot.lighting.globalEnabled}
                    disabled={locked}
                    onChange={(event) =>
                      void action("setDirectorSettings", {
                        lighting: { ...snapshot.lighting, globalEnabled: event.target.checked },
                      })
                    }
                  />
                  环境光
                </label>
                <Numeric
                  label="环境光强度"
                  value={snapshot.lighting.globalIntensity}
                  disabled={locked}
                  onChange={(value) =>
                    void action("setDirectorSettings", {
                      lighting: { ...snapshot.lighting, globalIntensity: value },
                    })
                  }
                />
                <label>
                  <input
                    type="checkbox"
                    checked={snapshot.lighting.sunEnabled}
                    disabled={locked}
                    onChange={(event) =>
                      void action("setDirectorSettings", {
                        lighting: { ...snapshot.lighting, sunEnabled: event.target.checked },
                      })
                    }
                  />
                  太阳光
                </label>
                {(["azimuth", "elevation", "intensity"] as const).map((key, index) => (
                  <Numeric
                    key={key}
                    label={["方位角 / 度", "仰角 / 度", "太阳光强度"][index]!}
                    value={snapshot.lighting[key]}
                    disabled={locked}
                    onChange={(value) =>
                      void action("setDirectorSettings", {
                        lighting: { ...snapshot.lighting, [key]: value },
                      })
                    }
                  />
                ))}
                {object && (
                  <>
                    <h3>{object.name ?? object.objType}</h3>
                    <label>
                      <span>名称</span>
                      <input
                        key={`${object.threeJsonId}:${object.name}`}
                        defaultValue={object.name ?? ""}
                        disabled={locked}
                        onBlur={(event) =>
                          changeObject(object.threeJsonId, { name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>材质颜色</span>
                      <input
                        type="color"
                        value={object.material.color}
                        disabled={locked}
                        onChange={(event) =>
                          changeObject(object.threeJsonId, {
                            material: { ...object.material, color: event.target.value },
                          })
                        }
                      />
                    </label>
                    {(["x", "y", "z"] as const).map((axis) => (
                      <Numeric
                        key={axis}
                        label={`位置 ${axis.toUpperCase()} / m`}
                        value={object.position[axis]}
                        disabled={locked}
                        onChange={(value) =>
                          changeObject(object.threeJsonId, {
                            position: { ...object.position, [axis]: value },
                          })
                        }
                      />
                    ))}
                    {(["rotationX", "rotationY", "rotationZ"] as const).map((key) => (
                      <Numeric
                        key={key}
                        label={`${key} / 弧度`}
                        value={object.rotation?.[key] ?? 0}
                        disabled={locked}
                        onChange={(value) =>
                          changeObject(object.threeJsonId, {
                            rotation: {
                              rotationX: 0,
                              rotationY: 0,
                              rotationZ: 0,
                              ...object.rotation,
                              [key]: value,
                            },
                          })
                        }
                      />
                    ))}
                    {(["scaleX", "scaleY", "scaleZ"] as const).map((key) => (
                      <Numeric
                        key={key}
                        label={key}
                        value={object.scale?.[key] ?? 1}
                        disabled={locked}
                        onChange={(value) =>
                          changeObject(object.threeJsonId, {
                            scale: {
                              scaleX: 1,
                              scaleY: 1,
                              scaleZ: 1,
                              ...object.scale,
                              [key]: value,
                            },
                          })
                        }
                      />
                    ))}
                    {object.objType === "mannequin" && (
                      <details>
                        <summary>关节姿态 / 弧度</summary>
                        {mannequinJoints.flatMap((joint) =>
                          (["x", "y", "z"] as const).map((axis) => (
                            <Numeric
                              key={`${joint}:${axis}`}
                              label={`${joint} ${axis}`}
                              value={object.pose?.[joint]?.[axis] ?? 0}
                              disabled={locked}
                              onChange={(value) =>
                                changeObject(object.threeJsonId, {
                                  pose: {
                                    ...object.pose,
                                    [joint]: {
                                      x: 0,
                                      y: 0,
                                      z: 0,
                                      ...object.pose?.[joint],
                                      [axis]: value,
                                    },
                                  },
                                })
                              }
                            />
                          )),
                        )}
                      </details>
                    )}
                    <button
                      disabled={locked}
                      onClick={() => {
                        const scene = structuredClone(snapshot.document.scene);
                        scene.objectList = scene.objectList.filter(
                          (item) => item.threeJsonId !== object.threeJsonId,
                        );
                        void changeScene(scene);
                      }}>
                      删除物体
                    </button>
                  </>
                )}
              </aside>
            </div>
            <footer>所有场景与方案保存于节点资源 · 手工编辑与 Agent 共用历史</footer>
          </div>,
          document.body,
        )}
    </div>
  );
}
