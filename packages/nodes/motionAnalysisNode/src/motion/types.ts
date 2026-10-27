/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Sam Wasserman (Wasserman Productions / Wasserman.ai).
 * Derived from Motion Previs Studio, commit 95e7d0ff1d4cc546f7eb09a74ccbd084988a19bc.
 * Modified for Toonflow: host-independent, bounded streaming frame analysis.
 * License and attribution: ../../licenses/motionLicense.txt and ../../licenses/motionNotice.txt.
 */
import type { FrameCountPolicy } from "@toonflow/node-shared/mediaSampling";

export type Landmark = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
};

export type PoseModelKey = "lite" | "full" | "heavy";

export type DepthModelKey = "proxy" | "depth-anything";

export type PoseAnalysisSettings = {
  poseModel: PoseModelKey;
  depthModel: DepthModelKey;
  detectionConfidence: number;
  trackingConfidence: number;
  smoothing: number;
  temporalWindow: number;
  maxPeople: number;
  fillGaps: boolean;
  optimizeForExport: boolean;
};

export type PosePersonFrame = {
  id: number;
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  score: number;
};

export type PoseFrame = {
  time: number;
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  score: number;
  poses?: PosePersonFrame[];
  source?: "detected" | "filled" | "missing";
  filled?: boolean;
  smoothed?: boolean;
};

export type PoseData = {
  frameCountPolicy?: FrameCountPolicy;
  fps: number;
  duration: number;
  width: number;
  height: number;
  frames: PoseFrame[];
  summary: {
    totalFrames?: number;
    detectedFrames: number;
    rawDetectedFrames?: number;
    filledFrames?: number;
    missingFrames?: number;
    lowConfidenceFrames?: number;
    maxPeopleDetected?: number;
    averageScore: number;
    motionEnergy?: number;
    settings?: PoseAnalysisSettings;
    runtimeModel?: PoseModelKey;
    runtimeDelegate?: "GPU" | "CPU";
    diagnostics?: string[];
  };
};

export type CameraMotionFrame = {
  time: number;
  frameIndex: number;
  imageMotion: {
    xPixels: number;
    yPixels: number;
    scale: number;
    rollRadians: number;
  };
  cameraMove: {
    pan: number;
    tilt: number;
    dollyZoom: number;
    roll: number;
  };
  confidence: number;
};

export type CameraMotionData = {
  frameCountPolicy?: FrameCountPolicy;
  fps: number;
  duration: number;
  width: number;
  height: number;
  frames: CameraMotionFrame[];
  summary: {
    panPixels: number;
    tiltPixels: number;
    zoomRatio: number;
    rollDegrees: number;
    averageConfidence: number;
  };
};


export type RgbaFrame = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type ReferenceModelProvenance = {
  id: "blazePoseLite" | "depthAnythingSmall" | "videoDepthAnythingSmall"; revision: string; backend: "tfjs-cpu" | "onnx-cpu" | "pytorch";
  fingerprint: string; license: "Apache-2.0"; files: { name: string; sha256: string; size: number }[];
};
export type ReferenceModelState = { available: false; reason: string } | {
  available: true; provenance: ReferenceModelProvenance; runtime: Record<string, string | number | boolean>;
};
export type ReferenceDepthData = { frameCountPolicy?: FrameCountPolicy; space: "relative"; fps: number; duration: number; width: number; height: number;
  frames: { time: number; min: number; max: number; mean: number }[] };
export type ReferenceAnalysis = {
  frameCountPolicy?: FrameCountPolicy;
  schemaVersion: 1;
  space: "image2d";
  source: { referenceId: string; contentFingerprint: string; width: number; height: number; duration: number; fps: number };
  range: { start: number; end: number };
  mapping: { sourceTimeOffset: number; clipTimeScale: 1 };
  cameraMotion: CameraMotionData;
  models: { pose: ReferenceModelState; depth: ReferenceModelState };
  pose?: PoseData;
  depth?: ReferenceDepthData;
  quality: { confidence: number; status: "review" | "good"; measuredFrames: number };
  warnings: string[];
};
