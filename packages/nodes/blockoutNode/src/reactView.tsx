import NodeIcon from "@toonflow/node-shared/reactIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";
import { errorText } from "@toonflow/node-shared/reactNode";
import NodeError from "@toonflow/node-shared/reactNodeNotice";
import { useDialogKeys } from "@toonflow/node-shared/useDialogKeys";
import { ASSET_CATALOG, assetSpec } from "./nativeBlockout/assets";
import { ASPECT_RATIOS, SENSORS, LENS_SET } from "./nativeBlockout/camera";
import { RIGS } from "./nativeBlockout/rigs";
import { GAITS } from "./nativeBlockout/gaits";
import {
  createActorMark,
  createCameraMark,
  createScene,
  createShot,
} from "./nativeBlockout/schema";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { cloneProject } from "./document";
import { cameraMovePresets } from "./blockout/cameraMoves";
import { motionPresets } from "./nativeBlockout/motions";
import { actionPresets } from "./nativeBlockout/actionPresets";
import { personJoints, personPoses } from "./entityPose";
import { lightingPresets } from "./environment";
import { coverageWarnings } from "./editing";
import { createBlockoutViewport, type BlockoutViewportProps } from "./reactViewportEngine";
import { useBlockoutRecording } from "./reactRecording";
import GroupControls from "./reactGroupControls";
import ShotControls from "./reactShotControls";
import ReferenceControls from "./reactReferenceControls";
import ReferencePreview from "./reactReferencePreview";
import { NumberField } from "./reactFields";
import type { BlockoutService } from "./reactService";
import { blockoutView } from "./editorView";
import { useEditorSession } from "@toonflow/node-shared/editorSession";
import type { ActorMark, CameraMark, ProjectDoc, V3 } from "./nativeBlockout/types";
import "./reactStyles.scss";

type Props = NodeViewProps & {
  controller: NodeViewProps["controller"] & {
    getPluginService(nodeId: string): unknown;
    undo(): Promise<void>;
    redo(): Promise<void>;
  };
};
function Viewport({
  value,
  onEvent,
  engineRef,
}: {
  value: BlockoutViewportProps;
  onEvent?(name: string, ...args: any[]): void;
  engineRef?: { current: ReturnType<typeof createBlockoutViewport> | undefined };
}) {
  const container = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    engine = useRef<ReturnType<typeof createBlockoutViewport>>(undefined),
    callback = useRef(onEvent);
  callback.current = onEvent;
  const [error, setError] = useState("");
  useEffect(() => {
    engine.current = createBlockoutViewport(
      container.current!,
      canvas.current!,
      value,
      (name, ...args) => callback.current?.(name, ...args),
    );
    if (engineRef) engineRef.current = engine.current;
    const timer = setInterval(() => setError(engine.current?.getState().error ?? ""), 500);
    return () => {
      clearInterval(timer);
      engine.current?.dispose();
      engine.current = undefined;
      if (engineRef) engineRef.current = undefined;
    };
  }, []);
  useEffect(() => engine.current?.update(value), [value]);
  return (
    <div
      ref={container}
      className="blockoutReactViewport"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => engine.current?.dropAsset(event.nativeEvent)}>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={value.cameraView ? "Blockout 镜头监看" : "Blockout 三维场景"}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
export default function BlockoutNodeView({ node, controller, readOnly }: Props) {
  const viewSession = blockoutView(controller.getNodeService(node.id));
  const { value: viewState } = useEditorSession(viewSession);
  const field = <K extends keyof typeof viewState>(key: K) => (value: typeof viewState[K] | ((current: typeof viewState[K]) => typeof viewState[K])) => { const current = viewSession.read().value; viewSession.replace({ ...current, [key]: typeof value === "function" ? value(current[key]) : value }); };
  const { open, sceneId, shotId, selected, selectedIds, markId, time, playing, editScope, mode } = viewState;
  const setOpen = field("open"), setSceneId = field("sceneId"), setShotId = field("shotId"), setSelected = field("selected"), setSelectedIds = field("selectedIds"), setMarkId = field("markId"), setTime = field("time"), setPlaying = field("playing"), setEditScope = field("editScope"), setMode = field("mode");
  const [snapshot, setSnapshot] = useState<{ project: ProjectDoc; revision: string }>(),
    [inspectorOpen, setInspectorOpen] = useState(true),
    [error, setError] = useState<unknown>(""),
    [removingPreset, setRemovingPreset] = useState(""),
    [closeArmed, setCloseArmed] = useState(false),
    [saving, setSaving] = useState(false),
    [status, setStatus] = useState({ busy: false, phase: "", progress: 0, error: "" });
  const [category, setCategory] = useState("people"),
    [panel, setPanel] = useState("properties"),
    [json, setJson] = useState(""),
    [jsonRevision, setJsonRevision] = useState(""),
    [presetList, setPresetList] = useState<any[]>([]);
  const [exportStart, setExportStart] = useState(0),
    [exportEnd, setExportEnd] = useState<number>(),
    [exportFps, setExportFps] = useState(24),
    [exportSize, setExportSize] = useState<640 | 1280>(1280),
    [exportDepth, setExportDepth] = useState(false),
    [exportNormal, setExportNormal] = useState(false),
    [depthNear, setDepthNear] = useState(0.1),
    [depthFar, setDepthFar] = useState(100),
    [showLabels, setShowLabels] = useState(true);
  const stage = useRef<ReturnType<typeof createBlockoutViewport>>(undefined),
    monitor = useRef<ReturnType<typeof createBlockoutViewport>>(undefined);
  const service = () => controller.getPluginService(node.id) as BlockoutService | undefined;
  async function refresh() {
    try {
      const value = (await controller.callNodeTool(
        node.id,
        "getBlockoutProject",
        {},
      )) as typeof snapshot;
      setSnapshot(value);
      setError("");
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  useEffect(() => {
    void refresh();
  }, [node.id, node.data?.blockoutPath]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const value = service()?.state();
      if (value) setStatus(value);
    }, 350);
    return () => clearInterval(timer);
  }, [open]);
  const scene =
    snapshot?.project.scenes.find((item) => item.id === sceneId) ?? snapshot?.project.scenes[0];
  const shot =
    [...(scene?.shots ?? []), ...(scene?.drafts ?? [])].find((item) => item.id === shotId) ??
    scene?.shots[0];
  const take = scene?.blocking.find((item) => item.id === shot?.blockingTakeId),
    entity = scene?.entities.find((item) => item.id === selected);
  const marks =
    selected === "camera"
      ? (shot?.camera.marks ?? [])
      : (take?.tracks.find((item) => item.entityId === selected)?.marks ?? []);
  const activeMark = marks.find((item) => item.id === markId),
    cameraMark = selected === "camera" ? (activeMark as CameraMark | undefined) : undefined,
    actorMark = selected !== "camera" ? (activeMark as ActorMark | undefined) : undefined;
  const baseLocked = readOnly || saving || status.busy;
  const recorder = useBlockoutRecording({
    stage,
    scene,
    shot,
    revision: snapshot?.revision,
    time,
    selected,
    disabled: baseLocked,
    setTime,
    setPlaying,
    apply: async (command, revision, signal) =>
      !!(await action(
        () =>
          controller.callNodeTool(node.id, "editBlockoutProject", {
            expectedRevision: revision,
            commands: [command],
          }, signal),
        true,
      )),
  });
  const locked = baseLocked || recorder.active;
  const recordingRef = useRef(recorder); recordingRef.current = recorder;
  useEffect(() => service()?.bindRecording({ read() { const value = recordingRef.current.read(); return value ? { phase: value.phase, kind: value.kind, start: value.start, end: value.end, marks: value.marks.length, precision: value.precision } : null; }, isPreparing() { return recordingRef.current.isPreparing(); }, start(kind, signal, precision) { return recordingRef.current.start(kind, signal, precision); }, stop() { recordingRef.current.stop(); }, discard() { recordingRef.current.discard(); }, async apply(signal) { await recordingRef.current.apply(signal); } }), [controller, node.id]);
  const performanceLocked = locked || !!take?.confirmed;
  const transformLocked =
    locked || (selected !== "camera" && editScope === "take" && !!take?.confirmed);
  const selectedEntityIds = selectedIds.filter((id) =>
    scene?.entities.some((entity) => entity.id === id),
  );
  const evaluator = useMemo(
    () => (scene && shot ? new ShotEvaluator(scene, shot) : undefined),
    [scene, shot],
  );
  const entityState =
    evaluator && entity
      ? evaluator.evaluate(time).entities.find((value) => value.entityId === entity.id)
      : undefined;
  const displayPosition =
    activeMark?.position ??
    (editScope === "take" ? entityState?.position : entity?.transform.position);
  const warnings = useMemo(
    () =>
      scene && shot && evaluator
        ? [
            ...evaluator
              .warnings()
              .map(
                (value) =>
                  `${value.entityName}：${value.verdict.impliedSpeed.toFixed(1)} m/s，${value.verdict.kind === "tooFast" ? "速度偏快" : "速度偏慢"}`,
              ),
            ...evaluator
              .lineCrossings()
              .map((value) => `相机标记 ${value.fromMark}→${value.toMark} 跨越双人轴线`),
            ...coverageWarnings(scene, shot, 0).map((value) => value.message),
          ]
        : [],
    [scene, shot, evaluator],
  );
  useEffect(() => {
    setExportStart(0);
    setExportEnd(undefined);
    setExportFps(shot?.fps ?? 24);
  }, [shot?.id]);
  useEffect(() => {
    if (editScope === "take" && mode === "scale") setMode("translate");
  }, [editScope, mode]);
  useEffect(() => {
    if (!playing || !shot) return;
    let frame = 0,
      last = performance.now();
    const tick = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;
      setTime((value) => {
        if (value + delta >= shot.duration) {
          setPlaying(false);
          return 0;
        }
        return value + delta;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, shot?.duration]);
  function close() {
    if (saving || status.busy) return;
    if (recorder.recording && !closeArmed) { setCloseArmed(true); return; }
    setCloseArmed(false);
    setPlaying(false);
    recorder.discard();
    setOpen(false);
  }
  useEffect(() => setCloseArmed(false), [recorder.recording?.phase]);
  function loadPresets() {
    void controller
      .callNodeTool(node.id, "listBlockoutStagePresets", {})
      .then((value) => setPresetList(Array.isArray(value) ? value : ((value as any)?.presets ?? [])))
      .catch((failure) => setError(errorText(failure)));
  }
  const { dialog, onEscape } = useDialogKeys(!!(open && snapshot && scene && shot), close);
  async function action(callback: () => Promise<any>, allowRecording = false) {
    if (baseLocked || (recorder.active && !allowRecording)) return;
    setSaving(true);
    setError("");
    setPlaying(false);
    try {
      const value = await callback();
      if (value?.project) setSnapshot(value);
      else await refresh();
      return value;
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }
  function edit(commands: any[]) {
    if (snapshot)
      return action(() =>
        controller.callNodeTool(node.id, "editBlockoutProject", {
          expectedRevision: snapshot.revision,
          commands,
        }),
      );
  }
  function change(callback: (draft: ProjectDoc) => void) {
    if (!snapshot) return;
    const draft = cloneProject(snapshot.project);
    callback(draft);
    return action(() =>
      controller.callNodeTool(node.id, "setBlockoutProject", {
        expectedRevision: snapshot.revision,
        project: draft,
      }),
    );
  }
  function changeShot(callback: (value: NonNullable<typeof shot>) => void) {
    return change((draft) => {
      const next = draft.scenes.find((item) => item.id === scene!.id)!;
      callback([...next.shots, ...(next.drafts ?? [])].find((item) => item.id === shot!.id)!);
    });
  }
  function changeEntity(callback: (value: NonNullable<typeof entity>) => void) {
    return change((draft) =>
      callback(
        draft.scenes
          .find((item) => item.id === scene!.id)!
          .entities.find((item) => item.id === entity!.id)!,
      ),
    );
  }
  function changeMark(callback: (value: ActorMark | CameraMark) => void) {
    if (selected !== "camera" && performanceLocked) return;
    return change((draft) => {
      const next = draft.scenes.find((item) => item.id === scene!.id)!,
        nextShot = [...next.shots, ...(next.drafts ?? [])].find((item) => item.id === shot!.id)!;
      const list =
        selected === "camera"
          ? nextShot.camera.marks
          : next.blocking
              .find((item) => item.id === nextShot.blockingTakeId)!
              .tracks.find((item) => item.entityId === selected)!.marks;
      callback(list.find((item) => item.id === markId)!);
    });
  }
  function selectEntity(id: string, additive = false) {
    setSelected(id);
    setMarkId("");
    setSelectedIds((values) =>
      additive
        ? values.includes(id)
          ? values.filter((item) => item !== id)
          : [...values, id]
        : [id],
    );
  }
  function selectScene(id: string) {
    setSceneId(id);
    setShotId("");
    setTime(0);
    setPlaying(false);
    setSelected("");
    setSelectedIds([]);
    setMarkId("");
  }
  const scope = { sceneId: scene?.id, shotId: shot?.id };
  function retimeMark(entityId: string, id: string, at: number) {
    if (!scene || !shot || locked || (entityId !== "camera" && performanceLocked)) return;
    return change((draft) => {
      const nextScene = draft.scenes.find((value) => value.id === scene.id)!,
        nextShot = [...nextScene.shots, ...(nextScene.drafts ?? [])].find(
          (value) => value.id === shot.id,
        )!;
      const list =
        entityId === "camera"
          ? nextShot.camera.marks
          : nextScene.blocking
              .find((value) => value.id === nextShot.blockingTakeId)!
              .tracks.find((value) => value.entityId === entityId)!.marks;
      const mark = list.find((value) => value.id === id);
      if (!mark) throw new Error("标记已变化，请重新选择");
      mark.time = Math.max(0, Math.min(shot.duration, Math.round(at * shot.fps) / shot.fps));
      list.sort((a, b) => a.time - b.time);
    });
  }
  async function addMark() {
    if (!shot || !scene || (!entity && selected !== "camera")) return;
    if (selected !== "camera" && performanceLocked) return;
    if (selected === "camera") {
      const camera = stage.current?.getCamera();
      if (camera)
        await edit([
          {
            type: "setCameraMark",
            ...scope,
            mark: createCameraMark(
              camera.position,
              time,
              camera.pan,
              camera.tilt,
              camera.focalLength,
            ),
            space: "world",
          },
        ]);
    } else {
      const state = new ShotEvaluator(scene, shot)
        .evaluate(time)
        .entities.find((item) => item.entityId === entity!.id)!;
      await edit([
        {
          type: "setActorMark",
          ...scope,
          entityId: selected,
          mark: createActorMark(state.position, time, "walk"),
        },
      ]);
    }
  }
  function move(_id: string, targetMark: string, position: V3, rotationY: number, scale: number) {
    if (transformLocked) return;
    if (targetMark)
      void changeMark((mark) => {
        mark.position = position;
      });
    else if (selectedIds.length > 1)
      void edit([
        {
          type: "transformEntities",
          ...scope,
          entityIds: selectedIds,
          anchorId: selected,
          position,
          rotationY,
          ...(editScope === "scene" ? { scale } : {}),
          scope: editScope,
          time,
        },
      ]);
    else
      void edit([
        {
          type: "moveEntity",
          ...scope,
          entityId: selected,
          position,
          rotationY,
          ...(editScope === "scene" ? { scale } : {}),
          scope: editScope,
          time,
        },
      ]);
  }
  async function exportMedia(kind: string) {
    if (!snapshot || !shot || !scene) return;
    const names: Record<string, string> = {
      video: "exportBlockoutVideo",
      animatic: "exportBlockoutAnimatic",
      stills: "exportBlockoutStills",
      contactSheet: "exportBlockoutContactSheet",
      topDown: "exportBlockoutTopDown",
      scene: "exportBlockoutScene",
    };
    await action(() =>
      controller.callNodeTool(node.id, names[kind]!, {
        expectedRevision: snapshot.revision,
        sceneId: scene.id,
        ...(kind === "animatic" || kind === "contactSheet" ? {} : { shotId: shot.id }),
        ...(["video", "scene"].includes(kind)
          ? { start: exportStart, end: exportEnd ?? shot.duration, fps: exportFps }
          : {}),
        ...(["video", "animatic", "stills"].includes(kind) ? { maxDimension: exportSize } : {}),
        ...(kind === "video"
          ? {
              controlLayers: [
                ...(exportDepth ? ["depth"] : []),
                ...(exportNormal ? ["normal"] : []),
              ],
              ...(exportDepth ? { depthRange: { near: depthNear, far: depthFar } } : {}),
            }
          : {}),
        ...(kind === "stills" ? { showLabels } : {}),
      }),
    );
  }
  const outputEntries = Object.entries((node.data?.outputs as Record<string, any>) ?? {}).filter(
    ([, output]) => output?.value?.url,
  );
  const view =
    scene && shot && service()
      ? {
          scene,
          shot,
          time,
          selected,
          selectedIds,
          markId,
          mode,
          disabled: transformLocked,
          recording:
            recorder.recording?.kind === "camera" && recorder.recording.phase === "recording",
          recordingLens:
            recorder.recording?.kind === "camera" ? recorder.recording.lens : undefined,
          actorPreview: recorder.actorPreview,
          liveCamera: recorder.liveCamera,
          readModel: service()!.readModel,
          readScan: service()!.readScan,
        }
      : undefined;
  return (
    <div className="blockoutReactNode nodrag nopan nowheel">
      <button className="blockoutOpen" disabled={!snapshot} onClick={() => setOpen(true)}>
        <span className="blockoutGlyph">⌘</span>
        <strong>Blockout</strong>
        {snapshot && (
          <small>
            {snapshot.project.scenes.length} 场景 ·{" "}
            {snapshot.project.scenes.reduce((count, item) => count + item.shots.length, 0)} 镜头
          </small>
        )}
      </button>
      {!!node.data?.blockoutPath && !outputEntries.length && <p className="nodeStatus" role="status">当前白模版本尚未发布参考；修改后须重新导出，历史文件保留。</p>}
      <NodeError className="blockoutError" error={error} />
      {open &&
        view &&
        snapshot &&
        scene &&
        shot &&
        createPortal(
          <div
            ref={dialog}
            className="openCinemaWorkbench blockoutReactDialog"
            role="dialog"
            aria-modal="true"
            aria-label="Blockout 场景与镜头"
            tabIndex={-1}
            onKeyDown={(event) => {
              event.stopPropagation();
              onEscape(event);
              if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ" && !locked) {
                event.preventDefault();
                void action(() => (event.shiftKey ? controller.redo() : controller.undo()));
              } else if (
                event.code === "Space" &&
                !(
                  event.target instanceof HTMLInputElement ||
                  event.target instanceof HTMLTextAreaElement ||
                  event.target instanceof HTMLSelectElement
                )
              ) {
                event.preventDefault();
                if (recorder.recording?.phase === "recording") recorder.stop();
                else setPlaying((value) => !value);
              }
            }}>
            <header className="blockoutHeader">
              <strong>Blockout</strong>
              <span>场景与镜头</span>
              <small>{saving ? "正在保存…" : status.busy ? status.phase : "OpenCinema"}</small>
              {status.busy && (
                <button
                  onClick={() =>
                    void controller
                      .callNodeTool(node.id, "cancelBlockout", {})
                      .catch((failure) => setError(errorText(failure)))
                  }>
                  取消任务
                </button>
              )}
              <button disabled={saving || status.busy} onClick={close}>
                <NodeIcon name="close" />{closeArmed ? "放弃录制并关闭" : "关闭"}
              </button>
            </header>
            {!!(node.data?.modelPath || node.data?.modelSnapshot) && (
              <p className="blockoutLegacy">旧导演台草稿已保留，Blockout 使用独立的场景文档。</p>
            )}
            <NodeError className="blockoutError" error={error || status.error} />
            <nav className="blockoutToolbar">
              <button disabled={locked} onClick={() => void action(() => controller.undo())}>
                <NodeIcon name="undo" />撤销
              </button>
              <button disabled={locked} onClick={() => void action(() => controller.redo())}>
                <NodeIcon name="redo" />重做
              </button>
              <select
                aria-label="场景"
                value={scene.id}
                onChange={(event) => selectScene(event.target.value)}>
                {snapshot.project.scenes.map((value) => (
                  <option value={value.id} key={value.id}>
                    {value.name}
                  </option>
                ))}
              </select>
              <button
                disabled={locked}
                onClick={() =>
                  void change((draft) => {
                    const next = createScene(draft.scenes.length + 1);
                    draft.scenes.push(next);
                    selectScene(next.id);
                  })
                }>
                新场景
              </button>
              <select
                aria-label="镜头"
                value={shot.id}
                onChange={(event) => {
                  setShotId(event.target.value);
                  setTime(0);
                  setPlaying(false);
                  setMarkId("");
                }}>
                {[...scene.shots, ...(scene.drafts ?? [])].map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.draftOf ? "备选 · " : ""}
                    {value.name}
                  </option>
                ))}
              </select>
              <button
                disabled={locked}
                onClick={() =>
                  void change((draft) => {
                    const nextScene = draft.scenes.find((item) => item.id === scene.id)!,
                      next = createShot(nextScene, `镜头 ${nextScene.shots.length + 1}`);
                    nextScene.shots.push(next);
                    setShotId(next.id);
                  })
                }>
                新镜头
              </button>
              <button
                disabled={locked}
                onClick={() => void edit([{ type: "saveDraft", ...scope }])}>
                保存备选
              </button>
              <button
                disabled={locked}
                onClick={() =>
                  void edit([
                    {
                      type: "createDialogueScene",
                      name: `双人对话 ${snapshot.project.scenes.length + 1}`,
                    },
                  ])
                }>
                双人对话场景
              </button>
              <button onClick={() => setInspectorOpen((value) => !value)}>
                <NodeIcon name={inspectorOpen ? "collapse" : "expand"} />{inspectorOpen ? "收起属性栏" : "展开属性栏"}
              </button>
              {shot.draftOf && (
                <>
                  <button
                    disabled={locked}
                    onClick={() => void edit([{ type: "promoteDraft", ...scope }])}>
                    采用备选
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => void edit([{ type: "removeDraft", ...scope }])}>
                    删除备选
                  </button>
                </>
              )}
              <label className="blockoutFieldRow">
                编辑范围
                <select
                  aria-label="编辑范围"
                  disabled={locked}
                  value={editScope}
                  onChange={(event) => {
                    setEditScope(event.target.value as typeof editScope);
                    setMarkId("");
                  }}>
                  <option value="take">当前 Take 走位</option>
                  <option value="scene">场景静态布景</option>
                </select>
              </label>
              {(["translate", "rotate", "scale"] as const).map((value, index) => (
                <button
                  className={mode === value ? "active" : ""}
                  disabled={
                    transformLocked ||
                    (!!markId && value !== "translate") ||
                    (editScope === "take" && value === "scale")
                  }
                  key={value}
                  onClick={() => setMode(value)}>
                  {["移动", "旋转", "缩放"][index]}
                </button>
              ))}
            </nav>
            {recorder.active && (
              <div className="blockoutRecordingBar" role="status">
                <strong>
                  {recorder.preparing
                    ? "正在准备录制"
                    : recorder.recording?.phase === "recording"
                      ? recorder.recording.kind === "camera"
                        ? "录制自由相机"
                        : "录制角色走位"
                      : "录制预览，尚未保存"}
                </strong>
                {recorder.notice && <span>{recorder.notice}</span>}
                {recorder.recording?.phase === "recording" ? (
                  <button onClick={() => recorder.stop()}>停止录制</button>
                ) : (
                  <>
                    <button disabled={baseLocked} onClick={() => setPlaying((value) => !value)}>
                      {playing ? "暂停预览" : "播放预览"}
                    </button>
                    <button disabled={baseLocked} onClick={() => void recorder.apply().catch(failure => setError(errorText(failure)))}>
                      {recorder.recording?.kind === "actor" ? "采用为新 Take" : "采用为新机位"}
                    </button>
                  </>
                )}
                <button disabled={baseLocked} onClick={() => recorder.discard()}>
                  丢弃录制
                </button>
              </div>
            )}
            <div className={`blockoutBody${inspectorOpen ? "" : " inspectorClosed"}`}>
              <aside className="blockoutLibrary">
                <h3>素材库</h3>
                <select
                  aria-label="素材分类"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}>
                  {[
                    "people",
                    "animals",
                    "vehicles",
                    "furniture",
                    "props",
                    "environment",
                    "primitives",
                  ].map((id, index) => (
                    <option key={id} value={id}>
                      {["人物", "动物", "车辆", "家具", "道具", "环境", "几何体"][index]}
                    </option>
                  ))}
                </select>
                <div className="blockoutAssetList">
                  {ASSET_CATALOG.filter((item) => item.category === category).map((asset) => (
                    <button
                      key={asset.id}
                      draggable={!locked}
                      onDragStart={(event) =>
                        event.dataTransfer.setData("application/x-opencinema-asset", asset.id)
                      }
                      disabled={locked}
                      onClick={() =>
                        void edit([
                          {
                            type: "addEntity",
                            sceneId: scene.id,
                            assetId: asset.id,
                            name: asset.name,
                            position: { x: 0, y: 0, z: 0 },
                          },
                        ])
                      }>
                      {asset.name}
                    </button>
                  ))}
                </div>
                <h3>场景物体</h3>
                <div className="blockoutEntityList">
                  {scene.entities.map((item) => (
                    <button
                      className={selectedIds.includes(item.id) ? "active" : ""}
                      key={item.id}
                      onClick={(event) => selectEntity(item.id, event.shiftKey)}>
                      {item.name}
                    </button>
                  ))}
                </div>
                <button
                  className={selected === "camera" ? "active" : ""}
                  onClick={() => selectEntity("camera")}>
                  相机走位
                </button>
                <label className="blockoutImport">
                  导入 GLB / glTF
                  <input
                    type="file"
                    accept=".glb,.gltf,.bin,.png,.jpg,.jpeg,.webp"
                    multiple
                    disabled={locked}
                    onChange={(event) => {
                      const resources = [...(event.target.files ?? [])],
                        model = resources.find((file) => /\.(glb|gltf)$/i.test(file.name));
                      if (model)
                        void action(() => service()!.importModel(model, scene.id, resources));
                      event.target.value = "";
                    }}
                  />
                </label>
                <label className="blockoutImport">
                  导入 glTF 资源目录
                  <input
                    type="file"
                    multiple
                    disabled={locked}
                    ref={(element) => {
                      element?.setAttribute("webkitdirectory", "");
                    }}
                    onChange={(event) => {
                      const resources = [...(event.target.files ?? [])],
                        model = resources.find((file) => /\.(glb|gltf)$/i.test(file.name));
                      if (model)
                        void action(() => service()!.importModel(model, scene.id, resources));
                      else if (resources.length) setError("目录中没有 GLB / glTF 模型");
                      event.target.value = "";
                    }}
                  />
                </label>
                <label className="blockoutImport">
                  导入 Gaussian 扫描
                  <input
                    type="file"
                    accept=".ply,.splat,.ksplat,.spz"
                    disabled={locked}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void action(() => service()!.importScan(file, scene.id));
                      event.target.value = "";
                    }}
                  />
                </label>
                {scene.scans?.map((scan) => (
                  <details className="blockoutScanRow" key={scan.id}>
                    <summary>{scan.name}</summary>
                    <label>
                      <input
                        type="checkbox"
                        checked={scan.visible}
                        disabled={locked}
                        onChange={(event) =>
                          void edit([
                            {
                              type: "updateScan",
                              sceneId: scene.id,
                              scanId: scan.id,
                              visible: event.target.checked,
                            },
                          ])
                        }
                      />
                      {scan.name}
                    </label>
                    {(["x", "y", "z"] as const).map((axis) => (
                      <NumberField
                        key={axis}
                        label={`扫描 ${axis.toUpperCase()} / m`}
                        value={scan.position[axis]}
                        disabled={locked}
                        onChange={(value) =>
                          void edit([
                            {
                              type: "updateScan",
                              sceneId: scene.id,
                              scanId: scan.id,
                              position: { ...scan.position, [axis]: value },
                            },
                          ])
                        }
                      />
                    ))}
                    <NumberField
                      label="扫描朝向 / 度"
                      value={(scan.rotationY * 180) / Math.PI}
                      disabled={locked}
                      onChange={(value) =>
                        void edit([
                          {
                            type: "updateScan",
                            sceneId: scene.id,
                            scanId: scan.id,
                            rotationY: (value * Math.PI) / 180,
                          },
                        ])
                      }
                    />
                    <NumberField
                      label="扫描比例"
                      value={scan.scale}
                      min={0.0001}
                      max={1000}
                      disabled={locked}
                      onChange={(scale) =>
                        void edit([
                          { type: "updateScan", sceneId: scene.id, scanId: scan.id, scale },
                        ])
                      }
                    />
                    <label className="blockoutCheck">
                      <input
                        type="checkbox"
                        checked={scan.flipped ?? false}
                        disabled={locked}
                        onChange={(event) =>
                          void edit([
                            {
                              type: "updateScan",
                              sceneId: scene.id,
                              scanId: scan.id,
                              flipped: event.target.checked,
                            },
                          ])
                        }
                      />
                      翻转扫描方向
                    </label>
                    <label className="blockoutCheck">
                      <input
                        type="checkbox"
                        checked={scan.holdout ?? false}
                        disabled={locked}
                        onChange={(event) =>
                          void edit([
                            {
                              type: "updateScan",
                              sceneId: scene.id,
                              scanId: scan.id,
                              holdout: event.target.checked,
                            },
                          ])
                        }
                      />
                      遮挡标记（保留元信息）
                    </label>
                    <button
                      disabled={locked}
                      onClick={() =>
                        void edit([{ type: "removeScan", sceneId: scene.id, scanId: scan.id }])
                      }>
                      移除
                    </button>
                  </details>
                ))}
              </aside>
              <section className="blockoutStage">
                <div className="blockoutStageTitle">
                  <strong>Stage</strong>
                  <span>拖动轴线变换 · Shift 多选 · 拖放素材布景</span>
                </div>
                <Viewport
                  engineRef={stage}
                  value={view}
                  onEvent={(name, ...args) => {
                    if (name === "select") selectEntity(args[0], args[1]);
                    if (name === "mark") {
                      setMarkId(args[0]);
                      setPlaying(false);
                      setTime(marks.find((item) => item.id === args[0])?.time ?? time);
                    }
                    if (name === "move") move(args[0], args[1], args[2], args[3], args[4]);
                    if (name === "place")
                      void edit([
                        {
                          type: "addEntity",
                          sceneId: scene.id,
                          assetId: args[0],
                          name: ASSET_CATALOG.find((item) => item.id === args[0])?.name ?? args[0],
                          position: args[1],
                        },
                      ]);
                  }}
                />
                <div className="blockoutPlayback">
                  <button onClick={() => setPlaying((value) => !value)}>
                    <NodeIcon name={playing ? "pause" : "play"} />{playing ? "暂停" : "播放"}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={shot.duration}
                    step={1 / shot.fps}
                    value={time}
                    aria-label="时间轴"
                    onChange={(event) => {
                      setPlaying(false);
                      setTime(Number(event.target.value));
                    }}
                  />
                  <span>
                    {time.toFixed(2)} / {shot.duration.toFixed(2)} s
                  </span>
                </div>
                <div className="blockoutMarkToolbar">
                  <strong>
                    {selected === "camera" ? "相机标记" : (entity?.name ?? "走位标记")}
                  </strong>
                  <button
                    disabled={locked || !selected || (selected !== "camera" && performanceLocked)}
                    onClick={() => void addMark()}>
                    添加标记
                  </button>
                  {take && (
                    <button
                      className={take.confirmed ? "active" : ""}
                      disabled={locked || take.confirmed}
                      onClick={() =>
                        void edit([{ type: "confirmTake", ...scope, confirmed: true }])
                      }>
                      {take.confirmed ? "已确认 Take" : "确认 Take"}
                    </button>
                  )}
                  <select
                    aria-label="表演 Take"
                    disabled={locked}
                    value={shot.blockingTakeId}
                    onChange={(event) =>
                      void changeShot((value) => {
                        value.blockingTakeId = event.target.value;
                      })
                    }>
                    {scene.blocking.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                        {value.confirmed ? " · 已确认" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={locked}
                    onClick={() =>
                      void edit([
                        { type: "forkTake", ...scope, name: `${take?.name ?? "Take"} 副本` },
                      ])
                    }>
                    复制 Take
                  </button>
                </div>
                <div className="blockoutRecordingControls">
                  <button disabled={locked} onClick={() => void recorder.start("camera").catch(failure => setError(errorText(failure)))}>
                    录制自由相机
                  </button>
                  <button disabled={locked || !entity} onClick={() => void recorder.start("actor").catch(failure => setError(errorText(failure)))}>
                    操演所选角色
                  </button>
                  <select
                    aria-label="角色操演精度"
                    disabled={locked}
                    value={recorder.precision}
                    onChange={(event) => recorder.setPrecision(event.target.value as any)}>
                    <option value="precise">精细 · 4 m/s</option>
                    <option value="normal">普通 · 12 m/s</option>
                    <option value="fast">快速 · 40 m/s</option>
                  </select>
                  <small>光标移入 Stage 追赶，滚轮调整高度；失焦停止。</small>
                </div>
                <div className="blockoutMarkList">
                  {marks.map((mark, index) => (
                    <button
                      className={markId === mark.id ? "active" : ""}
                      key={mark.id}
                      onClick={() => {
                        setMarkId(mark.id);
                        setTime(mark.time);
                        setPlaying(false);
                      }}>
                      {index + 1} · {mark.time.toFixed(2)}s
                    </button>
                  ))}
                </div>
                <div className="blockoutBottomTabs">
                  {[
                    ["properties", "属性"],
                    ["motion", "动作与运镜"],
                    ["group", "群组编排"],
                    ["reference", "视频参考"],
                    ["timeline", "时间轨"],
                    ["export", "导出"],
                    ["presets", "布景预设"],
                    ["document", "项目文档"],
                  ].map(([id, title]) => (
                    <button
                      className={panel === id ? "active" : ""}
                      key={id}
                      onClick={() => {
                        setPanel(id!);
                        if (id === "document") {
                          setJson(JSON.stringify(snapshot.project, null, 2));
                          setJsonRevision(snapshot.revision);
                        }
                        if (id === "presets") loadPresets();
                      }}>
                      {title}
                    </button>
                  ))}
                </div>
                {warnings.length > 0 && (
                  <details className="blockoutWarnings">
                    <summary>速度与连续性提示 · {warnings.length}</summary>
                    {warnings.map((warning, index) => (
                      <p key={index}>{warning}</p>
                    ))}
                  </details>
                )}
                {panel === "motion" && (
                  <div className="blockoutOptions">
                    <label>
                      运镜
                      <select
                        defaultValue=""
                        disabled={performanceLocked || !entity}
                        onChange={(event) => {
                          if (event.target.value)
                            void edit([
                              {
                                type: "applyCameraMove",
                                ...scope,
                                presetId: event.target.value,
                                subjectId: selected,
                              },
                            ]);
                          event.target.value = "";
                        }}>
                        <option value="">选择运镜</option>
                        {cameraMovePresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      关节动作
                      <select
                        defaultValue=""
                        disabled={performanceLocked || !entity}
                        onChange={(event) => {
                          if (event.target.value)
                            void edit([
                              {
                                type: "applyMotionPreset",
                                ...scope,
                                entityId: selected,
                                presetId: event.target.value,
                                time,
                              },
                            ]);
                          event.target.value = "";
                        }}>
                        <option value="">选择动作</option>
                        {motionPresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      根走位
                      <select
                        defaultValue=""
                        disabled={locked || !entity}
                        onChange={(event) => {
                          if (event.target.value)
                            void edit([
                              {
                                type: "applyActionPreset",
                                ...scope,
                                entityId: selected,
                                presetId: event.target.value,
                                time,
                              },
                            ]);
                          event.target.value = "";
                        }}>
                        <option value="">选择走位</option>
                        {actionPresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                {panel === "group" && (
                  <GroupControls
                    sceneId={scene.id}
                    shotId={shot.id}
                    duration={shot.duration}
                    entityIds={selectedEntityIds}
                    sharedShots={[...scene.shots, ...(scene.drafts ?? [])]
                      .filter(
                        (value) =>
                          value.id !== shot.id && value.blockingTakeId === shot.blockingTakeId,
                      )
                      .map((value) => value.name)}
                    disabled={performanceLocked}
                    onCommand={(command) => edit([command])}
                  />
                )}
                {panel === "reference" && (
                  <ReferenceControls
                    nodeId={node.id}
                    controller={controller}
                    service={service()!}
                    shot={shot}
                    sceneId={scene.id}
                    revision={snapshot.revision}
                    disabled={locked}
                    onAction={action}
                    onCommand={(command) => edit([command])}
                  />
                )}
                {panel === "timeline" && (
                  <section className="blockoutTimeline" aria-label="摄影与人物时间轨">
                    {[
                      {
                        entityId: "camera",
                        name: `相机 ${shot.cameraName ?? "A"}`,
                        marks: shot.camera.marks,
                      },
                      ...scene.entities.map((entity) => ({
                        entityId: entity.id,
                        name: entity.name,
                        marks:
                          take?.tracks.find((track) => track.entityId === entity.id)?.marks ?? [],
                      })),
                    ].map((track) => (
                      <div className="blockoutTimelineRow" key={track.entityId}>
                        <button onClick={() => selectEntity(track.entityId)}>{track.name}</button>
                        <div
                          className="blockoutTimelineTrack"
                          onDragOver={(event) => {
                            if (event.dataTransfer.types.includes("application/x-opencinema-mark"))
                              event.preventDefault();
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const payload = event.dataTransfer.getData(
                              "application/x-opencinema-mark",
                            );
                            if (!payload) return;
                            try {
                              const value = JSON.parse(payload);
                              if (
                                value.entityId !== track.entityId ||
                                typeof value.markId !== "string"
                              )
                                return;
                              const rect = event.currentTarget.getBoundingClientRect();
                              void retimeMark(
                                track.entityId,
                                value.markId,
                                ((event.clientX - rect.left) / rect.width) * shot.duration,
                              );
                            } catch {
                              setError("无法移动此标记，请重新选择");
                            }
                          }}
                          onDoubleClick={(event) => {
                            if (locked || (track.entityId !== "camera" && performanceLocked))
                              return;
                            const rect = event.currentTarget.getBoundingClientRect(),
                              at = Math.max(
                                0,
                                Math.min(
                                  shot.duration,
                                  ((event.clientX - rect.left) / rect.width) * shot.duration,
                                ),
                              );
                            const evaluator = new ShotEvaluator(scene, shot);
                            const evaluated = evaluator.evaluate(at);
                            void edit([
                              track.entityId === "camera"
                                ? {
                                    type: "setCameraMark",
                                    ...scope,
                                    mark: {
                                      ...createCameraMark(
                                        evaluated.camera.position,
                                        at,
                                        evaluated.camera.pan,
                                        evaluated.camera.tilt,
                                        evaluated.camera.focalLength,
                                      ),
                                      roll: evaluated.camera.roll,
                                    },
                                    space: "world",
                                  }
                                : {
                                    type: "setActorMark",
                                    ...scope,
                                    entityId: track.entityId,
                                    mark: createActorMark(
                                      evaluated.entities.find(
                                        (value) => value.entityId === track.entityId,
                                      )!.position,
                                      at,
                                      "walk",
                                    ),
                                  },
                            ]);
                          }}>
                          <i style={{ left: `${(time / shot.duration) * 100}%` }} />
                          {track.marks.map((mark) => (
                            <button
                              key={mark.id}
                              title={`${mark.time.toFixed(2)}s`}
                              aria-label={`${track.name} 标记 ${mark.time.toFixed(2)}秒`}
                              className={markId === mark.id ? "active" : ""}
                              style={{ left: `${Math.min(1, mark.time / shot.duration) * 100}%` }}
                              draggable={
                                !locked && (track.entityId === "camera" || !performanceLocked)
                              }
                              onDragStart={(event) =>
                                event.dataTransfer.setData(
                                  "application/x-opencinema-mark",
                                  JSON.stringify({ entityId: track.entityId, markId: mark.id }),
                                )
                              }
                              onClick={() => {
                                selectEntity(track.entityId);
                                setMarkId(mark.id);
                                setTime(mark.time);
                                setPlaying(false);
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    <div className="blockoutTimelineRow">
                      <button onClick={() => selectEntity("camera")}>摄影关注</button>
                      <div
                        className="blockoutTimelineTrack"
                        onDragOver={(event) => {
                          if (event.dataTransfer.types.includes("application/x-opencinema-focus"))
                            event.preventDefault();
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (locked) return;
                          const id = event.dataTransfer.getData("application/x-opencinema-focus"),
                            focus = shot.camera.focusMarks?.find((value) => value.id === id);
                          if (!focus) return;
                          const rect = event.currentTarget.getBoundingClientRect();
                          const at = Math.max(
                            0,
                            Math.min(
                              shot.duration,
                              Math.round(
                                ((event.clientX - rect.left) / rect.width) *
                                  shot.duration *
                                  shot.fps,
                              ) / shot.fps,
                            ),
                          );
                          void edit([
                            {
                              type: "trackCamera",
                              ...scope,
                              focusId: id,
                              entityId: focus.entityId,
                              transition: focus.transition,
                              time: at,
                            },
                          ]);
                        }}>
                        <i style={{ left: `${(time / shot.duration) * 100}%` }} />
                        {(shot.camera.focusMarks ?? []).map((focus) => (
                          <button
                            key={focus.id}
                            aria-label={`${focus.time.toFixed(2)}秒摄影关注`}
                            title={`${focus.time.toFixed(2)}s · ${scene.entities.find((value) => value.id === focus.entityId)?.name ?? "自由朝向"}`}
                            style={{ left: `${(focus.time / shot.duration) * 100}%` }}
                            draggable={!locked}
                            onDragStart={(event) =>
                              event.dataTransfer.setData("application/x-opencinema-focus", focus.id)
                            }
                            onClick={() => {
                              setTime(focus.time);
                              setPlaying(false);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <small>双击添加当前姿态，拖动标记调整时间；确认的 Take 需先复制。</small>
                  </section>
                )}
                {panel === "export" && (
                  <div className="blockoutOptions">
                    <NumberField
                      label="开始 / 秒"
                      value={exportStart}
                      min={0}
                      max={Math.max(0, (exportEnd ?? shot.duration) - 1 / exportFps)}
                      onChange={setExportStart}
                      disabled={locked}
                    />
                    <NumberField
                      label="结束 / 秒"
                      value={exportEnd ?? shot.duration}
                      min={exportStart + 1 / exportFps}
                      max={shot.duration}
                      onChange={setExportEnd}
                      disabled={locked}
                    />
                    <NumberField
                      label="导出帧率"
                      value={exportFps}
                      min={1}
                      max={60}
                      step={1}
                      onChange={setExportFps}
                      disabled={locked}
                    />
                    <label>
                      最长边
                      <select
                        value={exportSize}
                        disabled={locked}
                        onChange={(event) =>
                          setExportSize(Number(event.target.value) as 640 | 1280)
                        }>
                        <option value={640}>640 px</option>
                        <option value={1280}>1280 px</option>
                      </select>
                    </label>
                    <label className="blockoutCheck">
                      <input
                        type="checkbox"
                        checked={exportDepth}
                        disabled={locked}
                        onChange={(event) => setExportDepth(event.target.checked)}
                      />
                      几何 Depth
                    </label>
                    <label className="blockoutCheck">
                      <input
                        type="checkbox"
                        checked={exportNormal}
                        disabled={locked}
                        onChange={(event) => setExportNormal(event.target.checked)}
                      />
                      几何 Normal
                    </label>
                    {exportDepth && (
                      <>
                        <NumberField
                          label="Depth 近端 / m"
                          value={depthNear}
                          min={0.05}
                          max={depthFar - 0.01}
                          onChange={setDepthNear}
                          disabled={locked}
                        />
                        <NumberField
                          label="Depth 远端 / m"
                          value={depthFar}
                          min={depthNear + 0.01}
                          max={5000}
                          onChange={setDepthFar}
                          disabled={locked}
                        />
                      </>
                    )}
                    <label className="blockoutCheck">
                      <input
                        type="checkbox"
                        checked={showLabels}
                        disabled={locked}
                        onChange={(event) => setShowLabels(event.target.checked)}
                      />
                      静帧显示标签
                    </label>
                    {[
                      ["video", "RGB / 控制视频"],
                      ["animatic", "场景 Animatic"],
                      ["stills", "关键帧 ZIP"],
                      ["contactSheet", "镜头联系表"],
                      ["topDown", "正交俯视图"],
                      ["scene", "GLB 交付"],
                    ].map(([id, title]) => (
                      <button key={id} disabled={locked} onClick={() => void exportMedia(id!)}>
                        {title}
                      </button>
                    ))}
                    {status.busy && (
                      <>
                        <progress value={status.progress} max={100} />
                        <span>{status.phase}</span>
                        <button
                          onClick={() =>
                            void controller.callNodeTool(node.id, "cancelBlockout", {})
                          }>
                          取消
                        </button>
                      </>
                    )}
                    {node.data?.outputs && (node.data.outputs as Record<string, any>).video?.value && <button disabled={locked} onClick={() => void action(() => controller.callNodeTool(node.id, "freezeBlockoutReference", { expectedRevision: snapshot.revision, sceneId: scene.id, shotId: shot.id, layers: (node.data?.outputs as Record<string, any>).depth?.value ? ["rgb", "depth"] : ["rgb"] }))}>固定为本镜参考节点</button>}
                    {outputEntries.map(([name, output]) => (
                      <button
                        key={name}
                        onClick={async () => {
                          const value = await controller.acquireMedia(
                            output.value.url,
                            output.value.mimeType,
                          );
                          const link = document.createElement("a");
                          link.href = value.url;
                          link.download = output.value.url.split("/").at(-1);
                          link.click();
                          setTimeout(value.release, 30000);
                        }}>
                        <NodeIcon name="download" />{name}
                      </button>
                    ))}
                  </div>
                )}
                {panel === "presets" && (
                  <div className="blockoutOptions">
                    <button
                      disabled={locked}
                      onClick={() =>
                        void action(() =>
                          controller.callNodeTool(node.id, "saveBlockoutStagePreset", {
                            sceneId: scene.id,
                            name: scene.name,
                          }),
                        ).then(loadPresets)
                      }>
                      保存当前布景
                    </button>
                    {presetList.map((value) => (
                      <div key={value.id}>
                        <button
                          disabled={locked}
                          onClick={() =>
                            void action(() =>
                              controller.callNodeTool(node.id, "applyBlockoutStagePreset", {
                                id: value.id,
                                expectedRevision: snapshot.revision,
                              }),
                            )
                          }>
                          {value.name}
                        </button>
                        {removingPreset === value.id ? (
                          <>
                            <button
                              disabled={locked}
                              onClick={() => {
                                setRemovingPreset("");
                                void action(() =>
                                  controller.callNodeTool(node.id, "removeBlockoutStagePreset", {
                                    id: value.id,
                                  }),
                                ).then(loadPresets);
                              }}>
                              确认删除
                            </button>
                            <button onClick={() => setRemovingPreset("")}>保留</button>
                          </>
                        ) : (
                          <button disabled={locked} onClick={() => setRemovingPreset(value.id)}>
                            删除
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {panel === "document" && (
                  <div className="blockoutDocument">
                    <textarea
                      aria-label="完整 Blockout 项目 JSON"
                      readOnly={locked}
                      value={json}
                      onChange={(event) => setJson(event.target.value)}
                    />
                    <button
                      disabled={locked}
                      onClick={() =>
                        void action(() =>
                          controller.callNodeTool(node.id, "setBlockoutProject", {
                            project: JSON.parse(json),
                            expectedRevision: jsonRevision,
                          }),
                        )
                      }>
                      验证并保存完整项目
                    </button>
                    <button
                      onClick={() => {
                        const url = URL.createObjectURL(
                            new Blob([JSON.stringify(snapshot.project, null, 2)], {
                              type: "application/json",
                            }),
                          ),
                          link = document.createElement("a");
                        link.href = url;
                        link.download = "blockout.json";
                        link.click();
                        URL.revokeObjectURL(url);
                      }}>
                      下载项目 JSON
                    </button>
                    <label className="blockoutImport">
                      导入项目 JSON
                      <input
                        type="file"
                        accept=".json"
                        disabled={locked}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file)
                            void action(async () =>
                              controller.callNodeTool(node.id, "setBlockoutProject", {
                                project: JSON.parse(await file.text()),
                                expectedRevision: snapshot.revision,
                              }),
                            );
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                )}
              </section>
              <aside className="blockoutInspector" hidden={!inspectorOpen}>
                <h3>Shoot · 镜头监看</h3>
                <div className="blockoutMonitor">
                  <Viewport
                    engineRef={monitor}
                    value={{
                      ...view,
                      shot: recorder.monitorShot ?? shot,
                      selected: "",
                      selectedIds: [],
                      markId: "",
                      cameraView: true,
                    }}
                  />
                  <ReferencePreview
                    reference={shot.referenceVideo}
                    nodeId={node.id}
                    controller={controller}
                    time={time}
                    playing={playing}
                    aspect={shot.aspect}
                  />
                </div>
                <ShotControls
                  scene={scene}
                  shot={shot}
                  time={time}
                  selectedIds={selectedEntityIds}
                  disabled={locked}
                  onCommand={(command) => edit([command])}
                  onTime={(value) => {
                    setTime(value);
                    setPlaying(false);
                  }}
                />
                <label className="blockoutField">
                  <span>镜头名称</span>
                  <input
                    key={`${shot.id}:${shot.name}`}
                    defaultValue={shot.name}
                    disabled={locked}
                    onBlur={(event) => {
                      if (event.target.value !== shot.name)
                        void changeShot((value) => {
                          value.name = event.target.value;
                        });
                    }}
                  />
                </label>
                <NumberField
                  label="时长 / 秒"
                  value={shot.duration}
                  min={0.2}
                  max={300}
                  onChange={(value) =>
                    void changeShot((item) => {
                      item.duration = value;
                    })
                  }
                  disabled={locked}
                />
                <NumberField
                  label="帧率"
                  value={shot.fps}
                  min={1}
                  max={60}
                  step={1}
                  onChange={(value) =>
                    void changeShot((item) => {
                      item.fps = value;
                    })
                  }
                  disabled={locked}
                />
                <label className="blockoutField">
                  <span>画幅</span>
                  <select
                    value={shot.aspect}
                    disabled={locked}
                    onChange={(event) =>
                      void changeShot((value) => {
                        value.aspect = event.target.value as typeof shot.aspect;
                      })
                    }>
                    {Object.keys(ASPECT_RATIOS).map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="blockoutField">
                  <span>传感器</span>
                  <select
                    value={shot.camera.sensorId}
                    disabled={locked}
                    onChange={(event) =>
                      void changeShot((value) => {
                        value.camera.sensorId = event.target.value as typeof shot.camera.sensorId;
                      })
                    }>
                    {Object.values(SENSORS).map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="blockoutField">
                  <span>相机支撑</span>
                  <select
                    value={shot.camera.rig}
                    disabled={locked}
                    onChange={(event) =>
                      void changeShot((value) => {
                        value.camera.rig = event.target.value as typeof shot.camera.rig;
                      })
                    }>
                    {Object.values(RIGS).map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </select>
                </label>
                <NumberField
                  label="扰动强度"
                  value={shot.camera.rigIntensity}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) =>
                    void changeShot((item) => {
                      item.camera.rigIntensity = value;
                    })
                  }
                  disabled={locked}
                />
                <label className="blockoutField">
                  <span>场景光照</span>
                  <select
                    value={scene.environment.lighting}
                    disabled={locked}
                    onChange={(event) =>
                      void edit([
                        { type: "setEnvironment", sceneId: scene.id, lighting: event.target.value },
                      ])
                    }>
                    {lightingPresets.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </select>
                </label>
                <details className="blockoutParityPanel">
                  <summary>太阳与雾</summary>
                  <NumberField
                    label="太阳方位 / 度"
                    value={(scene.environment.sunAzimuth * 180) / Math.PI}
                    onChange={(value) =>
                      void edit([
                        {
                          type: "setEnvironment",
                          sceneId: scene.id,
                          sunAzimuth: (value * Math.PI) / 180,
                        },
                      ])
                    }
                    disabled={locked}
                  />
                  <NumberField
                    label="太阳高度 / 度"
                    value={(scene.environment.sunElevation * 180) / Math.PI}
                    onChange={(value) =>
                      void edit([
                        {
                          type: "setEnvironment",
                          sceneId: scene.id,
                          sunElevation: (value * Math.PI) / 180,
                        },
                      ])
                    }
                    disabled={locked}
                  />
                  <NumberField
                    label="雾密度"
                    value={scene.environment.fog}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(fog) =>
                      void edit([{ type: "setEnvironment", sceneId: scene.id, fog }])
                    }
                    disabled={locked}
                  />
                </details>
                {entity && (
                  <>
                    <h3>{entity.name}</h3>
                    <label className="blockoutField">
                      <span>名称</span>
                      <input
                        key={`${entity.id}:${entity.name}`}
                        defaultValue={entity.name}
                        disabled={locked}
                        onBlur={(event) =>
                          void changeEntity((value) => {
                            value.name = event.target.value;
                          })
                        }
                      />
                    </label>
                    <NumberField
                      label="朝向 / 弧度"
                      value={
                        editScope === "take"
                          ? (entityState?.heading ?? entity.transform.rotationY)
                          : entity.transform.rotationY
                      }
                      onChange={(value) =>
                        move(
                          selected,
                          "",
                          displayPosition ?? entity.transform.position,
                          value,
                          entity.transform.scale,
                        )
                      }
                      disabled={transformLocked || !!markId}
                    />
                    <NumberField
                      label="比例"
                      value={entity.transform.scale}
                      min={0.01}
                      max={1000}
                      onChange={(value) =>
                        void changeEntity((item) => {
                          item.transform.scale = value;
                        })
                      }
                      disabled={locked || editScope !== "scene"}
                    />
                    <label className="blockoutField">
                      <span>人物看向</span>
                      <select
                        disabled={performanceLocked}
                        value={actorMark?.lookAtEntityId ?? ""}
                        onChange={(event) =>
                          void edit([
                            {
                              type: "lookAt",
                              ...scope,
                              entityId: entity.id,
                              targetId: event.target.value || null,
                              time,
                            },
                          ])
                        }>
                        <option value="">按走位和朝向</option>
                        {scene.entities
                          .filter((value) => value.id !== entity.id)
                          .map((value) => (
                            <option key={value.id} value={value.id}>
                              {value.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="blockoutField">
                      <span>附着到 · 独立走位前生效</span>
                      <select
                        disabled={performanceLocked}
                        value={entity.attachedTo ?? ""}
                        onChange={(event) =>
                          void edit([
                            {
                              type: "attachEntity",
                              ...scope,
                              entityId: entity.id,
                              targetId: event.target.value || null,
                              time,
                            },
                          ])
                        }>
                        <option value="">独立物体</option>
                        {scene.entities
                          .filter((value) => value.id !== entity.id)
                          .map((value) => (
                            <option key={value.id} value={value.id}>
                              {value.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="blockoutCheck">
                      <input
                        type="checkbox"
                        checked={entity.excludeFromExport ?? false}
                        disabled={locked || editScope !== "scene"}
                        onChange={(event) =>
                          void changeEntity((value) => {
                            value.excludeFromExport = event.target.checked;
                          })
                        }
                      />
                      仅编辑可见，导出时隐藏
                    </label>
                    <label className="blockoutField">
                      <span>标记颜色</span>
                      <input
                        type="color"
                        value={entity.label?.color ?? "#5eead4"}
                        disabled={locked}
                        onChange={(event) =>
                          void changeEntity((value) => {
                            value.label = {
                              text: value.label?.text ?? value.name,
                              color: event.target.value,
                            };
                          })
                        }
                      />
                    </label>
                    {entity.assetId.startsWith("person.") && (
                      <>
                        <NumberField
                          label="场景身高系数"
                          value={Number(entity.params?.height ?? 1)}
                          min={0.8}
                          max={1.2}
                          step={0.01}
                          disabled={locked || editScope !== "scene"}
                          onChange={(height) =>
                            void changeEntity((value) => {
                              value.params = { ...value.params, height };
                            })
                          }
                        />
                        <NumberField
                          label="场景身宽系数"
                          value={Number(entity.params?.build ?? 1)}
                          min={0.8}
                          max={1.3}
                          step={0.01}
                          disabled={locked || editScope !== "scene"}
                          onChange={(build) =>
                            void changeEntity((value) => {
                              value.params = { ...value.params, build };
                            })
                          }
                        />
                        <label className="blockoutField">
                          <span>静态姿态</span>
                          <select
                            value={String(entity.params?.pose ?? "stand")}
                            disabled={locked || editScope !== "scene"}
                            onChange={(event) =>
                              void changeEntity((value) => {
                                value.params = { ...value.params, pose: event.target.value };
                              })
                            }>
                            {personPoses.map((value) => (
                              <option key={value.id} value={value.id}>
                                {value.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <details className="blockoutParityPanel">
                          <summary>场景静态关节 · 18 项</summary>
                          {personJoints.map((joint) => (
                            <NumberField
                              key={joint.key}
                              label={`${joint.name} / 度`}
                              value={
                                (Number(entity.params?.[`joint_${joint.key}`] ?? 0) * 180) / Math.PI
                              }
                              min={-joint.rangeDegrees}
                              max={joint.rangeDegrees}
                              step={1}
                              disabled={locked || editScope !== "scene"}
                              onChange={(value) =>
                                void changeEntity((item) => {
                                  item.params = {
                                    ...item.params,
                                    [`joint_${joint.key}`]: (value * Math.PI) / 180,
                                  };
                                })
                              }
                            />
                          ))}
                          <button
                            disabled={locked || editScope !== "scene"}
                            onClick={() =>
                              void changeEntity((value) => {
                                for (const joint of personJoints)
                                  delete value.params?.[`joint_${joint.key}`];
                              })
                            }>
                            重置静态关节
                          </button>
                        </details>
                      </>
                    )}
                    <button
                      disabled={locked || editScope !== "scene"}
                      onClick={() =>
                        void change((draft) => {
                          const value = draft.scenes.find((item) => item.id === scene.id)!;
                          value.entities = value.entities.filter((item) => item.id !== selected);
                          for (const item of value.entities)
                            if (item.attachedTo === selected) {
                              delete item.attachedTo;
                              delete item.attachedLocal;
                            }
                          value.blocking.forEach((take) => {
                            take.tracks = take.tracks.filter((item) => item.entityId !== selected);
                            for (const track of take.tracks)
                              for (const mark of track.marks) {
                                if (mark.lookAtEntityId === selected) delete mark.lookAtEntityId;
                                if (mark.attachTo === selected) delete mark.attachTo;
                              }
                          });
                          for (const item of [...value.shots, ...(value.drafts ?? [])])
                            for (const camera of [
                              item.camera,
                              ...(item.cameraBank?.map((entry) => entry.camera) ?? []),
                            ]) {
                              if (camera.mountEntityId === selected) delete camera.mountEntityId;
                              if (camera.trackEntityId === selected) delete camera.trackEntityId;
                              for (const mark of camera.focusMarks ?? [])
                                if (mark.entityId === selected) mark.entityId = null;
                            }
                          setSelected("");
                          setSelectedIds([]);
                        })
                      }>
                      删除所选物体
                    </button>
                  </>
                )}
                {displayPosition &&
                  (["x", "y", "z"] as const).map((axis) => (
                    <NumberField
                      key={axis}
                      label={`位置 ${axis.toUpperCase()} / m`}
                      value={displayPosition[axis]}
                      disabled={transformLocked || (!!actorMark && performanceLocked)}
                      onChange={(value) =>
                        void (activeMark
                          ? changeMark((mark) => {
                              mark.position[axis] = value;
                            })
                          : move(
                              selected,
                              "",
                              { ...displayPosition, [axis]: value },
                              editScope === "take"
                                ? (entityState?.heading ?? entity!.transform.rotationY)
                                : entity!.transform.rotationY,
                              entity!.transform.scale,
                            ))
                      }
                    />
                  ))}
                {activeMark && (
                  <>
                    <h3>标记</h3>
                    {(["time", "hold", "easeIn", "easeOut"] as const).map((field, index) => (
                      <NumberField
                        key={field}
                        label={["到达 / 秒", "停留 / 秒", "缓入", "缓出"][index]!}
                        value={activeMark[field]}
                        min={0}
                        max={index < 2 ? shot.duration : 1}
                        disabled={locked || (!!actorMark && performanceLocked)}
                        onChange={(value) =>
                          void changeMark((mark) => {
                            mark[field] = value;
                          })
                        }
                      />
                    ))}
                    {actorMark && (
                      <label className="blockoutField">
                        <span>步态</span>
                        <select
                          value={actorMark.gait}
                          disabled={performanceLocked}
                          onChange={(event) =>
                            void changeMark((mark) => {
                              (mark as ActorMark).gait = event.target.value as ActorMark["gait"];
                            })
                          }>
                          {Object.values(GAITS).map((value) => (
                            <option key={value.id} value={value.id}>
                              {value.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {actorMark && (
                      <details className="blockoutParityPanel" title={entity && assetSpec(entity.assetId).motion === "wheeled" ? "相邻路径首尾标记均设置车头朝向，可独立于行进方向插值用于漂移；任一端恢复行进朝向后沿路径转向。" : undefined}>
                        <summary>标记朝向、登车与关节</summary>
                        <NumberField
                          label={entity && assetSpec(entity.assetId).motion === "wheeled" ? "车头朝向 / 弧度" : "到达朝向 / 弧度"}
                          value={actorMark.arriveHeading ?? 0}
                          disabled={performanceLocked}
                          onChange={(arriveHeading) =>
                            void changeMark((value) => {
                              (value as ActorMark).arriveHeading = arriveHeading;
                            })
                          }
                        />
                        <button
                          disabled={performanceLocked || actorMark.arriveHeading === undefined}
                          onClick={() =>
                            void changeMark((value) => {
                              delete (value as ActorMark).arriveHeading;
                            })
                          }>
                          使用行进朝向
                        </button>
                        <label className="blockoutField">
                          <span>抵达后登车 / 附着</span>
                          <select
                            disabled={performanceLocked}
                            value={actorMark.attachTo ?? ""}
                            onChange={(event) =>
                              void changeMark((value) => {
                                if (event.target.value)
                                  (value as ActorMark).attachTo = event.target.value;
                                else delete (value as ActorMark).attachTo;
                              })
                            }>
                            <option value="">不登车</option>
                            {scene.entities
                              .filter((value) => value.id !== selected)
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {value.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        {personJoints.map((joint) => (
                          <NumberField
                            key={joint.key}
                            label={`${joint.name} / 度`}
                            value={((actorMark.joints?.[joint.key] ?? 0) * 180) / Math.PI}
                            min={-joint.rangeDegrees}
                            max={joint.rangeDegrees}
                            step={1}
                            disabled={performanceLocked}
                            onChange={(angle) =>
                              void changeMark((value) => {
                                const mark = value as ActorMark;
                                mark.joints = {
                                  ...mark.joints,
                                  [joint.key]: (angle * Math.PI) / 180,
                                };
                              })
                            }
                          />
                        ))}
                        <button
                          disabled={performanceLocked}
                          onClick={() =>
                            void changeMark((value) => {
                              delete (value as ActorMark).joints;
                            })
                          }>
                          重置标记关节
                        </button>
                      </details>
                    )}
                    {cameraMark && (
                      <label className="blockoutField">
                        <span>焦距快捷选择 / mm</span>
                        <select
                          disabled={locked}
                          value={cameraMark.focalLength}
                          onChange={(event) =>
                            void changeMark((value) => {
                              (value as CameraMark).focalLength = Number(event.target.value);
                            })
                          }>
                          {!LENS_SET.includes(cameraMark.focalLength) && (
                            <option value={cameraMark.focalLength}>
                              保存值 {cameraMark.focalLength}
                            </option>
                          )}
                          {LENS_SET.map((lens) => (
                            <option key={lens} value={lens}>
                              {lens}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {cameraMark &&
                      (["focalLength", "pan", "tilt", "roll"] as const).map((field) => (
                        <NumberField
                          key={field}
                          label={
                            field === "roll"
                              ? "侧倾 Roll / 度"
                              : field === "focalLength"
                                ? "焦距 / mm"
                                : `${field} / 弧度`
                          }
                          value={
                            field === "roll" ? (cameraMark.roll * 180) / Math.PI : cameraMark[field]
                          }
                          min={field === "focalLength" ? 8 : field === "roll" ? -180 : undefined}
                          max={field === "focalLength" ? 300 : field === "roll" ? 180 : undefined}
                          disabled={locked}
                          onChange={(value) =>
                            void changeMark((mark) => {
                              (mark as CameraMark)[field] =
                                field === "roll" ? (value * Math.PI) / 180 : value;
                            })
                          }
                        />
                      ))}
                    {cameraMark && (
                      <>
                        <NumberField
                          label="对焦距离 / m"
                          value={cameraMark.focusDistance ?? 10}
                          min={0.01}
                          max={100000}
                          disabled={locked}
                          onChange={(focusDistance) =>
                            void changeMark((value) => {
                              (value as CameraMark).focusDistance = focusDistance;
                            })
                          }
                        />
                        <button
                          disabled={locked || cameraMark.focusDistance === undefined}
                          onClick={() =>
                            void changeMark((value) => {
                              delete (value as CameraMark).focusDistance;
                            })
                          }>
                          使用深焦 / 自动关注距离
                        </button>
                      </>
                    )}
                    <details className="blockoutParityPanel">
                      <summary>进入此标记的路径控制点 · {activeMark.via?.length ?? 0}</summary>
                      {(activeMark.via ?? []).map((point, index) => (
                        <div key={index}>
                          {(["x", "y", "z"] as const).map((axis) => (
                            <NumberField
                              key={axis}
                              label={`${index + 1} · ${axis.toUpperCase()} / m`}
                              value={point[axis]}
                              disabled={locked || (!!actorMark && performanceLocked)}
                              onChange={(coordinate) =>
                                void changeMark((value) => {
                                  value.via![index]![axis] = coordinate;
                                })
                              }
                            />
                          ))}
                          <button
                            disabled={locked || (!!actorMark && performanceLocked)}
                            onClick={() =>
                              void changeMark((value) => {
                                value.via!.splice(index, 1);
                              })
                            }>
                            删除控制点
                          </button>
                        </div>
                      ))}
                      <button
                        disabled={locked || (!!actorMark && performanceLocked)}
                        onClick={() =>
                          void changeMark((value) => {
                            value.via = [...(value.via ?? []), { ...value.position }];
                          })
                        }>
                        添加路径控制点
                      </button>
                    </details>
                    <button
                      disabled={locked || (!!actorMark && performanceLocked)}
                      onClick={() =>
                        void change((draft) => {
                          const value = draft.scenes.find((item) => item.id === scene.id)!,
                            targetShot = [...value.shots, ...(value.drafts ?? [])].find(
                              (item) => item.id === shot.id,
                            )!;
                          if (selected === "camera")
                            targetShot.camera.marks = targetShot.camera.marks.filter(
                              (item) => item.id !== markId,
                            );
                          else {
                            const track = value.blocking
                              .find((item) => item.id === targetShot.blockingTakeId)!
                              .tracks.find((item) => item.entityId === selected)!;
                            track.marks = track.marks.filter((item) => item.id !== markId);
                          }
                          setMarkId("");
                        })
                      }>
                      删除标记
                    </button>
                  </>
                )}
              </aside>
            </div>
            <footer className="blockoutFooter">
              <span>Blockout core · Sam Wasserman</span>
              <span>场景随工作区保存 · 全部修改使用统一画布历史</span>
            </footer>
          </div>,
          document.body,
        )}
    </div>
  );
}
