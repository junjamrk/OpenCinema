import { z } from "zod";
import { cameraNameSchema, cloneProject, readProject } from "./document";
import { cameraMountFrame, cameraPointToLocal, cameraPointToWorld, cameraPoseToLocal, cameraPoseToWorld } from "./cameraMount";
import { lightingPresets } from "./environment";
import { createActorRecordingSource, recordingCamera } from "./recording";
import { referenceSettings } from "./referenceVideo";
import { cameraMovePresets } from "./blockout/cameraMoves";
import { entityPoseBase } from "./entityPose";
import { prepareGroupEdit, type GroupChanges } from "./groupEditing";
import { groupTransformCommand, transformEntities } from "./groupTransform";
import { applyStagePreset } from "./stagePresets";
import { addScanCommand, applyScanEdit, removeScanCommand, updateScanCommand } from "./scanEditing";
import { ASSET_CATALOG, assetSpec } from "./nativeBlockout/assets";
import { ASPECT_RATIOS, frameSubject, verticalFov } from "./nativeBlockout/camera";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { newId } from "./nativeBlockout/ids";
import { motionPresets } from "./nativeBlockout/motions";
import { actionPresets } from "./nativeBlockout/actionPresets";
import { createActorMark, createCameraMark, createEntity, createScene, createShot, shotCameras } from "./nativeBlockout/schema";
import type { ActorMark, BlockingTake, CameraMark, ProjectDoc, Scene, Shot, ShotCamera, V3 } from "./nativeBlockout/types";

const id = z.string().min(1).max(200);
const coordinate = z.number().finite().min(-100000).max(100000);
const vector = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const time = z.number().finite().min(0).max(300);
const gait = z.enum(["stand", "walk", "jog", "run", "sit", "lie", "crouch", "gesture", "fall"]);
const actorMark = z.strictObject({
  id: id.optional(), position: vector, time, gait, hold: time.optional(),
  easeIn: z.number().min(0).max(1).optional(), easeOut: z.number().min(0).max(1).optional(),
  arriveHeading: coordinate.optional().describe("到达朝向，单位弧度，0朝−Z。wheeled素材一段路径的首尾标记都显式填写时，车头按两端角度插值，可与移动方向分离用于漂移；否则跟随路径。显式lookAt/附着关系仍优先。"), via: z.array(vector).max(100).optional(),
  joints: z.record(z.string(), coordinate).optional(), lookAtEntityId: id.optional(), attachTo: id.optional(),
});
const motionKeyframe = z.strictObject({
  t: time, joints: z.record(z.string(), coordinate),
  move: z.strictObject({ forward: coordinate.optional(), up: coordinate.optional() }).optional(),
});
const motionMarkFields = new Set(["id", "time", "position", "gait", "arriveHeading", "hold", "easeIn", "easeOut", "joints", "via"]);
const actionMark = actorMark.pick({ position: true, time: true, gait: true, hold: true, easeIn: true, easeOut: true }).required();
const actionMarkFields = new Set([...motionMarkFields].filter(key => key !== "joints"));
const actorMarkFields = new Set(Object.keys(actorMark.shape));
const cameraMark = z.strictObject({
  id: id.optional(), position: vector, time, pan: coordinate, tilt: coordinate,
  roll: coordinate.optional(), focalLength: z.number().min(1).max(1000),
  hold: time.optional(), easeIn: z.number().min(0).max(1).optional(), easeOut: z.number().min(0).max(1).optional(),
  via: z.array(vector).max(100).optional(), focusDistance: z.number().positive().optional(),
});
const scope = { sceneId: id, shotId: id };
const groupOrigin = z.strictObject({ x: coordinate, z: coordinate, heading: coordinate });
const groupEntityIds = z.array(id).min(1).max(200).refine(ids => new Set(ids).size === ids.length, "群组物体ID必须完整且唯一");
const routineFields = {
  kind: z.enum(["dance", "fight", "chase"]), seed: z.number().int().min(0).max(4294967295),
  bpm: z.number().finite().min(60).max(180).optional(), beatDur: z.number().finite().positive().optional(),
  style: z.string().min(1).max(80).optional(), formation: z.enum(["line", "twoRows", "vShape", "circle", "diamond"]).optional(),
  canon: z.boolean().optional(), mirror: z.boolean().optional(), formationChange: z.boolean().optional(),
  ending: z.string().min(1).max(80).optional(), amplitude: z.number().finite().min(0).optional(),
};
export const blockoutCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("setReferenceVideo"), ...scope, ...referenceSettings.partial().shape, remove: z.boolean().optional() }).refine(value => value.remove === true || value.mode !== undefined || value.opacity !== undefined || value.timeOffset !== undefined, "请选择参考显示参数或明确移除"),
  z.strictObject({ type: z.literal("setEnvironment"), sceneId: id, lighting: z.enum(lightingPresets.map(preset => preset.id)).optional(), sunAzimuth: coordinate.optional(), sunElevation: coordinate.optional(), fog: z.number().finite().min(0).max(1).optional() })
    .refine(value => value.lighting !== undefined || value.sunAzimuth !== undefined || value.sunElevation !== undefined || value.fog !== undefined, "请指定至少一项场景环境参数"),
  z.strictObject({ type: z.literal("addEntity"), sceneId: id, id: id.optional(), assetId: z.string().refine(value => ASSET_CATALOG.some(asset => asset.id === value)), name: z.string().min(1).max(200), position: vector, rotationY: coordinate.optional(), scale: z.number().positive().max(1000).optional() }),
  z.strictObject({ type: z.literal("moveEntity"), ...scope, entityId: id, position: vector, time, scope: z.enum(["scene", "take"]), rotationY: coordinate.optional(), scale: z.number().positive().max(1000).optional() }),
  z.strictObject({ type: z.literal("setActorMark"), ...scope, entityId: id, mark: actorMark }),
  z.strictObject({ type: z.literal("setCameraMark"), ...scope, mark: cameraMark, space: z.enum(["camera", "world"]).optional() }),
  z.strictObject({ type: z.literal("lookAt"), ...scope, entityId: id, targetId: id.nullable(), time }),
  z.strictObject({ type: z.literal("attachEntity"), ...scope, entityId: id, targetId: id.nullable(), time }),
  z.strictObject({ type: z.literal("forkTake"), ...scope, id: id.optional(), name: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal("confirmTake"), ...scope, confirmed: z.boolean() }),
  z.strictObject({ type: z.literal("addShot"), ...scope, id: id.optional(), name: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal("saveDraft"), ...scope }),
  z.strictObject({ type: z.literal("promoteDraft"), ...scope }),
  z.strictObject({ type: z.literal("removeDraft"), ...scope }),
  z.strictObject({ type: z.literal("addCamera"), ...scope, name: cameraNameSchema.optional(), copyCurrent: z.boolean().optional() }),
  z.strictObject({ type: z.literal("setCameraMount"), ...scope, sourceCameraName: cameraNameSchema, entityId: id.nullable(), time, name: cameraNameSchema.optional() }),
  z.strictObject({ type: z.literal("applyCameraMove"), ...scope, presetId: z.enum(cameraMovePresets.map(preset => preset.id)), subjectId: id, name: cameraNameSchema.optional() }),
  z.strictObject({ type: z.literal("applyMotionPreset"), ...scope, entityId: id, presetId: z.enum(motionPresets.map(preset => preset.id)), time }),
  z.strictObject({ type: z.literal("applyActionPreset"), ...scope, entityId: id, presetId: z.enum(actionPresets.map(preset => preset.id)), time }),
  z.strictObject({ type: z.literal("stageSequence"), ...scope, sequenceType: z.enum(["dance", "fight", "footChase", "carChase"]), count: z.number().int().min(2).max(60), style: z.string().min(1).max(80), origin: groupOrigin }),
  z.strictObject({ type: z.literal("stageRoutine"), ...scope, spec: z.strictObject({ ...routineFields, performers: z.number().int().min(1).max(40) }), origin: groupOrigin }),
  z.strictObject({ type: z.literal("applyRoutineToEntities"), ...scope, entityIds: groupEntityIds, spec: z.strictObject(routineFields), replacePerformance: z.literal(true) }),
  z.strictObject({ type: z.literal("applyMotionToEntities"), ...scope, entityIds: groupEntityIds, presetId: z.enum(motionPresets.map(preset => preset.id)), replacePerformance: z.literal(true) }),
  z.strictObject({ type: z.literal("applyActionToEntities"), ...scope, entityIds: groupEntityIds, presetId: z.enum(actionPresets.map(preset => preset.id)), replacePerformance: z.literal(true) }),
  groupTransformCommand,
  z.strictObject({ type: z.literal("recordCamera"), ...scope, sourceCameraName: cameraNameSchema, name: cameraNameSchema.optional(), marks: z.array(cameraMark.pick({ position: true, time: true, pan: true, tilt: true, roll: true, focalLength: true })).min(2).max(241) }),
  z.strictObject({ type: z.literal("recordActor"), ...scope, entityId: id, sourceTakeId: id, name: z.string().min(1).max(200).optional(), marks: z.array(actorMark.pick({ position: true, time: true, gait: true, arriveHeading: true })).min(2).max(241) }),
  z.strictObject({ type: z.literal("switchCamera"), ...scope, name: cameraNameSchema }),
  z.strictObject({ type: z.literal("renameCamera"), ...scope, cameraName: cameraNameSchema.optional(), name: cameraNameSchema }),
  z.strictObject({ type: z.literal("removeCamera"), ...scope, name: cameraNameSchema }),
  z.strictObject({ type: z.literal("frameSubjects"), ...scope, entityIds: z.array(id).min(1).max(20), time, size: z.enum(["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"]), pan: coordinate, focalLength: z.number().min(1).max(1000) }),
  z.strictObject({ type: z.literal("trackCamera"), ...scope, entityId: id.nullable(), time: time.optional(), transition: z.number().finite().min(0).max(10).optional(), focusId: id.optional() }),
  z.strictObject({ type: z.literal("removeCameraFocus"), ...scope, focusId: id }),
  z.strictObject({ type: z.literal("createDialogueScene"), name: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal("applyStagePreset"), payload: z.json() }),
  addScanCommand, updateScanCommand, removeScanCommand,
]);
export type BlockoutCommand = z.infer<typeof blockoutCommand>;

export function getShot(project: ProjectDoc, sceneId: string, shotId: string) {
  const scene = project.scenes.find(item => item.id === sceneId);
  const shot = scene?.shots.find(item => item.id === shotId) ?? scene?.drafts?.find(item => item.id === shotId);
  if (!scene || !shot) throw new Error("Blockout 场景或镜头不存在，请重新读取");
  const take = scene.blocking.find(item => item.id === shot.blockingTakeId);
  if (!take) throw new Error("Blockout 镜头引用的 Take 不存在");
  return { scene, shot, take };
}

function requireEntity(scene: Scene, entityId: string) {
  const entity = scene.entities.find(item => item.id === entityId);
  if (!entity) throw new Error(`Blockout 物体不存在：${entityId}`);
  return entity;
}

function requireEditable(take: BlockingTake) {
  if (take.confirmed) throw new Error("此 Take 已确认，请先为当前镜头复制 Take 再修改表演");
}

function upsertMark<Mark extends ActorMark | CameraMark>(marks: Mark[], mark: Mark, fps: number) {
  const byId = marks.findIndex(item => item.id === mark.id);
  const byTime = marks.findIndex((item, index) => index !== byId && Math.abs(item.time - mark.time) < 0.5 / fps);
  if (byId >= 0 && marks[byId].time !== mark.time && byTime >= 0) throw new Error("目标时间已有其他标记，请先调整或删除原标记");
  const index = byId >= 0 ? byId : byTime;
  if (index < 0) marks.push(mark); else marks.splice(index, 1, byId >= 0 ? { ...marks[index], ...mark } : mark);
  marks.sort((a, b) => a.time - b.time);
}

function requireTime(shot: Shot, time: number) {
  if (time > shot.duration) throw new Error("标记时间超出镜头时长，请先调整时长");
}

function copyCamera(camera: ShotCamera) {
  const copy = structuredClone(camera);
  for (const mark of copy.marks) mark.id = newId("cmark");
  for (const mark of copy.focusMarks ?? []) mark.id = newId("focus");
  return copy;
}

function requireCameraName(shot: Shot, name: string, previous?: string) {
  if (shotCameras(shot).some(item => item.name !== previous && item.name.toLowerCase() === name.toLowerCase())) throw new Error("此镜头已存在同名机位");
}

function addCamera(scene: Scene, shot: Shot, name?: string, copyCurrent = false) {
  const cameras = shotCameras(shot);
  if (cameras.length >= 26) throw new Error("一个镜头最多保存 26 个机位");
  name ??= [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].find(candidate => !cameras.some(item => item.name.toLowerCase() === candidate.toLowerCase()))!;
  requireCameraName(shot, name);
  const camera = copyCurrent ? copyCamera(shot.camera) : { ...createShot(scene, "").camera, sensorId: shot.camera.sensorId };
  shot.cameraBank ??= []; shot.cameraBank.push(shotCameras(shot)[0]);
  shot.camera = camera; shot.cameraName = name;
  if (!copyCurrent) delete shot.cameraEntryFields;
}

function setCameraMount(scene: Scene, shot: Shot, command: Extract<BlockoutCommand, { type: "setCameraMount" }>) {
  requireTime(shot, command.time);
  if (command.sourceCameraName !== (shot.cameraName ?? "A")) throw new Error("源机位已切换，请重新读取后生成挂载机位");
  if (command.entityId) requireEntity(scene, command.entityId);
  const state = new ShotEvaluator(scene, shot).evaluate(command.time);
  const previousFrame = cameraMountFrame(shot.camera, state.entities);
  const nextFrame = cameraMountFrame({ rig: "carMount", mountEntityId: command.entityId ?? undefined }, state.entities);
  const sourceCameraName = shot.cameraName ?? "A";
  addCamera(scene, shot, command.name, true);
  // ACT: use one explicit reference frame for the entire authored curve.
  // A moving new parent intentionally changes world motion at other times;
  // the complete original camera remains in the bank, without sampled baking.
  if (shot.camera.marks.length) {
    shot.camera.marks = shot.camera.marks.map(mark => ({
      ...cameraPoseToLocal(cameraPoseToWorld(mark, previousFrame), nextFrame),
      ...(mark.via ? { via: mark.via.map(point => cameraPointToLocal(cameraPointToWorld(point, previousFrame), nextFrame)) } : {}),
    }));
  } else {
    const pose = cameraPoseToLocal(state.camera, nextFrame);
    const mark = createCameraMark(pose.position, command.time, pose.pan, pose.tilt, pose.focalLength);
    mark.roll = pose.roll;
    if (pose.focusDistance !== undefined) mark.focusDistance = pose.focusDistance;
    shot.camera.marks.push(mark);
  }
  shot.camera.rig = command.entityId ? "carMount" : "sticks";
  shot.camera.rigIntensity = 0;
  if (command.entityId) shot.camera.mountEntityId = command.entityId;
  else delete shot.camera.mountEntityId;
  return { sourceCameraName, cameraName: shot.cameraName!, mountEntityId: command.entityId, time: command.time, coordinatePolicy: "referenceFrameAtTime", affectedShotIds: [shot.id] };
}

function applyCameraMove(scene: Scene, shot: Shot, command: Extract<BlockoutCommand, { type: "applyCameraMove" }>) {
  const subject = requireEntity(scene, command.subjectId);
  const preset = cameraMovePresets.find(preset => preset.id === command.presetId);
  if (!preset) throw new Error("Blockout 运镜预设不存在");
  const evaluator = new ShotEvaluator(scene, shot), camera = evaluator.evaluate(0).camera;
  const subjectHeight = evaluator.subjectHeight(subject.id);
  if (!Number.isFinite(subjectHeight) || subjectHeight <= 0) throw new Error("运镜主体的实际比例高度无效");
  const generated = preset.generate({
    duration: shot.duration, subjectHeight,
    camera: { ...camera.position, pan: camera.pan, tilt: camera.tilt, focalLength: camera.focalLength },
    subjectAt(time) {
      if (!Number.isFinite(time) || time < 0 || time > shot.duration) throw new Error("运镜预设的主体采样超出镜头区间");
      const state = evaluator.evaluate(time).entities.find(entity => entity.entityId === subject.id);
      if (!state) throw new Error("运镜主体缺少当前 Take 的世界求值结果");
      return { ...state.position, heading: state.heading };
    },
  });
  const marks = z.array(cameraMark.omit({ id: true })).min(2).max(2000).parse(generated);
  if (marks.some((mark, index) => mark.time > shot.duration || index > 0 && mark.time <= marks[index - 1]!.time)) throw new Error("运镜预设的标记须在镜头区间内严格递增；请调整时长，不自动裁剪");
  addCamera(scene, shot, command.name);
  // ACT: 预设已是world轨迹；新机位仅继承传感器，不能再次套源机位挂载、关注或rig扰动。
  shot.camera.rig = "sticks"; shot.camera.rigIntensity = 0;
  shot.camera.marks = marks.map(mark => ({ ...createCameraMark(mark.position, mark.time, mark.pan, mark.tilt, mark.focalLength), ...mark }));
  if (preset.track) shot.camera.trackEntityId = subject.id;
}

function applyMotionPreset(scene: Scene, shot: Shot, take: BlockingTake, command: Extract<BlockoutCommand, { type: "applyMotionPreset" }>) {
  requireEditable(take);
  const entity = requireEntity(scene, command.entityId);
  if (!entity.assetId.startsWith("person.") || entity.sourceFile || assetSpec(entity.assetId).category !== "people") throw new Error("动作预设仅支持内置人物，不支持导入GLB、动物或其他物体");
  const track = take.tracks.find(item => item.entityId === entity.id);
  const original = track?.marks ?? [];
  if (entity.attachedTo || original.some(mark => mark.attachTo)) throw new Error("附着或含boarding标记的人物不能直接应用动作，请先明确处理关系");
  const preset = motionPresets.find(item => item.id === command.presetId);
  if (!preset) throw new Error("Blockout 动作预设不存在");
  const duration = z.number().finite().positive().max(300).parse(preset.duration);
  const frames = z.array(motionKeyframe).min(2).max(2000).parse(preset.keyframes);
  const start = command.time, calculatedEnd = start + duration;
  if (calculatedEnd - shot.duration > 1e-9) throw new Error("镜头剩余时间不足以容纳完整动作，请提前开始或明确调整镜头时长；不会截尾、重复或拉伸动作");
  // ACT: only reconcile <=1e-9s addition error at the known shot endpoint;
  // interior frame times remain original and must still be strictly ordered.
  const end = Math.min(calculatedEnd, shot.duration);
  if (frames[0].t !== 0 || frames.at(-1)!.t !== duration || frames.some((frame, index) => frame.t > duration || index > 0 && frame.t <= frames[index - 1].t)) throw new Error("动作预设须包含完整首末关键帧且时间严格递增");
  if (start > 0 && !original.some(mark => mark.time < start)) throw new Error("非零时刻应用动作须已有前置表演标记；请从0秒应用，或先显式建立起点之前的表演，避免动作提前生效");
  const ordered = [...original].sort((a, b) => a.time - b.time);
  const active = ordered.findLast(mark => mark.time <= start) ?? ordered[0];
  if (active?.lookAtEntityId) throw new Error("动作起点仍有生效的人物视线，请先在该时刻明确解除视线再应用；原标记未覆盖");
  const replaced = original.filter(mark => mark.time >= start && mark.time <= end);
  if (replaced.some(mark => Object.keys(mark).some(key => !motionMarkFields.has(key)))) throw new Error("动作区间含视线或其他语义标记，请先明确处理冲突；原标记未覆盖");
  const retained = original.filter(mark => mark.time < start || mark.time > end);
  if (retained.length + frames.length > 2000) throw new Error("保留区间外标记与完整动作后超过2000标记上限，原表演未覆盖");
  const state = new ShotEvaluator(scene, shot).evaluate(start).entities.find(item => item.entityId === entity.id);
  if (!state) throw new Error("动作主体缺少当前Take的世界求值结果");
  const forward = { x: -Math.sin(state.heading), z: -Math.cos(state.heading) };
  // ACT: one original cycle in metres; mark joints remain additive to the
  // scene joint_* base. Exact keyframe times must not use half-frame upsert.
  const marks = frames.map((frame, index) => {
    const mark = {
      ...createActorMark({ x: state.position.x + forward.x * (frame.move?.forward ?? 0), y: Math.max(0, state.position.y + (frame.move?.up ?? 0)), z: state.position.z + forward.z * (frame.move?.forward ?? 0) }, index === 0 ? start : index === frames.length - 1 ? end : start + frame.t, "stand"),
      arriveHeading: state.heading, hold: 0, easeIn: 0, easeOut: 0, joints: { ...frame.joints },
    };
    actorMark.parse(mark);
    return mark;
  });
  if (marks.some((mark, index) => mark.time > end || index > 0 && mark.time <= marks[index - 1].time)) throw new Error("动作关键帧在工程时间中无法保持严格顺序，原表演未覆盖");
  const merged = [...retained, ...marks].sort((a, b) => a.time - b.time);
  if (track) track.marks = merged;
  else take.tracks.push({ entityId: entity.id, marks: merged });
  return { entityId: entity.id, presetId: preset.id, start, end, replacedMarks: replaced.length,
    sharedShotIds: [...scene.shots, ...(scene.drafts ?? [])].filter(item => item.id !== shot.id && item.blockingTakeId === take.id).map(item => item.id) };
}

function applyActionPreset(scene: Scene, shot: Shot, take: BlockingTake, command: Extract<BlockoutCommand, { type: "applyActionPreset" }>) {
  requireEditable(take);
  const entity = requireEntity(scene, command.entityId);
  const track = take.tracks.find(item => item.entityId === entity.id);
  const original = track?.marks ?? [];
  if (entity.attachedTo || original.some(mark => mark.attachTo)) throw new Error("附着或含boarding标记的物体不能直接应用路径，请先明确处理关系");
  const start = command.time, end = shot.duration, duration = end - start;
  if (duration < 1) throw new Error("路径预设需要起点到镜尾至少1秒，请前移起点或明确调整镜头时长");
  if (start > 0 && !original.some(mark => mark.time < start)) throw new Error("非零时刻应用路径须已有前置表演标记；请从0秒应用，或先显式建立起点之前的表演，避免路径提前生效");
  const ordered = [...original].sort((a, b) => a.time - b.time);
  const afterEnd = ordered.find(mark => mark.time > end);
  if (afterEnd && Object.values(afterEnd.joints ?? {}).some(value => value !== 0)) throw new Error("镜尾后的下一表演标记含关节动作，可能已在路径区间内插值；请先明确处理身体动作，原轨道未覆盖");
  const active = ordered.findLast(mark => mark.time <= start) ?? ordered[0];
  if (active && Object.keys(active).some(key => key !== "joints" && !actionMarkFields.has(key))) throw new Error("路径起点仍有生效的视线或未知语义，请先明确解除冲突；原标记未覆盖");
  const replaced = original.filter(mark => mark.time >= start && mark.time <= end);
  if (replaced.some(mark => Object.keys(mark).some(key => !actionMarkFields.has(key)))) throw new Error("路径区间含身体关节、视线或其他语义标记，请先明确处理冲突；原标记未覆盖");
  const state = new ShotEvaluator(scene, shot).evaluate(start).entities.find(item => item.entityId === entity.id);
  if (!state) throw new Error("路径主体缺少当前Take的世界求值结果");
  const base = entityPoseBase(entity, original.length > 0).joints;
  if (Object.entries(state.joints ?? {}).some(([key, value]) => value !== (base[key] ?? 0))) throw new Error("路径起点仍有身体关节动作，请先明确处理冲突；场景静态关节基底保留");
  const preset = actionPresets.find(item => item.id === command.presetId);
  if (!preset) throw new Error("Blockout 路径预设不存在");
  const specs = z.array(actionMark).min(2).max(2000).parse(preset.generate({ start: { ...state.position, heading: state.heading }, duration }));
  const last = specs.length - 1;
  if (specs[0].time !== 0 || Math.abs(specs[last].time - duration) > 1e-9 || specs.some((spec, index) => index < last && spec.time >= duration || index > 0 && spec.time <= specs[index - 1].time)) throw new Error("路径预设须包含完整首末标记且时间严格递增，未裁剪或缩放");
  const retained = original.filter(mark => mark.time < start || mark.time > end);
  if (retained.length + specs.length > 2000) throw new Error("保留区间外表演与完整路径后超过2000标记上限，原表演未覆盖");
  const marks = specs.map((spec, index) => {
    // ACT: only normalize the two known endpoints (<=1e-9s); preserve all
    // interior timing and authored hold/ease, including native hold truncation.
    const mark = { ...createActorMark({ ...spec.position }, index === 0 ? start : index === last ? end : start + spec.time, spec.gait),
      hold: spec.hold, easeIn: spec.easeIn, easeOut: spec.easeOut, ...(index === 0 ? { arriveHeading: state.heading } : {}) };
    actorMark.parse(mark);
    return mark;
  });
  if (marks.some((mark, index) => mark.time > end || index > 0 && mark.time <= marks[index - 1].time)) throw new Error("路径标记在工程时间中无法保持严格顺序，原表演未覆盖");
  const merged = [...retained, ...marks].sort((a, b) => a.time - b.time);
  if (track) track.marks = merged;
  else take.tracks.push({ entityId: entity.id, marks: merged });
  return { entityId: entity.id, presetId: preset.id, start, end, replacedMarks: replaced.length,
    sharedShotIds: [...scene.shots, ...(scene.drafts ?? [])].filter(item => item.id !== shot.id && item.blockingTakeId === take.id).map(item => item.id) };
}

function activateCamera(shot: Shot, entry: NonNullable<Shot["cameraBank"]>[number]) {
  const { name, camera, ...fields } = entry;
  shot.camera = camera; shot.cameraName = name;
  if (Object.keys(fields).length) shot.cameraEntryFields = fields;
  else delete shot.cameraEntryFields;
}

function switchCamera(shot: Shot, name: string) {
  if (name === (shot.cameraName ?? "A")) return;
  const index = shot.cameraBank?.findIndex(item => item.name === name) ?? -1;
  if (index < 0) throw new Error("Blockout 机位不存在，请重新读取");
  const incoming = shot.cameraBank![index];
  shot.cameraBank![index] = shotCameras(shot)[0];
  activateCamera(shot, incoming);
}

function setCameraFocus(shot: Shot, time: number, entityId: string | null, transition: number, focusId?: string) {
  requireTime(shot, time);
  shot.camera.focusMarks ??= [];
  const byId = focusId ? shot.camera.focusMarks.find(mark => mark.id === focusId) : undefined;
  const byTime = shot.camera.focusMarks.find(mark => Math.abs(mark.time - time) < 0.5 / shot.fps);
  if (focusId && !byId) throw new Error("摄影关注标记不存在");
  if (byId && byTime && byId !== byTime) throw new Error("此时间已有摄影关注标记");
  const mark = byId ?? byTime;
  const next = { id: mark?.id ?? newId("focus"), time, entityId, transition };
  if (mark) Object.assign(mark, next); else shot.camera.focusMarks.push(next);
  shot.camera.focusMarks.sort((a, b) => a.time - b.time);
}

function ensureActorMark(scene: Scene, shot: Shot, take: BlockingTake, entityId: string, time: number, markId?: string) {
  requireEditable(take); requireTime(shot, time); requireEntity(scene, entityId);
  let track = take.tracks.find(item => item.entityId === entityId);
  if (!track) { track = { entityId, marks: [] }; take.tracks.push(track); }
  let mark = (markId ? track.marks.find(item => item.id === markId) : undefined) ?? track.marks.find(item => Math.abs(item.time - time) < 0.5 / shot.fps);
  if (!mark) {
    const state = new ShotEvaluator(scene, shot).evaluate(time).entities.find(item => item.entityId === entityId)!;
    mark = createActorMark({ ...state.position }, time, state.gait);
    mark.arriveHeading = state.heading;
    upsertMark(track.marks, mark, shot.fps);
  }
  return mark;
}

function frameSubjects(scene: Scene, shot: Shot, command: Extract<BlockoutCommand, { type: "frameSubjects" }>) {
  if (shot.camera.rig === "carMount" && shot.camera.mountEntityId) throw new Error("已挂载机位请先生成独立机位，再按主体构图；原局部轨迹未覆盖");
  requireTime(shot, command.time);
  const evaluator = new ShotEvaluator(scene, shot);
  const state = evaluator.evaluate(command.time);
  const subjects = command.entityIds.map(entityId => {
    requireEntity(scene, entityId);
    const subject = state.entities.find(item => item.entityId === entityId)!;
    // ACT: use nominal seated height; a fixed shrink can crop the head, and this is not a posed mesh bound.
    const height = evaluator.subjectHeight(entityId) * (subject.gait === "lie" ? 0.2 : 1);
    const frame = frameSubject(command.size, height, shot.camera.sensorId, command.focalLength, shot.aspect);
    const entity = requireEntity(scene, entityId);
    const radius = typeof entity.params?.width === "number" && typeof entity.params?.depth === "number"
      ? Math.hypot(entity.params.width, entity.params.depth) / 2 * entity.transform.scale
      : assetSpec(entity.assetId).footprint * entity.transform.scale;
    return { ...subject, height, frame, radius };
  });
  const target = subjects.reduce((point, subject) => ({ x: point.x + subject.position.x / subjects.length, y: point.y + (subject.position.y + subject.frame.targetHeight) / subjects.length, z: point.z + subject.position.z / subjects.length }), { x: 0, y: 0, z: 0 });
  const vfov = verticalFov(shot.camera.sensorId, command.focalLength, shot.aspect);
  const halfWidth = Math.max(...subjects.map(subject => Math.hypot(subject.position.x - target.x, subject.position.z - target.z) + subject.radius));
  const distance = Math.max(...subjects.map(subject => subject.frame.distance), halfWidth / (Math.tan(vfov / 2) * ASPECT_RATIOS[shot.aspect] * 0.85));
  const position = { x: target.x + Math.sin(command.pan) * distance, y: target.y, z: target.z + Math.cos(command.pan) * distance };
  const mark = createCameraMark(position, command.time, command.pan, 0, command.focalLength);
  mark.focusDistance = distance;
  upsertMark(shot.camera.marks, mark, shot.fps);
  delete shot.camera.trackEntityId;
  if (shot.camera.focusMarks?.length) setCameraFocus(shot, command.time, null, 0);
  delete shot.camera.mountEntityId;
  if (shot.camera.rig === "carMount") shot.camera.rig = "sticks";
}

function createDialogueScene(project: ProjectDoc, name: string) {
  const scene = createScene(project.scenes.length + 1);
  scene.name = name;
  const a = createEntity("person.man", "人物 A", { x: -1.2, y: 0, z: 0 });
  const b = createEntity("person.woman", "人物 B", { x: 1.2, y: 0, z: 0 });
  const table = createEntity("furniture.diningTable", "对话桌", { x: 0, y: 0, z: 0 });
  table.transform.scale = 0.8;
  const chairs = [a, b].map((actor, index) => {
    const chair = createEntity("furniture.chair", `座椅 ${index ? "B" : "A"}`, { ...actor.transform.position });
    actor.transform.rotationY = index ? Math.PI / 2 : -Math.PI / 2;
    chair.transform.rotationY = actor.transform.rotationY;
    return chair;
  });
  scene.entities.push(table, ...chairs, a, b);
  for (const [actor, target] of [[a, b], [b, a]]) {
    scene.blocking[0].tracks.push({ entityId: actor.id, marks: [0, 5].map(time => ({ ...createActorMark({ ...actor.transform.position }, time, "sit"), lookAtEntityId: target.id, arriveHeading: actor.transform.rotationY })) });
  }
  const main = scene.shots[0]; main.name = "双人主镜头";
  const reverseA = createShot(scene, "人物 A · 反打");
  const reverseB = createShot(scene, "人物 B · 反打");
  scene.shots.push(reverseA, reverseB);
  for (const [shot, subjects, pan] of [[main, [a.id, b.id], 0], [reverseA, [a.id], 0.8], [reverseB, [b.id], -0.8]] as const) {
    frameSubjects(scene, shot, { type: "frameSubjects", sceneId: scene.id, shotId: shot.id, entityIds: [...subjects], time: 0, size: "MS", pan, focalLength: 35 });
  }
  project.scenes.push(scene);
  return scene;
}

/** One cloned document, one final validation; the caller publishes one immutable version. */
export function applyBlockoutCommands(project: ProjectDoc, commands: BlockoutCommand[]) {
  const draft = cloneProject(project);
  const changes: ({ type: BlockoutCommand["type"]; sceneId: string; shotId?: string; entityId?: string; takeId?: string; cameraName?: string;
    presetId?: string; start?: number; end?: number; replacedMarks?: number; sharedShotIds?: string[];
    draftId?: string; mainShotId?: string; fallbackShotId?: string;
    takeIds?: string[]; duration?: number; derivedDefaultShot?: true; scanId?: string } & Partial<GroupChanges> & Partial<ReturnType<typeof transformEntities>> & Partial<ReturnType<typeof setCameraMount>>)[] = [];
  for (const input of commands) {
    const command = blockoutCommand.parse(input);
    if (command.type === "applyStagePreset") {
      changes.push({ type: command.type, ...applyStagePreset(draft, command.payload) });
      continue;
    }
    if (command.type === "createDialogueScene") {
      const scene = createDialogueScene(draft, command.name);
      changes.push({ type: command.type, sceneId: scene.id, shotId: scene.shots[0].id });
      continue;
    }
    if (command.type === "addScan" || command.type === "updateScan" || command.type === "removeScan") {
      const scene = draft.scenes.find(scene => scene.id === command.sceneId);
      if (!scene) throw new Error("Blockout 场景不存在");
      changes.push({ type: command.type, sceneId: scene.id, ...applyScanEdit(scene, command) });
      continue;
    }
    if (command.type === "setEnvironment") {
      const scene = draft.scenes.find(item => item.id === command.sceneId);
      if (!scene) throw new Error("Blockout 场景不存在");
      const { type, sceneId, ...settings } = command;
      Object.assign(scene.environment, settings);
      changes.push({ type, sceneId });
      continue;
    }
    if (command.type === "addEntity") {
      const scene = draft.scenes.find(item => item.id === command.sceneId);
      if (!scene) throw new Error("Blockout 场景不存在");
      const entity = createEntity(command.assetId, command.name, command.position);
      if (command.id) entity.id = command.id;
      entity.transform.rotationY = command.rotationY ?? 0;
      entity.transform.scale = command.scale ?? 1;
      scene.entities.push(entity);
      changes.push({ type: command.type, sceneId: scene.id, entityId: entity.id });
      continue;
    }
    const { scene, shot, take } = getShot(draft, command.sceneId, command.shotId);
    if (command.type === "saveDraft") {
      const mainShotId = shot.draftOf ?? shot.id;
      const main = scene.shots.find(item => item.id === mainShotId);
      if (!main) throw new Error("备选镜头关联的主镜不存在");
      if ((scene.drafts?.length ?? 0) >= 100) throw new Error("每场景最多保存100个备选镜头，请先明确删除不需要的备选");
      const next = structuredClone(shot);
      next.id = newId("shot"); next.draftOf = main.id;
      next.name = `${main.name} v${(scene.drafts?.filter(item => item.draftOf === main.id).length ?? 0) + 1}`;
      next.camera = copyCamera(next.camera);
      if (next.cameraBank) next.cameraBank = next.cameraBank.map(item => ({ ...item, camera: copyCamera(item.camera) }));
      scene.drafts ??= []; scene.drafts.push(next);
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, draftId: next.id, mainShotId: main.id, takeId: next.blockingTakeId,
        affectedShotIds: [next.id], sharedShotIds: [...scene.shots, ...scene.drafts].filter(item => item.id !== shot.id && item.blockingTakeId === take.id).map(item => item.id) });
      continue;
    }
    if (command.type === "promoteDraft" || command.type === "removeDraft") {
      if (!scene.drafts?.includes(shot) || !shot.draftOf) throw new Error("此操作只支持真实备选镜头");
      let main = scene.shots.find(item => item.id === shot.draftOf);
      if (!main) throw new Error("备选镜头关联的主镜不存在");
      if (command.type === "promoteDraft") {
        // Keep main-only unknown fields; the complete draft wins for shared
        // fields except main identity. Known optional fields may be cleared.
        const adopted = { ...main, ...structuredClone(shot), id: main.id, name: main.name };
        delete adopted.draftOf;
        for (const key of ["cameraName", "cameraBank", "cameraEntryFields", "notes", "referenceVideo"] as const) if (shot[key] === undefined) delete adopted[key];
        scene.shots[scene.shots.indexOf(main)] = adopted;
        main = adopted;
      } else scene.drafts = scene.drafts.filter(item => item.id !== shot.id);
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, draftId: shot.id, mainShotId: main.id, takeId: command.type === "promoteDraft" ? main.blockingTakeId : take.id,
        ...(command.type === "removeDraft" ? { fallbackShotId: main.id } : {}), affectedShotIds: [command.type === "promoteDraft" ? main.id : shot.id],
        sharedShotIds: [...scene.shots, ...(scene.drafts ?? [])].filter(item => item.id !== shot.id && item.blockingTakeId === (command.type === "promoteDraft" ? main.blockingTakeId : take.id)).map(item => item.id) });
      continue;
    }
    if (command.type === "transformEntities") {
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, ...transformEntities(scene, shot, take, command) });
      continue;
    }
    if (command.type === "stageSequence" || command.type === "stageRoutine" || command.type === "applyRoutineToEntities" || command.type === "applyMotionToEntities" || command.type === "applyActionToEntities") {
      requireEditable(take);
      const prepared = prepareGroupEdit(scene, shot, take, command, actorMarkFields);
      for (const entity of prepared.newEntities) { vector.parse(entity.transform.position); coordinate.parse(entity.transform.rotationY); }
      for (const track of prepared.tracks) for (const mark of track.marks) if (mark.time <= shot.duration) actorMark.parse(mark);
      scene.entities.push(...prepared.newEntities);
      for (const track of prepared.tracks) {
        const previous = take.tracks.find(previous => previous.entityId === track.entityId);
        if (previous) previous.marks = track.marks;
        else take.tracks.push(track);
      }
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, ...prepared.changes });
      continue;
    }
    if (command.type === "setReferenceVideo") {
      if (command.remove) delete shot.referenceVideo;
      else {
        if (!shot.referenceVideo) throw new Error("此镜头尚无参考视频，请先导入或选择输入视频");
        for (const key of ["mode", "opacity", "timeOffset"] as const) if (command[key] !== undefined) Object.assign(shot.referenceVideo, { [key]: command[key] });
      }
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id });
      continue;
    }
    if (command.type === "forkTake") {
      const next: BlockingTake = { id: command.id ?? newId("take"), name: command.name, tracks: structuredClone(take.tracks) };
      for (const track of next.tracks) for (const mark of track.marks) mark.id = newId("mark");
      scene.blocking.push(next); shot.blockingTakeId = next.id;
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, takeId: next.id });
      continue;
    }
    if (command.type === "confirmTake") {
      if (command.confirmed && !take.confirmed) {
        const state = new ShotEvaluator(scene, shot).evaluate(0);
        for (const entity of state.entities) if (!take.tracks.some(track => track.entityId === entity.entityId && track.marks.length)) {
          // Effective gait freezes params.pose; total joints must not be copied
          // into a mark because the protected scene joint_* base adds it once.
          const mark = createActorMark({ ...entity.position }, 0, entity.gait); mark.arriveHeading = entity.heading;
          const track = take.tracks.find(track => track.entityId === entity.entityId);
          if (track) track.marks.push(mark); else take.tracks.push({ entityId: entity.entityId, marks: [mark] });
        }
      }
      take.confirmed = command.confirmed;
    } else if (command.type === "addShot") {
      const next = createShot(scene, command.name);
      next.id = command.id ?? next.id; next.blockingTakeId = take.id;
      next.duration = shot.duration; next.fps = shot.fps; next.aspect = shot.aspect;
      if (shot.referenceVideo) next.referenceVideo = structuredClone(shot.referenceVideo);
      next.camera = copyCamera(shot.camera);
      if (shot.cameraName !== undefined) next.cameraName = shot.cameraName;
      if (shot.cameraEntryFields) next.cameraEntryFields = structuredClone(shot.cameraEntryFields);
      if (shot.cameraBank) next.cameraBank = shot.cameraBank.map(item => ({ ...structuredClone(item), camera: copyCamera(item.camera) }));
      scene.shots.push(next);
      changes.push({ type: command.type, sceneId: scene.id, shotId: next.id });
      continue;
    } else if (command.type === "addCamera") {
      addCamera(scene, shot, command.name, command.copyCurrent);
    } else if (command.type === "setCameraMount") {
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, ...setCameraMount(scene, shot, command) });
      continue;
    } else if (command.type === "applyCameraMove") {
      applyCameraMove(scene, shot, command);
    } else if (command.type === "applyMotionPreset") {
      const change = applyMotionPreset(scene, shot, take, command);
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, ...change });
      continue;
    } else if (command.type === "applyActionPreset") {
      const change = applyActionPreset(scene, shot, take, command);
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, ...change });
      continue;
    } else if (command.type === "recordActor") {
      if (take.id !== command.sourceTakeId) throw new Error("录制源Take已切换，请重新读取");
      const first = command.marks[0].time, last = command.marks.at(-1)!.time;
      if (last - first < 0.25 - 1e-7 || last - first > 60 + 1e-7 || command.marks.some((mark, index) => mark.time > shot.duration || index > 0 && mark.time <= command.marks[index - 1].time)) throw new Error("角色录制须在镜头内持续0.25–60秒，标记时间严格递增");
      const source = createActorRecordingSource(scene, shot, command.entityId);
      const marks = source.track(command.marks.map(mark => ({ ...createActorMark(mark.position, mark.time, mark.gait), arriveHeading: mark.arriveHeading, hold: 0, easeIn: 0, easeOut: 0 })));
      const next: BlockingTake = { ...structuredClone(take), id: newId("take"), name: command.name ?? `${take.name} · 角色录制`.slice(0, 200), confirmed: false };
      const track = next.tracks.find(item => item.entityId === command.entityId);
      if (track) track.marks = marks; else next.tracks.push({ entityId: command.entityId, marks });
      for (const track of next.tracks) for (const mark of track.marks) mark.id = newId("mark");
      scene.blocking.push(next); shot.blockingTakeId = next.id;
      changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, takeId: next.id, entityId: command.entityId });
      continue;
    } else if (command.type === "recordCamera") {
      if (command.sourceCameraName !== (shot.cameraName ?? "A")) throw new Error("录制源机位已切换，请重新读取");
      const first = command.marks[0].time, last = command.marks.at(-1)!.time;
      if (last - first < 0.25 - 1e-7 || last - first > 60 + 1e-7 || command.marks.some((mark, index) => mark.time > shot.duration || index > 0 && mark.time <= command.marks[index - 1].time)) throw new Error("录制须在镜头内持续0.25–60秒，标记时间严格递增");
      addCamera(scene, shot, command.name);
      shot.camera = recordingCamera(shot.camera.sensorId, command.marks.map(mark => ({ ...createCameraMark(mark.position, mark.time, mark.pan, mark.tilt, mark.focalLength), roll: mark.roll ?? 0, easeIn: 0, easeOut: 0 })));
    } else if (command.type === "switchCamera") {
      switchCamera(shot, command.name);
    } else if (command.type === "renameCamera") {
      const previous = command.cameraName ?? shot.cameraName ?? "A";
      const entry = shotCameras(shot).find(item => item.name === previous);
      if (!entry) throw new Error("Blockout 机位不存在，请重新读取");
      requireCameraName(shot, command.name, previous);
      if (previous === (shot.cameraName ?? "A")) {
        if (command.name !== previous) shot.cameraName = command.name;
      } else entry.name = command.name;
    } else if (command.type === "removeCamera") {
      if (shotCameras(shot).length === 1) throw new Error("镜头必须保留一个机位");
      if (command.name === (shot.cameraName ?? "A")) {
        const next = shot.cameraBank!.shift()!;
        activateCamera(shot, next);
      } else {
        const index = shot.cameraBank?.findIndex(item => item.name === command.name) ?? -1;
        if (index < 0) throw new Error("Blockout 机位不存在，请重新读取");
        shot.cameraBank!.splice(index, 1);
      }
    } else if (command.type === "frameSubjects") {
      frameSubjects(scene, shot, command);
    } else if (command.type === "trackCamera") {
      if (command.entityId) requireEntity(scene, command.entityId);
      if (command.time === undefined) {
        if (command.focusId || command.transition !== undefined) throw new Error("摄影关注标记需要指定时间");
        if (command.entityId) shot.camera.trackEntityId = command.entityId;
        else delete shot.camera.trackEntityId;
      } else {
        setCameraFocus(shot, command.time, command.entityId, command.transition ?? 0, command.focusId);
      }
    } else if (command.type === "removeCameraFocus") {
      if (!shot.camera.focusMarks?.some(mark => mark.id === command.focusId)) throw new Error("摄影关注标记不存在");
      shot.camera.focusMarks = shot.camera.focusMarks.filter(mark => mark.id !== command.focusId);
    } else if (command.type === "setCameraMark") {
      requireTime(shot, command.mark.time);
      let fields = command.mark;
      if (command.space === "world") {
        const frame = cameraMountFrame(shot.camera, new ShotEvaluator(scene, shot).evaluate(command.mark.time).entities);
        fields = cameraPoseToLocal(command.mark, frame);
        if (command.mark.via) fields.via = command.mark.via.map(point => cameraPointToLocal(point, frame));
      }
      const existing = command.mark.id ? shot.camera.marks.find(mark => mark.id === command.mark.id) : undefined;
      const mark = { ...(existing ?? createCameraMark(fields.position, fields.time, fields.pan, fields.tilt, fields.focalLength)), ...fields };
      upsertMark(shot.camera.marks, mark, shot.fps);
    } else if (command.type === "setActorMark") {
      if (command.mark.id && take.tracks.some(track => track.entityId !== command.entityId && track.marks.some(mark => mark.id === command.mark.id))) throw new Error("标记 ID 已属于其他物体");
      const mark = ensureActorMark(scene, shot, take, command.entityId, command.mark.time, command.mark.id);
      const next = { ...mark, ...command.mark };
      const track = take.tracks.find(item => item.entityId === command.entityId)!;
      upsertMark(track.marks, next, shot.fps);
    } else if (command.type === "lookAt") {
      const mark = ensureActorMark(scene, shot, take, command.entityId, command.time);
      if (command.targetId) { requireEntity(scene, command.targetId); mark.lookAtEntityId = command.targetId; }
      else delete mark.lookAtEntityId;
    } else if (command.type === "attachEntity") {
      requireEditable(take);
      const entity = requireEntity(scene, command.entityId);
      const state = new ShotEvaluator(scene, shot).evaluate(command.time);
      const child = state.entities.find(item => item.entityId === entity.id)!;
      if (command.targetId) {
        requireEntity(scene, command.targetId);
        const parent = state.entities.find(item => item.entityId === command.targetId)!;
        const dx = child.position.x - parent.position.x, dz = child.position.z - parent.position.z;
        const cos = Math.cos(parent.heading), sin = Math.sin(parent.heading);
        entity.attachedTo = command.targetId;
        entity.attachedLocal = { x: dx * cos - dz * sin, y: child.position.y - parent.position.y, z: dx * sin + dz * cos, rotY: child.heading - parent.heading };
      } else {
        entity.transform.position = { ...child.position }; entity.transform.rotationY = child.heading;
        delete entity.attachedTo; delete entity.attachedLocal;
      }
    } else if (command.type === "moveEntity") {
      const entity = requireEntity(scene, command.entityId);
      if (command.scope === "scene") {
        entity.transform.position = command.position;
        if (command.rotationY !== undefined) entity.transform.rotationY = command.rotationY;
        if (command.scale !== undefined) entity.transform.scale = command.scale;
      } else {
        requireEditable(take); requireTime(shot, command.time);
        if (command.scale !== undefined && command.scale !== entity.transform.scale) throw new Error("物体比例属于场景布局，请切换场景布局范围");
        const state = new ShotEvaluator(scene, shot).evaluate(command.time).entities.find(item => item.entityId === entity.id)!;
        let track = take.tracks.find(item => item.entityId === entity.id);
        if (!track?.marks.length) { ensureActorMark(scene, shot, take, entity.id, 0); track = take.tracks.find(item => item.entityId === entity.id)!; }
        const delta = { x: command.position.x - state.position.x, y: command.position.y - state.position.y, z: command.position.z - state.position.z };
        const move = (point: V3) => ({ x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z });
        for (const mark of track!.marks) {
          mark.position = move(mark.position); mark.via = mark.via?.map(move);
          if (command.rotationY !== undefined) mark.arriveHeading = command.rotationY;
        }
      }
    }
    changes.push({ type: command.type, sceneId: scene.id, shotId: shot.id, ...(["addCamera", "applyCameraMove", "recordCamera", "switchCamera", "renameCamera", "removeCamera"].includes(command.type) ? { cameraName: shot.cameraName ?? "A" } : {}) });
  }
  return { project: readProject(draft), changes };
}

export function preserveConfirmedTakes(previous: ProjectDoc, next: ProjectDoc) {
  for (const scene of previous.scenes) for (const take of scene.blocking) {
    if (!take.confirmed) continue;
    const nextScene = next.scenes.find(item => item.id === scene.id);
    const updated = nextScene?.blocking.find(item => item.id === take.id);
    if (updated?.confirmed === false) continue;
    if (!updated || JSON.stringify(updated.tracks) !== JSON.stringify(take.tracks)) throw new Error("已有确认 Take 的表演不能直接覆盖；请先复制 Take，或明确解除确认后再修改");
    for (const entity of scene.entities) {
      const hasTrack = take.tracks.some(track => track.entityId === entity.id && track.marks.length > 0);
      const before = entityPoseBase(entity, hasTrack);
      const changed = nextScene!.entities.find(item => item.id === entity.id);
      const after = changed ? entityPoseBase(changed, updated.tracks.some(track => track.entityId === entity.id && track.marks.length > 0)) : { gait: undefined, joints: {} };
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("已有确认 Take 依赖的人物静态姿态或关节基底不能直接覆盖；请先明确解除相关Take确认后再修改");
    }
  }
}

export function coverageWarnings(scene: Scene, shot: Shot, time: number) {
  const people = scene.entities.filter(entity => entity.assetId.startsWith("person.")).slice(0, 2);
  if (people.length < 2) return [];
  const side = (candidate: Shot) => {
    const state = new ShotEvaluator(scene, candidate).evaluate(time);
    const a = state.entities.find(entity => entity.entityId === people[0].id)!.position;
    const b = state.entities.find(entity => entity.entityId === people[1].id)!.position;
    const cross = (b.x - a.x) * (state.camera.position.z - a.z) - (b.z - a.z) * (state.camera.position.x - a.x);
    return Math.abs(cross) < 0.2 ? 0 : Math.sign(cross);
  };
  const reference = [...scene.shots, ...(scene.drafts ?? [])].filter(candidate => candidate.blockingTakeId === shot.blockingTakeId)
    .flatMap(candidate => shotCameras(candidate).map(({ name, camera }) => ({ shot: { ...candidate, camera }, name })))
    .find(candidate => !(candidate.shot.id === shot.id && candidate.name === (shot.cameraName ?? "A")) && candidate.shot.camera.marks.length && side(candidate.shot));
  if (!reference || !side(shot) || side(reference.shot) === side(shot)) return [];
  return [{ referenceShotId: reference.shot.id, referenceCameraName: reference.name, shotId: shot.id, cameraName: shot.cameraName ?? "A", message: `当前机位与“${reference.shot.name} · ${reference.name}”位于双人轴线两侧，剪切可能反转银幕方向` }];
}
