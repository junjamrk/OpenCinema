// Adapted from Blockout SceneManager.applyEnvironment, commit 3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9.
// Copyright 2026 Sam Wasserman (wassermanproductions.com). Apache-2.0; see ../readme.md.
// OpenCinema: instance-owned lights, sky and disposal, with legacy preset fallback (2026-10-22).
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import type { LightingPresetId, SceneEnvironment } from "./nativeBlockout/types";

type LightingPreset = { id: LightingPresetId; name: string; sky: number; sun: number; sunColor: number; ambient: number; bg: number; club: number };
export const lightingPresets: LightingPreset[] = [
  { id: "day", name: "白天", sky: 0xcfe0ef, sun: 3.2, sunColor: 0xfff4e0, ambient: 1.15, bg: 0x394048, club: 0 },
  { id: "goldenHour", name: "黄金时刻", sky: 0xf5c396, sun: 2.8, sunColor: 0xff9a3c, ambient: 0.8, bg: 0x3a2d1e, club: 0 },
  { id: "night", name: "夜晚", sky: 0x2c3e5a, sun: 0.7, sunColor: 0x7a9cc6, ambient: 0.4, bg: 0x11151c, club: 0 },
  { id: "interiorWarm", name: "暖色室内", sky: 0xffe0b3, sun: 1.6, sunColor: 0xffd9a0, ambient: 0.95, bg: 0x27231d, club: 0 },
  { id: "interiorCool", name: "冷色室内", sky: 0xd0e4f5, sun: 1.7, sunColor: 0xe8f2ff, ambient: 1, bg: 0x212528, club: 0 },
  { id: "club", name: "夜店", sky: 0x281a35, sun: 0.2, sunColor: 0x8844ff, ambient: 0.3, bg: 0x0b0810, club: 40 },
  { id: "middaySky", name: "正午天空", sky: 0xbcd6f0, sun: 3.4, sunColor: 0xfff6e8, ambient: 1.2, bg: 0x8fb4dc, club: 0 },
  { id: "goldenHourSky", name: "黄金天空", sky: 0xf0c79a, sun: 2.6, sunColor: 0xffb15a, ambient: 0.85, bg: 0xcaa070, club: 0 },
  { id: "blueHourSky", name: "蓝调天空", sky: 0x53617f, sun: 1, sunColor: 0x9fb6d8, ambient: 0.6, bg: 0x2c3550, club: 0 },
];
const skyParameters: Partial<Record<LightingPresetId, [number, number, number, number]>> = {
  middaySky: [2.2, 1.2, 0.005, 0.8], goldenHourSky: [6.5, 2.6, 0.008, 0.86], blueHourSky: [4, 3.4, 0.006, 0.9],
};
export const environmentRendering = { schema: "openCinema-blockout-environment-v1", sourceRevision: "3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9", threeRevision: THREE.REVISION, toneMapping: "ACESFilmic", exposure: 1.45 };

export function environmentPreset(lighting: string) {
  return lightingPresets.find(preset => preset.id === lighting) ?? lightingPresets[0];
}

/** Every viewport owns these GPU resources; no store, clock, download or shared scene. */
export function createEnvironment(scene: THREE.Scene) {
  const group = new THREE.Group();
  const ambient = new THREE.HemisphereLight(0xbfd4e6, 0x3a3a40, 0.7);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, far: 100 });
  sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -0.0004;
  const clubLights = [0xe5484d, 0x3b82f6, 0x46a758, 0xd6409f].map((color, index) => {
    const light = new THREE.PointLight(color, 0, 18);
    const angle = index / 4 * Math.PI * 2;
    light.position.set(Math.cos(angle) * 4, 3.4, Math.sin(angle) * 4);
    return light;
  });
  const sky = new Sky(); sky.scale.setScalar(45000); sky.visible = false;
  // ACT: Three 0.184 adds procedural clouds; keep the upstream fixed atmospheric sky without animated weather.
  sky.material.uniforms.cloudCoverage!.value = 0;
  group.add(ambient, sun, sun.target, ...clubLights, sky); scene.add(group);
  const sunDirection = new THREE.Vector3();
  return {
    group,
    update(environment: SceneEnvironment) {
      const preset = environmentPreset(environment.lighting);
      ambient.color.set(preset.sky); ambient.intensity = preset.ambient;
      sun.color.set(preset.sunColor); sun.intensity = preset.sun;
      scene.background = new THREE.Color(preset.bg);
      for (const light of clubLights) light.intensity = preset.club;
      sunDirection.set(Math.cos(environment.sunAzimuth) * Math.cos(environment.sunElevation), Math.sin(environment.sunElevation), Math.sin(environment.sunAzimuth) * Math.cos(environment.sunElevation));
      sun.position.copy(sunDirection).multiplyScalar(30); sun.target.position.set(0, 0, 0);
      const parameters = skyParameters[preset.id]; sky.visible = !!parameters;
      if (parameters) {
        const uniforms = sky.material.uniforms;
        for (const [index, name] of ["turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG"].entries()) uniforms[name]!.value = parameters[index];
        uniforms.sunPosition!.value.copy(sunDirection);
      }
      scene.fog = environment.fog > 0.01 ? new THREE.FogExp2(preset.bg, environment.fog * 0.06) : null;
    },
    dispose() {
      group.removeFromParent(); sun.dispose(); ambient.dispose();
      for (const light of clubLights) light.dispose();
      sky.geometry.dispose(); sky.material.dispose();
    },
  };
}
