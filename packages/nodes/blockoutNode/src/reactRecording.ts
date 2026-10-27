import { useEffect, useMemo, useRef, useState } from "react";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import {
  actorRecordingMark,
  createActorRecordingSource,
  sampleActorRecording,
  sampleCameraRecording,
  recordingCamera,
  type ActorRecordingSample,
  type RecordingSample,
  type RecordPrecision,
} from "./recording";
import type { createBlockoutViewport } from "./reactViewportEngine";
import type { ActorMark, CameraMark, Scene, Shot } from "./nativeBlockout/types";

type Base = {
  phase: "recording" | "review";
  revision: string;
  sceneId: string;
  shotId: string;
  takeId: string;
  cameraName: string;
  start: number;
  end: number;
  startedAt: number;
  lastFrameAt: number;
  precision: RecordPrecision;
};
type Recording = Base &
  (
    | { kind: "camera"; marks: CameraMark[]; last: RecordingSample; lens: number }
    | {
        kind: "actor";
        entityId: string;
        marks: ActorMark[];
        last: ActorRecordingSample;
        source: ReturnType<typeof createActorRecordingSource>;
      }
  );
type Options = {
  stage: { current: ReturnType<typeof createBlockoutViewport> | undefined };
  scene?: Scene;
  shot?: Shot;
  revision?: string;
  time: number;
  selected: string;
  disabled?: boolean;
  setTime(value: number): void;
  setPlaying(value: boolean): void;
  apply(command: Record<string, unknown>, revision: string, signal?: AbortSignal): Promise<boolean>;
};
export function useBlockoutRecording(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const current = useRef<Recording>(undefined),
    preparingRef = useRef(false),
    [recording, setRecording] = useState<Recording>(),
    [notice, setNotice] = useState(""),
    [precision, setPrecision] = useState<RecordPrecision>("normal"),
    [preparing, setPreparing] = useState(false);
  const valid = (session: Base) => {
    const value = latest.current;
    return (
      !value.disabled &&
      value.revision === session.revision &&
      value.scene?.id === session.sceneId &&
      value.shot?.id === session.shotId &&
      value.shot?.blockingTakeId === session.takeId &&
      (value.shot.cameraName ?? "A") === session.cameraName
    );
  };
  function stop(reason?: string) {
    const session = current.current;
    if (!session || session.phase !== "recording") return;
    if (session.kind === "actor")
      sampleActorRecording(session.marks, session.last, session.last, true);
    else sampleCameraRecording(session.marks, session.last, session.last, true);
    latest.current.stage.current?.endActorControl();
    session.phase = "review";
    setRecording({ ...session });
    latest.current.setPlaying(false);
    latest.current.setTime(session.start);
    setNotice(
      reason ??
        (session.last.time - session.start < 0.25 - 1e-7
          ? "录制短于 0.25 秒，请丢弃后重录"
          : "录制尚未保存。采用后保留原机位或 Take。"),
    );
  }
  async function start(kind: "camera" | "actor", signal?: AbortSignal, requestedPrecision = precision) {
    const value = latest.current;
    signal?.throwIfAborted();
    if (current.current || preparingRef.current) throw new Error("已有录制或录制正在准备，请先停止并采用或丢弃");
    if (value.disabled) throw new Error("当前编辑台不可录制，请等待操作结束或检查编辑权限");
    preparingRef.current = true;
    setPreparing(true);
    setNotice("");
    value.setPlaying(false);
    setPrecision(requestedPrecision);
    try {
      const { scene, shot, revision, stage } = value;
      if (!scene || !shot || !revision || !stage.current) throw new Error("场景尚未就绪");
      if (document.hidden || !document.hasFocus())
        throw new Error("请在当前窗口可见且拥有焦点时录制");
      if (
        kind === "actor" &&
        (scene.blocking.length >= 100 ||
          !scene.entities.some((entity) => entity.id === value.selected))
      )
        throw new Error("请选择一个可录制角色/物体，并保留新 Take 空间");
      const start = value.time,
        end = Math.min(shot.duration, start + 60);
      if (end - start < 0.25) throw new Error("距离镜尾不足 0.25 秒，请前移时间轴");
      await stage.current.ready();
      signal?.throwIfAborted();
      const base: Base = {
        phase: "recording",
        revision,
        sceneId: scene.id,
        shotId: shot.id,
        takeId: shot.blockingTakeId,
        cameraName: shot.cameraName ?? "A",
        start,
        end,
        startedAt: performance.now(),
        lastFrameAt: performance.now(),
        precision: requestedPrecision,
      };
      if (!valid(base)) throw new Error("准备期间场景或权限已变化");
      let session: Recording;
      if (kind === "actor") {
        const source = createActorRecordingSource(scene, shot, value.selected),
          pose = new ShotEvaluator(scene, shot)
            .evaluate(start)
            .entities.find((entity) => entity.entityId === value.selected)!;
        const first = { position: { ...pose.position }, heading: pose.heading, time: start },
          marks: ActorMark[] = [];
        sampleActorRecording(marks, first, first);
        stage.current.beginActorControl(first.position, first.heading, requestedPrecision);
        session = { ...base, kind, entityId: value.selected, source, marks, last: first };
      } else {
        const pose = stage.current.getCamera(),
          first = { ...pose, time: start },
          marks: CameraMark[] = [];
        sampleCameraRecording(marks, first, first);
        session = { ...base, kind, marks, last: first, lens: pose.focalLength };
      }
      current.current = session;
      setRecording({ ...session });
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "录制准备失败");
      throw failure;
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }
  useEffect(() => {
    if (recording?.phase !== "recording") return;
    let frame = 0;
    const tick = (now: number) => {
      const session = current.current;
      if (!session || session.phase !== "recording") return;
      try {
        if (!valid(session)) throw new Error("版本、机位或权限变化，已保留实际录制");
        if (document.hidden || !document.hasFocus() || now - session.lastFrameAt > 500)
          throw new Error("窗口失焦、隐藏或长帧中断，已保留此前实际采样");
        const stage = latest.current.stage.current;
        if (!stage) throw new Error("三维视口已关闭");
        const time = Math.min(session.end, session.start + (now - session.startedAt) / 1000);
        if (session.kind === "actor") {
          const pose = stage.sampleActorControl((now - session.lastFrameAt) / 1000),
            sample = { ...pose, time };
          sampleActorRecording(session.marks, session.last, sample);
          session.last = sample;
        } else {
          const sample = { ...stage.getCamera(), time };
          sampleCameraRecording(session.marks, session.last, sample);
          session.last = sample;
        }
        session.lastFrameAt = now;
        latest.current.setTime(time);
        setRecording({ ...session });
        if (time >= session.end) stop();
        else frame = requestAnimationFrame(tick);
      } catch (failure) {
        stop(failure instanceof Error ? failure.message : "录制中断");
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recording?.phase]);
  useEffect(
    () => () => {
      latest.current.stage.current?.endActorControl();
      current.current = undefined;
    },
    [],
  );
  function discard() {
    latest.current.stage.current?.endActorControl();
    const start = current.current?.start;
    current.current = undefined;
    setRecording(undefined);
    setNotice("");
    latest.current.setPlaying(false);
    if (start !== undefined) latest.current.setTime(start);
  }
  async function apply(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const session = current.current;
    if (!session || session.phase !== "review") throw new Error("请先停止实际录制，再采用录制草稿");
    try {
      if (!valid(session)) throw new Error("录制源版本已变化，原录制保留，请丢弃后重新读取");
      if (session.last.time - session.start < 0.25 - 1e-7)
        throw new Error("录制至少需要 0.25 秒实际采样");
      const scope = { sceneId: session.sceneId, shotId: session.shotId };
      const command =
        session.kind === "actor"
          ? {
              type: "recordActor",
              ...scope,
              sourceTakeId: session.takeId,
              entityId: session.entityId,
              marks: session.marks.map(({ position, time, gait, arriveHeading }) => ({
                position,
                time,
                gait,
                arriveHeading,
              })),
            }
          : {
              type: "recordCamera",
              ...scope,
              sourceCameraName: session.cameraName,
              marks: session.marks.map(({ position, time, pan, tilt, roll, focalLength }) => ({
                position,
                time,
                pan,
                tilt,
                roll,
                focalLength,
              })),
            };
      if (!(await latest.current.apply(command, session.revision, signal))) throw new Error("录制保存未完成，草稿保留");
      discard();
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "录制保存失败，草稿保留");
      throw failure;
    }
  }
  const session = recording;
  const actorPreview = useMemo(
    () =>
      session?.kind === "actor"
        ? {
            entityId: session.entityId,
            marks: session.source.track(
              session.phase === "recording" && session.last.time > session.marks.at(-1)!.time + 1e-7
                ? [...session.marks, actorRecordingMark(session.marks.at(-1), session.last)]
                : session.marks,
            ),
          }
        : undefined,
    [session?.kind, session?.phase, session?.last.time, session?.marks],
  );
  const monitorShot = useMemo(
    () =>
      session?.kind === "camera" && session.phase === "review" && options.shot
        ? { ...options.shot, camera: recordingCamera(options.shot.camera.sensorId, session.marks) }
        : options.shot,
    [session?.kind, session?.phase, session?.marks, options.shot],
  );
  return {
    read: () => current.current,
    isPreparing: () => preparingRef.current,
    recording,
    active: preparing || !!recording,
    preparing,
    notice,
    precision,
    setPrecision,
    start,
    stop,
    discard,
    apply,
    actorPreview,
    monitorShot,
    liveCamera:
      session?.kind === "camera" && session.phase === "recording" ? session.last : undefined,
  };
}
