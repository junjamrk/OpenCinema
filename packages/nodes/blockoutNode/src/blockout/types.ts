/**
 * Copyright 2026 Sam Wasserman (wassermanproductions.com).
 * SPDX-License-Identifier: Apache-2.0
 * Modified 2026-10-10: retain sampling types only; scene/project persistence
 * remains owned by Toonflow. Based on Blockout src/engine/types.ts at
 * 3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9.
 * License and attribution: ../../licenses/blockoutLicense.txt and ../../licenses/blockoutNotice.txt.
 */

export interface V3 { x: number; y: number; z: number; }
export type GaitId = "stand" | "walk" | "jog" | "run" | "sit" | "lie" | "crouch" | "gesture" | "fall";
export type RigId = "sticks" | "dolly" | "steadicam" | "handheld" | "crane" | "drone" | "carMount";
export type SensorId = "super16" | "super35" | "fullFrame" | "imax65";
export type ShotSizeId = "EWS" | "WS" | "FS" | "MS" | "MCU" | "CU" | "ECU";
export type AspectId = "16:9" | "9:16" | "2.39:1" | "4:3" | "1:1";

export interface MarkBase {
  id: string;
  time: number;
  hold: number;
  easeIn: number;
  easeOut: number;
  position: V3;
  via?: V3[];
}

export interface ActorMark extends MarkBase {
  gait: GaitId;
  arriveHeading?: number;
  joints?: Record<string, number>;
  attachTo?: string;
}

export interface CameraMark extends MarkBase {
  pan: number;
  tilt: number;
  roll: number;
  focalLength: number;
  focusDistance?: number;
}

/** Transient compilation input; never saved as another project model. */
export interface Entity {
  id: string;
  assetId: string;
  name: string;
  label?: { text: string; color: string };
  transform: { position: V3; rotationY: number; scale: number };
  height: number;
  speedScale: number;
  attachedTo?: string;
  attachedLocal?: { x: number; y: number; z: number; rotY: number };
}

export interface ShotCamera {
  sensorId: SensorId;
  rig: RigId;
  rigIntensity: number;
  seed: number;
  mountEntityId?: string;
  trackEntityId?: string;
  marks: CameraMark[];
}

export interface Scene {
  entities: Entity[];
  blocking: { id: string; tracks: { entityId: string; marks: ActorMark[] }[] }[];
}

export interface Shot {
  duration: number;
  aspect: AspectId;
  blockingTakeId: string;
  camera: ShotCamera;
}

export interface EntityState {
  entityId: string;
  position: V3;
  heading: number;
  gait: GaitId;
  distanceTravelled: number;
  speed: number;
  joints?: Record<string, number>;
}

export interface CameraState {
  position: V3;
  pan: number;
  tilt: number;
  roll: number;
  focalLength: number;
  focusDistance?: number;
  vfov: number;
}

export interface ShotState { time: number; camera: CameraState; entities: EntityState[]; }

export type ActorKeyframe = Partial<Omit<ActorMark, "time" | "position">> & Pick<ActorMark, "time" | "position">;
export type CameraKeyframe = Partial<Omit<CameraMark, "time" | "position">> & Pick<CameraMark, "time" | "position">;

/** Positions are meters, rotations radians, times seconds. Y-up, forward -Z. */
export interface ShotEvaluationInput {
  duration: number;
  fps?: number;
  aspect?: AspectId;
  camera: {
    position: V3;
    pan: number;
    tilt: number;
    roll?: number;
    focalLength: number;
    sensorId?: SensorId;
    rig?: RigId;
    rigIntensity?: number;
    seed?: number;
    focusDistance?: number;
    mountActorId?: string;
    trackActorId?: string;
    marks?: CameraKeyframe[];
  };
  actors: {
    id: string;
    name?: string;
    assetId?: string;
    position: V3;
    rotationY?: number;
    scale?: number;
    /** Model-local height; multiply by scale for world-space height. */
    height?: number;
    speedScale?: number;
    attachedTo?: string;
    attachedLocal?: { x: number; y: number; z: number; rotY: number };
    marks?: ActorKeyframe[];
  }[];
}

export interface EvaluatedActor {
  id: string;
  position: V3;
  rotationY: number;
  scale: number;
  height: number;
  gait: GaitId;
  gaitPhase: number;
  speed: number;
  distanceTravelled: number;
  joints?: Record<string, number>;
}

export interface EvaluatedShot {
  time: number;
  frame: number;
  camera: CameraState & {
    quaternion: { x: number; y: number; z: number; w: number };
    forward: V3;
  };
  actors: EvaluatedActor[];
}
