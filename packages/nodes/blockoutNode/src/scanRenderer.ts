import * as THREE from "three";
import { DropInViewer, SceneFormat } from "@mkkellogg/gaussian-splats-3d";
import type { ScanRef } from "./nativeBlockout/types";

interface ScanVisual {
  identity: string;
  scan: ScanRef;
  holder: THREE.Group;
  controller: AbortController;
  viewer?: DropInViewer;
  loading: boolean;
  error: string;
  cleanup?: Promise<void>;
}

export function createScanRenderer(group: THREE.Group, readScan: (scan: ScanRef, signal?: AbortSignal) => Promise<ArrayBuffer>, report: (state: { loading: number; error: string }) => void) {
  const visuals = new Map<string, ScanVisual>();
  const cleanupErrors: unknown[] = [];
  let queue = Promise.resolve();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const active = (visual: ScanVisual) => !disposed && visuals.get(visual.scan.id) === visual;
  function notify() {
    report({ loading: [...visuals.values()].filter(visual => visual.loading).length, error: [...visuals.values()].map(visual => visual.error).filter(Boolean).concat(cleanupErrors.map(error => `扫描释放失败：${message(error)}`)).join("；") });
  }
  function enqueue(action: () => Promise<void>) {
    // ACT: serialize scan decode/build/disposal. This avoids overlapping stale
    // imports; it does not promise that 16 full-resolution scans fit GPU memory.
    queue = queue.then(action).catch(error => { cleanupErrors.push(error); notify(); });
  }
  function cleanup(visual: ScanVisual) {
    visual.holder.removeFromParent();
    visual.cleanup ??= (async () => {
      if (visual.viewer) {
        // DropInViewer owns its splat buffers, worker and callback mesh. Never
        // traverse it with the native model disposer or release before settle.
        await visual.viewer.dispose();
        visual.viewer.removeFromParent();
      }
    })();
    return visual.cleanup;
  }
  function transform(visual: ScanVisual) {
    const scan = visual.scan;
    visual.holder.position.set(scan.position.x, scan.position.y, scan.position.z);
    visual.holder.rotation.set(scan.flipped ? Math.PI : 0, scan.rotationY, 0);
    visual.holder.scale.setScalar(scan.scale);
    visual.holder.visible = scan.visible;
  }
  async function load(visual: ScanVisual) {
    if (!active(visual)) return;
    const signal = visual.controller.signal;
    let url: string | undefined;
    let loaded = false;
    try {
      signal.throwIfAborted();
      const metadata = visual.scan.metadata;
      if (!metadata) throw new Error("旧扫描缺少文件身份，请重新导入后显示");
      const format = { ply: SceneFormat.Ply, splat: SceneFormat.Splat, ksplat: SceneFormat.KSplat, spz: SceneFormat.Spz }[metadata.format];
      if (format === undefined) throw new Error("扫描格式不受支持");
      const content = await readScan(structuredClone(visual.scan), signal);
      signal.throwIfAborted();
      if (!active(visual)) return;
      if (content.byteLength !== metadata.bytes || content.byteLength > 100 * 1024 * 1024) throw new Error("扫描字节数与记录不符或超过100MiB");
      url = URL.createObjectURL(new Blob([content]));
      const viewer = visual.viewer = new DropInViewer({ sharedMemoryForWorkers: false, enableSIMDInSort: false, gpuAcceleratedSort: false, freeIntermediateSplatData: true, sphericalHarmonicsDegree: 2 });
      const handle = viewer.addSplatScene(url, { format, showLoadingUI: false, progressiveLoad: false, splatAlphaRemovalThreshold: 0 });
      const abort = () => {
        try { handle.abort(signal.reason); } catch (error) { cleanupErrors.push(error); notify(); }
      };
      signal.addEventListener("abort", abort, { once: true });
      try { await handle.promise; } finally { signal.removeEventListener("abort", abort); }
      signal.throwIfAborted();
      if (!active(visual)) return;
      visual.holder.add(viewer); transform(visual); loaded = true;
    } catch (error) {
      if (active(visual) && !signal.aborted) visual.error = `${visual.scan.name}：${message(error)}`;
    } finally {
      if (url) URL.revokeObjectURL(url);
      visual.loading = false;
      if (!loaded || !active(visual)) await cleanup(visual);
      notify();
    }
  }
  function retire(visual: ScanVisual) {
    visual.holder.removeFromParent();
    visual.controller.abort(new DOMException("扫描已移除或场景已切换", "AbortError"));
    enqueue(() => cleanup(visual));
  }
  function sync(scans: readonly ScanRef[]) {
    if (disposed) return;
    const wanted = new Map(scans.map(scan => [scan.id, scan]));
    for (const [id, visual] of visuals) {
      const scan = wanted.get(id);
      if (!scan || visual.identity !== JSON.stringify([scan.file, scan.metadata])) { visuals.delete(id); retire(visual); }
    }
    for (const scan of scans) {
      let visual = visuals.get(scan.id);
      if (!visual) {
        visual = { identity: JSON.stringify([scan.file, scan.metadata]), scan: structuredClone(scan), holder: new THREE.Group(), controller: new AbortController(), loading: true, error: "" };
        visuals.set(scan.id, visual); group.add(visual.holder); enqueue(() => load(visual!));
      } else visual.scan = structuredClone(scan);
      transform(visual);
    }
    notify();
  }
  async function waitForScans() {
    // Preflight only drains public load/build/cleanup operations. Live viewers
    // retain their render-driven sort workers and remain usable if it is denied.
    let pending: Promise<void>;
    do { pending = queue; await pending; } while (pending !== queue);
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `扫描释放未全部完成：${cleanupErrors.map(message).join("；")}`);
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    for (const visual of visuals.values()) retire(visual);
    visuals.clear();
    disposal = (async () => {
      await waitForScans();
      notify();
    })();
    return disposal;
  }
  return { sync, waitForScans, dispose };
}
