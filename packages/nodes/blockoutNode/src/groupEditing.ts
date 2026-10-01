import type { BlockoutCommand } from "./editing";
import { actionPresets } from "./nativeBlockout/actionPresets";
import { buildRoutine, type RoutineSpec } from "./nativeBlockout/choreography";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { createActorMark, createEntity } from "./nativeBlockout/schema";
import { choreographMotion, generateSequence } from "./nativeBlockout/sequences";
import type { ActorMark, BlockingTake, Entity, Scene, Shot } from "./nativeBlockout/types";

type GroupCommand = Extract<BlockoutCommand, { type: "stageSequence" | "stageRoutine" | "applyRoutineToEntities" | "applyMotionToEntities" | "applyActionToEntities" }>;
type GeneratedMark = Pick<ActorMark, "time" | "position" | "gait" | "hold" | "easeIn" | "easeOut"> & Partial<Pick<ActorMark, "joints" | "arriveHeading">>;
type GeneratedEntity = { assetId: string; name: string; position: Entity["transform"]["position"]; rotationY: number; label?: Entity["label"]; marks: GeneratedMark[]; delayedUntil?: number };

export interface GroupChanges {
  entityIds: string[];
  newEntityIds?: string[];
  start: number;
  end: number;
  replacedMarks: number;
  sharedShotIds: string[];
  affectedShotIds?: string[];
  delayedEntries?: { entityId: string; delayedUntil: number }[];
  endHoldEntityIds?: string[];
  effectiveSpec?: RoutineSpec;
}

/** Prepare all performers before the caller validates and publishes the cloned document. */
export function prepareGroupEdit(scene: Scene, shot: Shot, take: BlockingTake, command: GroupCommand, markFields: ReadonlySet<string>) {
  const staging = command.type === "stageSequence" || command.type === "stageRoutine";
  // ACT: entity/track lookups are bounded by the native 200-item document limits.
  const entities = "entityIds" in command ? command.entityIds.map(id => {
    const entity = scene.entities.find(entity => entity.id === id);
    if (!entity) throw new Error(`群组物体不存在：${id}；未跳过任何选择`);
    if (command.type !== "applyActionToEntities" && (!entity.assetId.startsWith("person.") || entity.sourceFile)) throw new Error("群组例程及身体动作须全部为未带sourceFile的内置人物；请明确选择完整目标");
    const original = take.tracks.find(track => track.entityId === id)?.marks ?? [];
    if (entity.attachedTo || original.some(mark => mark.attachTo)) throw new Error("群组表演含附着或boarding关系，请先明确处理关系；原表演未覆盖");
    const active = [...original].sort((a, b) => a.time - b.time)[0];
    if ([...original.filter(mark => mark.time <= shot.duration), ...(active ? [active] : [])].some(mark => Object.keys(mark).some(key => !markFields.has(key)))) throw new Error("群组镜头区间或起点活动标记含未知业务字段，请先明确处理；原表演未覆盖");
    return entity;
  }) : [];
  const world = staging ? [] : new ShotEvaluator(scene, shot).evaluate(0).entities;
  const states = entities.map(entity => {
    const state = world.find(state => state.entityId === entity.id);
    if (!state) throw new Error("群组物体缺少当前Take第0秒的世界求值结果");
    return state;
  });
  let specs: GeneratedEntity[];
  let effectiveSpec: RoutineSpec | undefined;
  if (command.type === "stageSequence") {
    specs = generateSequence({ type: command.sequenceType, count: command.count, style: command.style, origin: command.origin, duration: shot.duration });
  } else if (command.type === "stageRoutine") {
    effectiveSpec = { ...command.spec, durationS: shot.duration };
    specs = buildRoutine(effectiveSpec, { origin: command.origin });
  } else if (command.type === "applyRoutineToEntities") {
    effectiveSpec = { ...command.spec, performers: entities.length, durationS: shot.duration };
    const origin = { x: states.reduce((sum, state) => sum + state.position.x / states.length, 0), z: states.reduce((sum, state) => sum + state.position.z / states.length, 0), heading: states[0].heading };
    specs = buildRoutine(effectiveSpec, { origin });
  } else {
    specs = entities.map((entity, index) => {
      const state = states[index];
      const marks = command.type === "applyMotionToEntities"
        ? choreographMotion(command.presetId, { ...state.position }, state.heading, shot.duration)
        : actionPresets.find(preset => preset.id === command.presetId)?.generate({ start: { ...state.position, heading: state.heading }, duration: shot.duration });
      if (!marks?.length) throw new Error("群组预设未生成真实表演标记；原表演未覆盖");
      return { assetId: entity.assetId, name: entity.name, position: { ...state.position }, rotationY: state.heading, marks };
    });
  }
  const expected = command.type === "stageSequence" ? command.count : command.type === "stageRoutine" ? command.spec.performers : entities.length;
  if (specs.length !== expected) throw new Error("群组生成数量与完整请求不一致；未截取或跳过任何人物");
  if (scene.entities.length + (staging ? specs.length : 0) > 200) throw new Error("群组生成后超过场景200实体上限；未新增部分人物");
  const newEntities: Entity[] = [];
  const tracks: BlockingTake["tracks"] = [];
  const entityIds: string[] = [];
  const delayedEntries: NonNullable<GroupChanges["delayedEntries"]> = [];
  const endHoldEntityIds: string[] = [];
  let replacedMarks = 0;
  for (const [index, spec] of specs.entries()) {
    const entity = staging ? createEntity(spec.assetId, spec.name, { ...spec.position }) : entities[index];
    if (staging) {
      entity.transform.rotationY = spec.rotationY;
      if (spec.label) entity.label = { ...spec.label };
      newEntities.push(entity);
    }
    entityIds.push(entity.id);
    if (!spec.marks.length) {
      if (command.type !== "stageSequence" || !Number.isFinite(spec.delayedUntil) || spec.delayedUntil! <= shot.duration) throw new Error("群组缺少真实表演标记或明确的镜尾后计划入场时间；未补造轨道");
      delayedEntries.push({ entityId: entity.id, delayedUntil: spec.delayedUntil! });
      continue;
    }
    if (spec.marks.length > 2000 || spec.marks.some((mark, markIndex) => !Number.isFinite(mark.time) || mark.time < 0 || mark.time > shot.duration || markIndex > 0 && mark.time <= spec.marks[markIndex - 1].time)) throw new Error("群组标记须在当前镜头时窗内严格递增且每人不超过2000；未截尾或合并近点");
    const marks = spec.marks.map((specMark, markIndex) => {
      // ACT: fallback headings serve the first/waiting marks; native travel
      // headings still own moving legs, without changing the scene transform.
      const before = spec.marks[markIndex - 1], after = spec.marks[markIndex + 1];
      const waiting = markIndex === 0 || (!before || before.position.x === specMark.position.x && before.position.y === specMark.position.y && before.position.z === specMark.position.z)
        && (!after || after.position.x === specMark.position.x && after.position.y === specMark.position.y && after.position.z === specMark.position.z);
      const mark = { ...createActorMark({ ...specMark.position }, specMark.time, specMark.gait), hold: specMark.hold, easeIn: specMark.easeIn, easeOut: specMark.easeOut,
        ...(specMark.joints ? { joints: { ...specMark.joints } } : {}),
        ...(specMark.arriveHeading !== undefined ? { arriveHeading: specMark.arriveHeading } : waiting ? { arriveHeading: spec.rotationY } : {}) };
      return mark;
    });
    const original = staging ? [] : take.tracks.find(track => track.entityId === entity.id)?.marks ?? [];
    // Explicit full performance replacement leaves scene bases and later marks intact.
    const tail = original.filter(mark => mark.time > shot.duration);
    const last = marks.at(-1)!;
    if (tail.length && last.time < shot.duration) {
      // ACT: this derived hold boundary isolates the old tail; it does not
      // synthesize the unfinished motif or copy evaluator totals/static bases.
      marks.push({ ...createActorMark({ ...last.position }, shot.duration, last.gait), hold: 0, easeIn: 0, easeOut: 0,
        ...(last.joints ? { joints: { ...last.joints } } : {}), ...(last.arriveHeading !== undefined ? { arriveHeading: last.arriveHeading } : {}) });
      endHoldEntityIds.push(entity.id);
    }
    if (tail.length + marks.length > 2000) throw new Error("保留镜尾外原标记后超过每人2000标记上限；原表演未覆盖");
    replacedMarks += original.length - tail.length;
    tracks.push({ entityId: entity.id, marks: [...marks, ...tail].sort((a, b) => a.time - b.time) });
  }
  if (take.tracks.length + tracks.filter(track => !take.tracks.some(original => original.entityId === track.entityId)).length > 200) throw new Error("群组生成后超过当前Take的200轨上限；原表演未覆盖");
  const shots = [...scene.shots, ...scene.drafts ?? []];
  const changes: GroupChanges = { entityIds, start: 0, end: shot.duration, replacedMarks,
    sharedShotIds: shots.filter(candidate => candidate.id !== shot.id && candidate.blockingTakeId === take.id).map(candidate => candidate.id),
    ...(staging ? { newEntityIds: entityIds, affectedShotIds: shots.map(candidate => candidate.id) } : {}),
    ...(delayedEntries.length ? { delayedEntries } : {}), ...(endHoldEntityIds.length ? { endHoldEntityIds } : {}), ...(effectiveSpec ? { effectiveSpec } : {}) };
  return { newEntities, tracks, changes };
}
