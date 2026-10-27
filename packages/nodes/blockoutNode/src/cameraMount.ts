import type { EntityState, ShotCamera, V3 } from "./nativeBlockout/types";

export type CameraMountFrame = { position: V3; heading: number };

export function cameraMountFrame(camera: Pick<ShotCamera, "rig" | "mountEntityId">, entities: readonly EntityState[]): CameraMountFrame | undefined {
  if (camera.rig !== "carMount" || !camera.mountEntityId) return;
  const entity = entities.find(entity => entity.entityId === camera.mountEntityId);
  if (!entity) throw new Error("摄影机挂载主体不存在，请重新读取场景");
  return { position: { ...entity.position }, heading: entity.heading };
}

export function cameraPointToWorld(point: V3, frame?: CameraMountFrame): V3 {
  if (!frame) return { ...point };
  const cos = Math.cos(frame.heading), sin = Math.sin(frame.heading);
  return { x: frame.position.x + point.x * cos + point.z * sin, y: frame.position.y + point.y, z: frame.position.z - point.x * sin + point.z * cos };
}

export function cameraPointToLocal(point: V3, frame?: CameraMountFrame): V3 {
  if (!frame) return { ...point };
  const cos = Math.cos(frame.heading), sin = Math.sin(frame.heading);
  const x = point.x - frame.position.x, z = point.z - frame.position.z;
  return { x: x * cos - z * sin, y: point.y - frame.position.y, z: x * sin + z * cos };
}

export function cameraPoseToWorld<T extends { position: V3; pan: number }>(pose: T, frame?: CameraMountFrame): T {
  return { ...pose, position: cameraPointToWorld(pose.position, frame), pan: pose.pan + (frame?.heading ?? 0) };
}

export function cameraPoseToLocal<T extends { position: V3; pan: number }>(pose: T, frame?: CameraMountFrame): T {
  return { ...pose, position: cameraPointToLocal(pose.position, frame), pan: pose.pan - (frame?.heading ?? 0) };
}
