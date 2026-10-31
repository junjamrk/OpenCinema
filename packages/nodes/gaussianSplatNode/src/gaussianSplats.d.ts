/** @file GaussianSplats3D 0.4.7 公开接口的子集；以发行源码为准。加载须等待 handle.promise 后再释放。 */
declare module "@mkkellogg/gaussian-splats-3d" {
  import { Box3, Group, Mesh, Vector3 } from "three";

  export enum SceneFormat { Splat = 0, KSplat = 1, Ply = 2, Spz = 3 }
  export enum SceneRevealMode { Default = 0, Gradual = 1, Instant = 2 }
  export enum LogLevel { None = 0, Error = 1, Warning = 2, Info = 3, Debug = 4 }

  export interface AbortablePromise<T> { promise: Promise<T>; abort(reason?: unknown): void; }

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
    enableSIMDInSort?: boolean;
    integerBasedSort?: boolean;
    dynamicScene?: boolean;
    freeIntermediateSplatData?: boolean;
    sphericalHarmonicsDegree?: 0 | 1 | 2;
    splatSortDistanceMapPrecision?: number;
    sceneRevealMode?: SceneRevealMode;
    logLevel?: LogLevel;
    antialiased?: boolean;
  }

  export interface SplatSceneOptions {
    format?: SceneFormat;
    showLoadingUI?: boolean;
    progressiveLoad?: boolean;
    splatAlphaRemovalThreshold?: number;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    onProgress?: (percentComplete: number, percentCompleteLabel: string, stage: number) => void;
  }

  export class SplatMesh extends Mesh {
    getSplatCount(): number;
    getSplatCenter(globalIndex: number, outCenter: Vector3, applySceneTransform?: boolean): void;
    computeBoundingBox(applySceneTransforms?: boolean, sceneIndex?: number): Box3;
  }

  export class Viewer {
    splatMesh: SplatMesh | null;
    sortRunning: boolean;
    splatRenderReady: boolean;
    getSplatMesh(): SplatMesh | null;
    dispose(): Promise<void>;
  }

  export class DropInViewer extends Group {
    constructor(options?: DropInViewerOptions);
    readonly viewer: Viewer;
    splatMesh: SplatMesh | null;
    addSplatScene(path: string, options?: SplatSceneOptions): AbortablePromise<void>;
    getSceneCount(): number;
    dispose(): Promise<void>;
  }
}
