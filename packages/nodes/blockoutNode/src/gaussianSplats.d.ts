/** @file GaussianSplats3D 0.4.7 公开接口；以实际发行源码为准，加载须等待 handle.promise 后释放。 */
declare module "@mkkellogg/gaussian-splats-3d" {
  import { Group, Matrix4, Quaternion, Vector3 } from "three";

  export enum SceneFormat {
    Splat = 0,
    KSplat = 1,
    Ply = 2,
    Spz = 3,
  }

  export interface AbortablePromise<T> {
    promise: Promise<T>;
    abort(reason?: unknown): void;
  }

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
    enableSIMDInSort?: boolean;
    integerBasedSort?: boolean;
    dynamicScene?: boolean;
    freeIntermediateSplatData?: boolean;
    sphericalHarmonicsDegree?: 0 | 1 | 2;
    splatSortDistanceMapPrecision?: number;
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

  export class DropInViewer extends Group {
    constructor(options?: DropInViewerOptions);
    addSplatScene(path: string, options?: SplatSceneOptions): AbortablePromise<void>;
    removeSplatScene(index: number, showLoadingUI?: boolean): Promise<void>;
    getSceneCount(): number;
    setActiveSphericalHarmonicsDegrees(degrees: number): void;
    dispose(): Promise<void>;
  }

  export interface SplatBufferSection {
    base: number;
    storageSizeBytes: number;
    maxSplatCount: number;
    splatCount: number;
    sphericalHarmonicsDegree: number;
    bytesPerSplat: number;
    splatCountOffset: number;
    bucketsBase: number;
    dataBase: number;
    bucketCount: number;
    bucketStorageSizeBytes: number;
    bucketsStorageSizeBytes: number;
  }

  export class SplatBuffer {
    readonly bufferData: ArrayBuffer;
    readonly sections: SplatBufferSection[];
    getSplatCount(): number;
    getMaxSplatCount(): number;
    getSplatCenter(index: number, outCenter: Vector3, transform?: Matrix4): void;
    getSplatScaleAndRotation(index: number, outScale: Vector3, outRotation: Quaternion, transform?: Matrix4, scaleOverride?: Partial<Vector3>): void;
  }

  export class PlyLoader {
    static loadFromFileData(data: ArrayBuffer, minimumAlpha: number, compressionLevel: number, optimizeSplatData: boolean,
      sphericalHarmonicsDegree?: number, sectionSize?: number, sceneCenter?: Vector3, blockSize?: number, bucketSize?: number): Promise<SplatBuffer>;
  }

  export class SpzLoader {
    static loadFromFileData(data: ArrayBuffer, minimumAlpha: number, compressionLevel: number, optimizeSplatData: boolean,
      sphericalHarmonicsDegree?: number, sectionSize?: number, sceneCenter?: Vector3, blockSize?: number, bucketSize?: number): Promise<SplatBuffer>;
  }

  export class SplatLoader {
    static loadFromFileData(data: ArrayBuffer, minimumAlpha: number, compressionLevel: number, optimizeSplatData: boolean,
      sectionSize?: number, sceneCenter?: Vector3, blockSize?: number, bucketSize?: number): Promise<SplatBuffer>;
  }

  export class KSplatLoader {
    static loadFromFileData(data: ArrayBuffer): Promise<SplatBuffer>;
  }
}
