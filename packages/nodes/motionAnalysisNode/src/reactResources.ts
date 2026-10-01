import poseUrl from "../resources/poseLite.task?url";
import wasmUrl from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import loaderUrl from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";

const resources = {
  poseModel: {
    url: poseUrl,
    version: "float16/1",
    mimeType: "application/octet-stream",
    license: "Apache-2.0",
    source:
      "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
  },
  visionWasm: {
    url: wasmUrl,
    version: "1.1.1",
    mimeType: "application/wasm",
    license: "Apache-2.0",
    source: "https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.1.1",
    sha256: "0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd",
  },
  visionLoader: {
    url: loaderUrl,
    version: "1.1.1",
    mimeType: "text/javascript",
    license: "Apache-2.0",
    source: "https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.1.1",
    sha256: "6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8",
  },
};
export function createMotionResources(lifetime: AbortSignal) {
  const manifest: Record<
    string,
    {
      version: string;
      mimeType: string;
      license: string;
      source: string;
      sha256: string;
      size: number;
    }
  > = {};
  return {
    manifest,
    async read(name: string, signal?: AbortSignal) {
      const resource = resources[name as keyof typeof resources];
      if (!resource) throw new Error(`Motion 资源不存在：${name}`);
      const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      const url = new URL(resource.url, window.location.href);
      // 这里只读取上方固定 import；Widget 内联为 data，安装插件转为同源 blob，字节仍核对固定 SHA。
      const embedded = url.protocol === "data:" || url.protocol === "blob:" && url.origin === window.location.origin;
      if (!embedded && url.origin !== window.location.origin) throw new Error("Motion 离线资源必须来自当前应用");
      const response = await fetch(url, { signal: combined, cache: "force-cache" });
      if (!response.ok) throw new Error(`Motion 离线资源读取失败：${name}`);
      const declared = Number(response.headers.get("Content-Length"));
      if (declared > 32 * 1024 ** 2) throw new Error("Motion 资源超过32MiB");
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 32 * 1024 ** 2)
        throw new Error("Motion 资源大小无效");
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      combined.throwIfAborted();
      if (digest !== resource.sha256) throw new Error(`Motion 离线资源校验失败：${name}`);
      const { url: _url, ...metadata } = resource;
      manifest[name] = { ...metadata, size: bytes.byteLength };
      return bytes;
    },
  };
}
