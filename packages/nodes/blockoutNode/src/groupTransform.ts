// OpenCinema adaptation of Blockout's rigid gizmo transform (Apache-2.0).
// Copyright 2026 Sam Wasserman (wassermanproductions.com); see ../readme.md.
// Source: blockout@3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9, SceneManager.ts:1130–1277.
import { z } from "zod";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { createActorMark } from "./nativeBlockout/schema";
import type { BlockingTake, Entity, EntityState, EntityTrack, Scene, Shot, V3 } from "./nativeBlockout/types";

const id = z.string().min(1).max(200);
const coordinate = z.number().finite().min(-100000).max(100000);
const vector = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const scale = z.number().finite().positive().max(1000);
const transform = z.object({ position: vector, rotationY: coordinate, scale });
const localOffset = vector.extend({ rotY: coordinate });
const markGeometry = z.object({ position: vector, via: z.array(vector).max(100).optional(), arriveHeading: coordinate.optional() });

export const groupTransformCommand = z.strictObject({
  type: z.literal("transformEntities"), sceneId: id, shotId: id,
  entityIds: z.array(id).min(1).max(200).refine(ids => new Set(ids).size === ids.length, "群组物体ID不能重复"),
  anchorId: id, position: vector, rotationY: coordinate, scale: scale.optional(),
  scope: z.enum(["scene", "take"]), time: z.number().finite().min(0).max(300),
}).refine(command => command.entityIds.includes(command.anchorId), "群组锚点须在明确选择的物体中");

function validateTracks(tracks: EntityTrack[]) {
  if (tracks.length > 200) throw new Error("群组修改后超过每Take 200条轨道上限");
  const trackIds = new Set<string>(), markIds = new Set<string>();
  for (const track of tracks) {
    if (trackIds.has(track.entityId)) throw new Error("群组候选存在重复物体轨道");
    trackIds.add(track.entityId);
    if (track.marks.length > 2000) throw new Error("群组修改后超过每轨2000标记上限");
    for (const mark of track.marks) {
      if (markIds.has(mark.id)) throw new Error("群组候选存在重复标记ID");
      markIds.add(mark.id);
      markGeometry.parse(mark);
    }
  }
}

/** Mutates only after every candidate passes; the caller must still readProject the complete batch. */
export function transformEntities(scene: Scene, shot: Shot, take: BlockingTake, value: z.infer<typeof groupTransformCommand>) {
  const command = groupTransformCommand.parse(value);
  const shots = [...scene.shots, ...scene.drafts ?? []];
  if (scene.id !== command.sceneId || shot.id !== command.shotId || shot.blockingTakeId !== take.id || !shots.includes(shot) || !scene.blocking.includes(take)) throw new Error("群组场景、镜头或Take绑定已变化，请重新读取");
  if (command.time > shot.duration) throw new Error("群组采样时间超出镜头时长");
  if (scene.entities.length > 200) throw new Error("场景超过200物体上限");
  if (scene.blocking.some(item => item.tracks.length > 200 || item.tracks.some(track => track.marks.length > 2000))) throw new Error("源Take超过200轨道或每轨2000标记上限");
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  if (byId.size !== scene.entities.length) throw new Error("场景物体ID重复");
  const selected = new Set(command.entityIds);
  const entities = command.entityIds.map(id => {
    const entity = byId.get(id);
    if (!entity) throw new Error(`群组物体不存在：${id}`);
    return entity;
  });
  const anchor = byId.get(command.anchorId)!;
  if (command.scope === "scene" && scene.blocking.some(item => item.confirmed)) throw new Error("场景变换涉及全部Take，存在确认Take；请先明确解除相关确认，复制当前Take不能隔离场景布局");
  if (command.scope === "take" && take.confirmed) throw new Error("当前Take已确认，请先为当前镜头复制Take再变换群组");
  if (command.scope === "take" && command.scale !== undefined && command.scale !== anchor.transform.scale) throw new Error("比例属于场景布局，Take内不能缩放锚点");
  const evaluator = new ShotEvaluator(scene, shot);
  const states = new Map(evaluator.evaluate(command.time).entities.map(state => [state.entityId, state]));
  const stateOf = (entityId: string): EntityState => {
    const state = states.get(entityId);
    if (!state) throw new Error(`群组物体缺少真实世界求值：${entityId}`);
    vector.parse(state.position); coordinate.parse(state.heading);
    return state;
  };
  const before = stateOf(anchor.id), deltaRotationY = command.rotationY - before.heading;
  const cos = Math.cos(deltaRotationY), sin = Math.sin(deltaRotationY);
  const mapPosition = (position: V3): V3 => {
    const dx = position.x - before.position.x, dz = position.z - before.position.z;
    return vector.parse({ x: command.position.x + dx * cos + dz * sin, y: command.position.y + position.y - before.position.y, z: command.position.z - dx * sin + dz * cos });
  };
  const candidates = new Map<string, Entity>();
  const trackCandidates = new Map<BlockingTake, EntityTrack[]>();
  const mapTrack = (track: EntityTrack): EntityTrack => {
    const entity = byId.get(track.entityId)!;
    const first = track.marks[0]?.position;
    const staticFallback = command.scope === "take" && first && track.marks.every(mark => !mark.lookAtEntityId && !mark.attachTo && [mark.position, ...(mark.via ?? [])].every(position => position.x === first.x && position.y === first.y && position.z === first.z));
    return { ...track, marks: track.marks.map(mark => {
      // ACT: only a constraint-free, strictly stationary raw path needs the
      // scene heading made explicit to rotate within an isolated Take.
      const heading = mark.arriveHeading !== undefined ? mark.arriveHeading + deltaRotationY : staticFallback ? entity.transform.rotationY + deltaRotationY : undefined;
      return { ...mark, position: mapPosition(mark.position), ...(mark.via ? { via: mark.via.map(mapPosition) } : {}), ...(heading !== undefined ? { arriveHeading: coordinate.parse(heading) } : {}) };
    }) };
  };
  const depthOf = (entity: Entity) => {
    if (entity.attachedTo && !entity.attachedLocal) throw new Error("群组附着物体缺少局部偏移");
    const seen = new Set([entity.id]);
    let parentId = entity.attachedTo, depth = 0;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || seen.has(parentId) || ++depth > 4) throw new Error("群组附着父链无效、成环或超过四层");
      if (parent.attachedTo && !parent.attachedLocal) throw new Error("群组附着父链缺少局部偏移");
      seen.add(parentId); parentId = parent.attachedTo;
    }
    return depth;
  };
  const firstTimes = new Map(take.tracks.filter(track => track.marks.length).map(track => [track.entityId, Math.min(...track.marks.map(mark => mark.time))]));
  const followsSelectedParent = (entity: Entity) => {
    const seen = new Set([entity.id]);
    let parentId = entity.attachedTo;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || seen.has(parentId) || seen.size > 4) throw new Error("群组附着父链无效、成环或超过四层");
      if (parent.attachedTo && !parent.attachedLocal) throw new Error("群组附着父链缺少局部偏移");
      if (selected.has(parentId)) return true;
      seen.add(parentId);
      if ((firstTimes.get(parentId) ?? Infinity) <= command.time) return false;
      parentId = parent.attachedTo;
    }
    return false;
  };
  const depths = new Map(entities.map(entity => [entity.id, depthOf(entity)]));
  if (command.scope === "scene") {
    for (const entity of entities) {
      const next = { ...entity, transform: { ...entity.transform, position: mapPosition(entity.transform.position), rotationY: coordinate.parse(entity.transform.rotationY + deltaRotationY), ...(entity.id === anchor.id && command.scale !== undefined ? { scale: command.scale } : {}) } };
      transform.parse(next.transform); candidates.set(entity.id, next);
    }
    for (const item of scene.blocking) trackCandidates.set(item, item.tracks.map(track => selected.has(track.entityId) ? mapTrack(track) : track));
  } else {
    const tracks = [...take.tracks];
    const initialStates = new Map(evaluator.evaluate(0).entities.map(state => [state.entityId, state]));
    for (const entity of entities) {
      const index = tracks.findIndex(track => track.entityId === entity.id), track = index < 0 ? undefined : tracks[index];
      const activeMarriage = entity.attachedTo && (firstTimes.get(entity.id) ?? Infinity) > command.time;
      if (entity.attachedTo && !entity.attachedLocal) throw new Error("群组附着物体缺少局部偏移");
      if (activeMarriage && !followsSelectedParent(entity)) throw new Error("当前物体仍随未选父体附着，请改用场景布局或先明确处理关系；不会自动脱离");
      if (track?.marks.length) { tracks[index] = mapTrack(track); continue; }
      if (activeMarriage) continue;
      const state = initialStates.get(entity.id);
      if (!state) throw new Error("群组物体缺少第0秒的有效姿态");
      // Store only raw gait/heading; effective state.joints already includes
      // the scene base and must not be copied back into a new track.
      const mark = { ...createActorMark(mapPosition(state.position), 0, state.gait), arriveHeading: coordinate.parse(state.heading + deltaRotationY) };
      if (track) tracks[index] = { ...track, marks: [mark] }; else tracks.push({ entityId: entity.id, marks: [mark] });
    }
    trackCandidates.set(take, tracks);
  }
  const candidateScene: Scene = { ...scene, entities: scene.entities.map(entity => candidates.get(entity.id) ?? entity), blocking: scene.blocking.map(item => trackCandidates.has(item) ? { ...item, tracks: trackCandidates.get(item)! } : item) };
  if (command.scope === "scene") {
    const attached = entities.filter(entity => entity.attachedTo).map(entity => ({ entity, depth: depths.get(entity.id)! })).sort((a, b) => a.depth - b.depth);
    // ACT: at most 200 entities, depth <=4 and <=2000 marks/track. Re-evaluate
    // each selected child against its candidate parent to honor unselected
    // intermediate parents, gaze and boarding. This is O(n²) in entities;
    // a future batch evaluator can cache these parent passes if profiling needs it.
    for (const { entity } of attached) {
      if (!entity.attachedLocal) throw new Error("群组附着物体缺少局部偏移");
      const originalParent = byId.get(entity.attachedTo!)!, parentState = stateOf(originalParent.id);
      // ACT: freeze the original fully evaluated parent so removing this child's
      // own track cannot change its gaze/boarding anchor. Evaluate only the
      // attachment relation; an active independent child track is not its local.
      const attachmentScene: Scene = { ...scene, entities: [
        { ...originalParent, attachedTo: undefined, attachedLocal: undefined, transform: { ...originalParent.transform, position: { ...parentState.position }, rotationY: parentState.heading } }, entity,
      ], blocking: [{ ...take, tracks: [] }] };
      const desired = new ShotEvaluator(attachmentScene, shot).evaluate(command.time).entities.find(state => state.entityId === entity.id);
      if (!desired) throw new Error("群组附着物体缺少原局部关系世界姿态");
      const parent = new ShotEvaluator(candidateScene, shot).evaluate(command.time).entities.find(state => state.entityId === entity.attachedTo);
      if (!parent) throw new Error("群组附着父体缺少候选世界姿态");
      vector.parse(parent.position); coordinate.parse(parent.heading);
      const position = mapPosition(desired.position);
      const dx = position.x - parent.position.x, dz = position.z - parent.position.z;
      const parentCos = Math.cos(parent.heading), parentSin = Math.sin(parent.heading);
      const local = { ...entity.attachedLocal, x: dx * parentCos - dz * parentSin, y: position.y - parent.position.y, z: dx * parentSin + dz * parentCos, rotY: desired.heading + deltaRotationY - parent.heading };
      localOffset.parse(local); candidates.get(entity.id)!.attachedLocal = local;
    }
  }
  for (const entity of candidates.values()) { transform.parse(entity.transform); if (entity.attachedLocal) localOffset.parse(entity.attachedLocal); }
  for (const tracks of trackCandidates.values()) validateTracks(tracks);
  const after = new ShotEvaluator(candidateScene, shot).evaluate(command.time).entities.find(state => state.entityId === anchor.id);
  if (!after) throw new Error("群组锚点缺少最终候选世界姿态");
  vector.parse(after.position); coordinate.parse(after.heading);
  // Commit only validated candidates; the enclosing command batch still owns
  // readProject validation, immutable file publication and one host history step.
  if (command.scope === "scene") scene.entities = candidateScene.entities;
  for (const [item, tracks] of trackCandidates) item.tracks = tracks;
  const sharedShotIds = shots.filter(item => item.id !== shot.id && item.blockingTakeId === take.id).map(item => item.id);
  return {
    entityIds: [...command.entityIds], scope: command.scope,
    affectedShotIds: shots.filter(item => command.scope === "scene" || item.blockingTakeId === take.id).map(item => item.id), sharedShotIds,
    anchor: { entityId: anchor.id, time: command.time, before: { position: { ...before.position }, rotationY: before.heading, scale: anchor.transform.scale }, requested: { position: { ...command.position }, rotationY: command.rotationY, ...(command.scale !== undefined ? { scale: command.scale } : {}) }, after: { position: { ...after.position }, rotationY: after.heading, scale: candidates.get(anchor.id)?.transform.scale ?? anchor.transform.scale }, deltaRotationY },
    sceneScope: command.scope === "scene" ? "场景布局及所选物体在全部Take的走位均改变，影响本场景全部镜头；仅锚点比例可变" : "仅改变当前共享Take；场景基础变换和附着局部偏移保留，未开始的附着子体随已选父链，不自动造轨脱离",
    constraintNote: "原lookAt、boarding、附着和路径求值继续生效；变换raw轨迹，不保证约束后的整段world轨迹严格刚体",
  };
}
