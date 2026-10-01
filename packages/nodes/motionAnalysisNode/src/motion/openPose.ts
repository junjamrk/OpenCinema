/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Sam Wasserman (Wasserman Productions / Wasserman.ai).
 * Derived from Motion Previs Studio, commit 95e7d0ff1d4cc546f7eb09a74ccbd084988a19bc.
 * Modified for OpenCinema: BODY25 JSON and bounded CPU RGBA control export.
 * License and attribution: ../../licenses/motionLicense.txt and ../../licenses/motionNotice.txt.
 */
/**
 * Maps MediaPipe landmarks to OpenPose BODY_25 using the joint table below.
 * Left/right follow the subject. MediaPipe has one foot_index per foot, reused
 * for its small toe; joints without a source are emitted with confidence 0.
 */

import type { Landmark, PoseData, PoseFrame, PosePersonFrame } from "./types";

export const body25Count = 25;

// Kind of source for each BODY_25 index:
//  - a number N: copy MediaPipe landmark N directly.
//  - a [a, b] pair: midpoint of MediaPipe landmarks a and b (derived joint).
//  - null: no MediaPipe source; emit (0,0,0).
type Source = number | [number, number] | null;

export const body25FromMediaPipe: Source[] = [
  0, // 0  Nose
  [11, 12], // 1  Neck = midpoint(shoulders)
  12, // 2  RShoulder (MediaPipe right_shoulder)
  14, // 3  RElbow
  16, // 4  RWrist
  11, // 5  LShoulder (MediaPipe left_shoulder)
  13, // 6  LElbow
  15, // 7  LWrist
  [23, 24], // 8  MidHip = midpoint(hips)
  24, // 9  RHip
  26, // 10 RKnee
  28, // 11 RAnkle
  23, // 12 LHip
  25, // 13 LKnee
  27, // 14 LAnkle
  5, // 15 REye (MediaPipe right_eye)
  2, // 16 LEye (MediaPipe left_eye)
  8, // 17 REar (MediaPipe right_ear)
  7, // 18 LEar (MediaPipe left_ear)
  31, // 19 LBigToe (MediaPipe left_foot_index)
  31, // 20 LSmallToe (reuse: MediaPipe has one foot index per foot)
  29, // 21 LHeel
  32, // 22 RBigToe (MediaPipe right_foot_index)
  32, // 23 RSmallToe (reuse)
  30 // 24 RHeel
];

// Canonical OpenPose BODY_25 limb pairs + the standard per-limb color wheel
// (BGR in the original C++; expressed here as CSS hex). Order matters for the
// look: draw limbs first, then joint dots.
export const body25Pairs: Array<[number, number]> = [
  [1, 0], [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8],
  [8, 9], [9, 10], [10, 11], [8, 12], [12, 13], [13, 14], [1, 8],
  [0, 15], [0, 16], [15, 17], [16, 18], [14, 19], [19, 20], [14, 21],
  [11, 22], [22, 23], [11, 24]
];

// Per-joint colors follow the canonical OpenPose wheel (25 hues around the
// spectrum). Index = BODY_25 joint index.
export const body25Colors: string[] = [
  "#ff0000", "#ff5500", "#ffaa00", "#ffff00", "#aaff00", "#55ff00", "#00ff00", "#00ff55",
  "#00ffaa", "#00ffff", "#00aaff", "#0055ff", "#0000ff", "#5500ff", "#aa00ff", "#ff00ff",
  "#ff00aa", "#ff0055", "#ff0000", "#ff0033", "#ff0066", "#ff0099", "#3300ff", "#6600ff", "#9900ff"
];

export type OpenPoseKeypoint = { x: number; y: number; c: number };
export type OpenPosePerson = { person_id: number[]; pose_keypoints_2d: number[] };
export type OpenPoseFrameJson = { version: number; people: OpenPosePerson[] };

/**
 * Map one MediaPipe person (normalized landmarks) to BODY_25 keypoints in the
 * given pixel resolution. Missing/derived-from-missing joints get confidence 0.
 */
export function mediaPipeToBody25(
  landmarks: Landmark[],
  width: number,
  height: number
): OpenPoseKeypoint[] {
  const out: OpenPoseKeypoint[] = [];
  for (let j = 0; j < body25Count; j += 1) {
    out.push(sourceToKeypoint(body25FromMediaPipe[j], landmarks, width, height));
  }
  return out;
}

function sourceToKeypoint(source: Source, landmarks: Landmark[], width: number, height: number): OpenPoseKeypoint {
  if (source === null) return { x: 0, y: 0, c: 0 };
  if (Array.isArray(source)) {
    const a = landmarks[source[0]];
    const b = landmarks[source[1]];
    if (!a || !b) return { x: 0, y: 0, c: 0 };
    const ca = confidenceOf(a);
    const cb = confidenceOf(b);
    return {
      x: ((a.x + b.x) / 2) * width,
      y: ((a.y + b.y) / 2) * height,
      c: Math.min(ca, cb)
    };
  }
  const lm = landmarks[source];
  if (!lm) return { x: 0, y: 0, c: 0 };
  return { x: lm.x * width, y: lm.y * height, c: confidenceOf(lm) };
}

function confidenceOf(landmark: Landmark): number {
  const v = landmark.visibility ?? landmark.presence;
  if (v === undefined) return 0.9;
  return clamp01(v);
}

/** Flatten BODY_25 keypoints into the OpenPose [x,y,c,...] array (75 numbers). */
export function keypointsToFlatArray(keypoints: OpenPoseKeypoint[]): number[] {
  const flat: number[] = [];
  for (const kp of keypoints) {
    flat.push(round2(kp.x), round2(kp.y), round4(kp.c));
  }
  return flat;
}

/** Extract the people (poses) for a frame, falling back to the primary landmarks. */
function framePeople(frame: PoseFrame | undefined): PosePersonFrame[] {
  if (!frame) return [];
  if (frame.poses?.length) return frame.poses;
  if (frame.landmarks?.length) {
    return [{ id: 0, landmarks: frame.landmarks, worldLandmarks: frame.worldLandmarks, score: frame.score }];
  }
  return [];
}

/**
 * Build the per-frame OpenPose JSON for the whole clip, in pixel coordinates of
 * the reference resolution. Returns one object per frame.
 */
export function buildOpenPoseJson(poseData: PoseData, width: number, height: number): OpenPoseFrameJson[] {
  return poseData.frames.map((frame) => {
    const people = framePeople(frame).map((person, index) => ({
      person_id: [index === 0 ? -1 : index],
      pose_keypoints_2d: keypointsToFlatArray(mediaPipeToBody25(person.landmarks, width, height))
    }));
    return { version: 1.3, people };
  });
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** CPU BODY_25 pass using the source mapping/colors for the internal FFmpeg writer. */
export function renderOpenPoseRgba(frame: PoseFrame | undefined, width: number, height: number): Uint8Array {
  if (![width, height].every(n => Number.isInteger(n) && n >= 48 && n <= 384)) throw new Error("OpenPose render dimensions must be 48–384px");
  const pixels = new Uint8Array(width * height * 4);
  for (let p = 3; p < pixels.length; p += 4) pixels[p] = 255;
  const radius = Math.max(1, Math.round(Math.min(width, height) / 120));
  function circle(x: number, y: number, color: string, r = radius) {
    x = Math.max(0, Math.min(width - 1, Math.round(x))); y = Math.max(0, Math.min(height - 1, Math.round(y)));
    const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
    for (let py = Math.max(0, y - r); py <= Math.min(height - 1, y + r); py++)
      for (let px = Math.max(0, x - r); px <= Math.min(width - 1, x + r); px++) {
        if ((px - x) ** 2 + (py - y) ** 2 > r * r) continue;
        const offset = (py * width + px) * 4;
        pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2];
      }
  }
  for (const person of framePeople(frame)) {
    const points = mediaPipeToBody25(person.landmarks, width, height);
    for (let index = 0; index < body25Pairs.length; index++) {
      const [start, end] = body25Pairs[index], a = points[start], b = points[end];
      if (a.c < 0.2 || b.c < 0.2 || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      const ax = Math.max(0, Math.min(width - 1, a.x)), ay = Math.max(0, Math.min(height - 1, a.y));
      const bx = Math.max(0, Math.min(width - 1, b.x)), by = Math.max(0, Math.min(height - 1, b.y));
      const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))) || 1;
      for (let step = 0; step <= steps; step++) circle(ax + (bx - ax) * step / steps, ay + (by - ay) * step / steps, body25Colors[start % body25Colors.length]!);
    }
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (point.c >= 0.2 && [point.x, point.y].every(Number.isFinite)) circle(point.x, point.y, body25Colors[index]!, radius + 1);
    }
  }
  return pixels;
}
