// 一个 WebGL 舞台：加载一份 Gaussian 扫描，持有一台相机，按需渲染并截帧。
// 节点视图用它做交互查看；插件服务用一个无界面实例做静帧与环绕视频渲染。两者共用同一实现。
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DropInViewer, LogLevel, SceneFormat, SceneRevealMode } from "@mkkellogg/gaussian-splats-3d";
import type { SplatFormat } from "./splatFile";

export type Vec3 = [number, number, number];
export type SplatCamera = { position: Vec3; target: Vec3; up: Vec3; fov: number };
export type SplatBounds = { min: Vec3; max: Vec3; center: Vec3; radius: number };
export type FrameOptions = { azimuthDeg?: number; elevationDeg?: number; distanceScale?: number };

export const defaultBackground = "#101315";
const sceneFormats: Record<SplatFormat, SceneFormat> = { ply: SceneFormat.Ply, splat: SceneFormat.Splat, ksplat: SceneFormat.KSplat, spz: SceneFormat.Spz };
const vec = (value: THREE.Vector3): Vec3 => [round(value.x), round(value.y), round(value.z)];
const round = (value: number) => Math.round(value * 10000) / 10000;
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** 以包围球为依据放置相机：方位角绕 +Y，仰角向上为正，distanceScale 1 刚好把包围球放进较短的画面边。 */
export function frameCamera(bounds: SplatBounds, fov: number, aspect: number, options: FrameOptions = {}): SplatCamera {
  const azimuth = THREE.MathUtils.degToRad(options.azimuthDeg ?? 35), elevation = THREE.MathUtils.degToRad(options.elevationDeg ?? 18);
  const vertical = THREE.MathUtils.degToRad(fov) / 2, horizontal = Math.atan(Math.tan(vertical) * aspect);
  const distance = bounds.radius / Math.sin(Math.min(vertical, horizontal)) * (options.distanceScale ?? 1);
  const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const center = new THREE.Vector3(...bounds.center);
  return { position: vec(center.clone().addScaledVector(direction, distance)), target: vec(center), up: [0, 1, 0], fov };
}

// 稠密扫描常带远处漂浮点；按 2%–98% 分位取包围盒，取景更稳。
function measureBounds(mesh: { getSplatCount(): number; getSplatCenter(index: number, out: THREE.Vector3, applySceneTransform?: boolean): void }): SplatBounds {
  const count = mesh.getSplatCount(), stride = Math.max(1, Math.ceil(count / 120000)), samples: number[][] = [[], [], []], point = new THREE.Vector3();
  for (let index = 0; index < count; index += stride) {
    mesh.getSplatCenter(index, point, true);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;
    samples[0]!.push(point.x); samples[1]!.push(point.y); samples[2]!.push(point.z);
  }
  if (!samples[0]!.length) throw new Error("扫描不含有限坐标");
  const pick = (values: number[], fraction: number) => values[Math.min(values.length - 1, Math.max(0, Math.floor(fraction * (values.length - 1))))]!;
  for (const axis of samples) axis.sort((a, b) => a - b);
  const min = samples.map(axis => pick(axis, 0.02)) as Vec3, max = samples.map(axis => pick(axis, 0.98)) as Vec3;
  const center = min.map((value, index) => (value + max[index]!) / 2) as Vec3;
  const radius = Math.max(0.05, Math.hypot(...max.map((value, index) => (value - min[index]!) / 2)));
  return { min: min.map(round) as Vec3, max: max.map(round) as Vec3, center: center.map(round) as Vec3, radius: round(radius) };
}

export function createSplatStage(options: { canvas?: HTMLCanvasElement; interactive?: boolean; onCameraChange?(camera: SplatCamera): void } = {}) {
  const canvas = options.canvas ?? document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(options.interactive ? Math.min(devicePixelRatio, 2) : 1);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(defaultBackground);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.02, 5000);
  camera.position.set(0, 1.2, 4);
  const target = new THREE.Vector3();
  let viewer: DropInViewer | undefined;
  let bounds: SplatBounds | undefined;
  let splatCount = 0;
  let disposed = false;
  let frames = 0;
  let loop = false;
  let idleFrames = 0;
  const controls = options.interactive ? new OrbitControls(camera, canvas) : undefined;
  if (controls) {
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true; controls.target = target;
    controls.addEventListener("change", () => wake());
    controls.addEventListener("end", () => options.onCameraChange?.(getCamera()));
  }

  function requireViewer() {
    if (disposed) throw new Error("舞台已释放");
    if (!viewer || !bounds) throw new Error("扫描尚未加载");
    return viewer;
  }
  function render() {
    if (disposed) return;
    camera.lookAt(target);
    renderer.render(scene, camera);
    frames++;
  }
  // 交互模式：有变化就连续渲染，排序空闲且画面静止后休眠，不空转 GPU。
  function wake() {
    idleFrames = 0;
    if (loop || disposed) return;
    loop = true;
    const tick = () => {
      if (disposed) { loop = false; return; }
      controls?.update();
      render();
      idleFrames = viewer?.viewer.sortRunning ? 0 : idleFrames + 1;
      if (idleFrames > 45) { loop = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function setSize(width: number, height: number) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    wake();
  }
  function getCamera(): SplatCamera {
    return { position: vec(camera.position), target: vec(target), up: vec(camera.up), fov: round(camera.fov) };
  }
  function setCamera(value: SplatCamera) {
    camera.position.set(...value.position); target.set(...value.target); camera.up.set(...value.up).normalize();
    camera.fov = value.fov; camera.updateProjectionMatrix(); camera.lookAt(target);
    controls?.update();
    wake();
  }
  async function load(content: ArrayBuffer, format: SplatFormat, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await unload();
    const url = URL.createObjectURL(new Blob([content]));
    const next = new DropInViewer({ sharedMemoryForWorkers: false, gpuAcceleratedSort: false, enableSIMDInSort: false, freeIntermediateSplatData: true, sphericalHarmonicsDegree: 2, sceneRevealMode: SceneRevealMode.Instant, logLevel: LogLevel.None });
    const handle = next.addSplatScene(url, { format: sceneFormats[format], showLoadingUI: false, progressiveLoad: false, splatAlphaRemovalThreshold: 1 });
    const abort = () => { try { handle.abort(signal?.reason); } catch { /* 已结束 */ } };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await handle.promise;
      signal?.throwIfAborted();
      if (disposed) throw new Error("舞台已释放");
      const mesh = next.viewer.splatMesh ?? next.splatMesh;
      if (!mesh) throw new Error("扫描未生成可渲染的 Gaussian 网格");
      splatCount = mesh.getSplatCount();
      bounds = measureBounds(mesh);
      viewer = next; scene.add(next);
      wake();
      return { splatCount, bounds };
    } catch (error) {
      await next.dispose().catch(() => {});
      throw error;
    } finally { signal?.removeEventListener("abort", abort); URL.revokeObjectURL(url); }
  }
  async function unload() {
    const previous = viewer; viewer = undefined; bounds = undefined; splatCount = 0;
    if (previous) { scene.remove(previous); await previous.dispose(); }
  }
  /** 排序在 Worker 中异步完成；连续渲染直到排序空闲两帧，保证截帧时的前后遮挡正确。 */
  async function settle(signal?: AbortSignal) {
    const current = requireViewer();
    let idle = 0;
    for (let step = 0; step < 240 && idle < 2; step++) {
      signal?.throwIfAborted();
      render();
      await nextFrame();
      idle = current.viewer.sortRunning ? 0 : idle + 1;
    }
    render();
  }
  async function capturePng(width: number, height: number, value: { camera?: SplatCamera; background?: string | null } = {}, signal?: AbortSignal) {
    requireViewer();
    const previousBackground = scene.background, previousSize = renderer.getSize(new THREE.Vector2()), previousRatio = renderer.getPixelRatio(), previousCamera = getCamera();
    try {
      renderer.setPixelRatio(1); renderer.setSize(width, height, false);
      camera.aspect = width / height; camera.updateProjectionMatrix();
      scene.background = value.background === null ? null : new THREE.Color(value.background ?? defaultBackground);
      if (value.camera) setCamera(value.camera);
      await settle(signal);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("PNG 编码失败");
      return blob;
    } finally {
      scene.background = previousBackground; renderer.setPixelRatio(previousRatio); renderer.setSize(previousSize.x, previousSize.y, false);
      camera.aspect = previousSize.x / Math.max(1, previousSize.y); camera.updateProjectionMatrix();
      if (value.camera) setCamera(previousCamera);
    }
  }
  function frame(value: FrameOptions = {}) {
    if (!bounds) throw new Error("扫描尚未加载");
    const next = frameCamera(bounds, camera.fov, camera.aspect, value);
    setCamera(next);
    return next;
  }
  async function dispose() {
    disposed = true;
    controls?.dispose();
    await unload();
    renderer.dispose();
    renderer.forceContextLoss();
  }
  return { canvas, load, unload, render, settle, capturePng, frame, setCamera, getCamera, setSize, dispose, getBounds: () => bounds, getSplatCount: () => splatCount, frames: () => frames };
}
export type SplatStage = ReturnType<typeof createSplatStage>;
