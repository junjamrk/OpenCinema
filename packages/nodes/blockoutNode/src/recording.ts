// OpenCinema adaptation of Blockout's 250ms camera/entity recording (Apache-2.0).
// Copyright 2026 Sam Wasserman (wassermanproductions.com); see ../readme.md.
import { lerp, lerpAngle } from "./nativeBlockout/easing";
import { createActorMark, createCameraMark } from "./nativeBlockout/schema";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { entityPoseBase } from "./entityPose";
import type { ActorMark, CameraMark, Scene, Shot, ShotCamera, V3 } from "./nativeBlockout/types";

export type RecordingPose = Pick<CameraMark, "position" | "pan" | "tilt" | "roll" | "focalLength">;
export type RecordingSample = RecordingPose & { time: number };
export type ActorRecordingSample = { position: V3; heading: number; time: number };
export const recordTuning = {
  precise: { rate: 4, maxSpeed: 4, wheel: 0.004 }, normal: { rate: 8, maxSpeed: 12, wheel: 0.01 }, fast: { rate: 16, maxSpeed: 40, wheel: 0.02 },
};
export type RecordPrecision = keyof typeof recordTuning;

export function actorRecordingMark(previous: Pick<ActorMark, "position" | "time"> | undefined, sample: ActorRecordingSample): ActorMark {
  const speed = previous && sample.time > previous.time ? Math.hypot(sample.position.x - previous.position.x, sample.position.z - previous.position.z) / (sample.time - previous.time) : 0;
  return { ...createActorMark({ ...sample.position }, sample.time, speed <= 0.01 ? "stand" : speed > 3.4 ? "run" : speed > 2 ? "jog" : "walk"), arriveHeading: sample.heading, hold: 0, easeIn: 0, easeOut: 0 };
}

export function sampleActorRecording(marks: ActorMark[], previous: ActorRecordingSample, current: ActorRecordingSample, finish = false) {
  if (!marks.length) marks.push(actorRecordingMark(undefined, previous));
  let next = marks[0].time + marks.length * 0.25;
  while (next <= current.time + 1e-7) {
    const amount = current.time > previous.time ? Math.max(0, Math.min(1, (next - previous.time) / (current.time - previous.time))) : 1;
    marks.push(actorRecordingMark(marks.at(-1), { time: next, position: { x: lerp(previous.position.x, current.position.x, amount), y: lerp(previous.position.y, current.position.y, amount), z: lerp(previous.position.z, current.position.z, amount) }, heading: lerpAngle(previous.heading, current.heading, amount) }));
    next = marks[0].time + marks.length * 0.25;
  }
  if (finish && current.time > marks.at(-1)!.time + 1e-7) marks.push(actorRecordingMark(marks.at(-1), current));
}

/** Capture source semantics once; preview and adoption share the same track construction. */
export function createActorRecordingSource(scene: Scene, shot: Shot, entityId: string) {
  const source = JSON.parse(JSON.stringify(scene)) as Scene, sourceShot = [...source.shots, ...source.drafts ?? []].find(item => item.id === shot.id);
  const entity = source.entities.find(item => item.id === entityId), take = source.blocking.find(item => item.id === shot.blockingTakeId);
  if (!entity || !take || !sourceShot) throw new Error("录制角色、镜头或Take不存在");
  const original = [...take.tracks.find(item => item.entityId === entityId)?.marks ?? []].sort((a, b) => a.time - b.time);
  const baseJoints = entityPoseBase(entity, original.length > 0).joints;
  if (entity.attachedTo || original.some(mark => mark.attachTo)) throw new Error("附着或含boarding标记的角色不能直接操演，请先在独立表演中明确处理关系");
  if (original.length > 1759) throw new Error("源角色标记过多，无法在2000标记上限内同时保留原姿态/视线与录制采样");
  const evaluator = new ShotEvaluator(source, sourceShot), metadata = new Map<number, Partial<ActorMark>>();
  const hasJoints = original.some(mark => !!mark.joints);
  return {
    track(samples: ActorMark[]) {
      if (!samples.length) throw new Error("角色录制没有实际采样");
      const start = samples[0].time, end = samples.at(-1)!.time;
      const times = new Map(samples.map(mark => [mark.time.toFixed(7), mark.time]));
      for (const mark of original) if (mark.time >= start && mark.time <= end && !times.has(mark.time.toFixed(7))) times.set(mark.time.toFixed(7), mark.time);
      const recorded = [...times.values()].sort((a, b) => a - b).map((time, index) => {
        let fields = metadata.get(time);
        if (!fields) {
          const template = original.findLast(mark => mark.time <= time + 1e-7) ?? original[0];
          fields = template ? structuredClone(template) : {};
          delete fields.via; delete fields.attachTo;
          const joints = template?.time === time ? template.joints : hasJoints ? evaluator.evaluate(time).entities.find(item => item.entityId === entityId)?.joints : undefined;
          if (joints) {
            fields.joints = { ...joints };
            // ACT: interpolated evaluator joints include the frozen scene base; store raw track joints so playback adds it only once.
            if (template?.time !== time) for (const [name, value] of Object.entries(baseJoints)) fields.joints[name] = (fields.joints[name] ?? 0) - value;
          } else delete fields.joints;
          // ACT: cache only fixed source/quarter-second times; transient live endpoints must not grow a frame-rate-sized cache.
          const grid = (time - samples[0].time) / 0.25;
          if (original.some(mark => mark.time === time) || Math.abs(grid - Math.round(grid)) < 1e-7) metadata.set(time, fields);
        }
        const rightIndex = samples.findIndex(mark => mark.time >= time), right = samples[rightIndex < 0 ? samples.length - 1 : rightIndex], left = samples[Math.max(0, rightIndex < 0 ? samples.length - 1 : rightIndex - 1)];
        const amount = right.time > left.time ? Math.max(0, Math.min(1, (time - left.time) / (right.time - left.time))) : 1;
        return { ...fields, ...right, id: `recorded${index}`, time, position: { x: lerp(left.position.x, right.position.x, amount), y: lerp(left.position.y, right.position.y, amount), z: lerp(left.position.z, right.position.z, amount) }, arriveHeading: lerpAngle(left.arriveHeading ?? entity.transform.rotationY, right.arriveHeading ?? entity.transform.rotationY, amount) } as ActorMark;
      });
      return [...original.filter(mark => mark.time < start || mark.time > end).map(mark => structuredClone(mark)), ...recorded].sort((a, b) => a.time - b.time);
    },
  };
}

function recordingMark(sample: RecordingSample): CameraMark {
  return { ...createCameraMark({ ...sample.position }, sample.time, sample.pan, sample.tilt, sample.focalLength), roll: sample.roll, hold: 0, easeIn: 0, easeOut: 0 };
}

/** Sample the observed frame interval, retaining the final pose on stop. */
export function sampleCameraRecording(marks: CameraMark[], previous: RecordingSample, current: RecordingSample, finish = false) {
  if (!marks.length) marks.push(recordingMark(previous));
  let next = marks[0].time + marks.length * 0.25;
  while (next <= current.time + 1e-7) {
    const amount = current.time > previous.time ? Math.max(0, Math.min(1, (next - previous.time) / (current.time - previous.time))) : 1;
    marks.push(recordingMark({ time: next, position: { x: lerp(previous.position.x, current.position.x, amount), y: lerp(previous.position.y, current.position.y, amount), z: lerp(previous.position.z, current.position.z, amount) }, pan: lerpAngle(previous.pan, current.pan, amount), tilt: lerpAngle(previous.tilt, current.tilt, amount), roll: lerpAngle(previous.roll, current.roll, amount), focalLength: lerp(previous.focalLength, current.focalLength, amount) }));
    next = marks[0].time + marks.length * 0.25;
  }
  if (finish && current.time > marks.at(-1)!.time + 1e-7) marks.push(recordingMark(current));
}

export function recordingCamera(sensorId: ShotCamera["sensorId"], marks: CameraMark[]): ShotCamera {
  return { sensorId, rig: "sticks", rigIntensity: 0, seed: 0, marks };
}
