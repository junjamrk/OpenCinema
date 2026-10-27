import { z } from "zod";
import { observeMediaError } from "@toonflow/node-shared/mediaError";

export const maximumReferenceBytes = 256 * 1024 ** 2;
export const referenceKind = z.enum(["rgb", "pose", "depth"]);
export const referenceSettings = z.strictObject({ mode: z.enum(["ghost", "pip"]), opacity: z.number().finite().min(0).max(1), timeOffset: z.number().finite().min(-3600).max(3600) });
export const workspaceVideoPath = z.string().min(1).max(4096).refine(path => !/[\\\u0000-\u001f:?#%]/.test(path) && !path.split("/").some(part => !part || part === "." || part === "..") && /\.(mp4|m4v|mov|webm)$/i.test(path), "须为工作区内相对 MP4/MOV/WebM 路径，不接受外链或上级目录");
export const storedReferencePath = /^reference[0-9a-f]{32}\.(mp4|webm)$/;
export const referenceMetadata = z.object({
  kind: referenceKind, mimeType: z.enum(["video/mp4", "video/webm"]), duration: z.number().finite().positive().max(3600),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  bytes: z.number().int().positive().max(maximumReferenceBytes), sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReferenceInput = { type: "input"; sourceNodeId: string; sourceHandle: string } | { type: "workspace"; path: string; kind: z.infer<typeof referenceKind> } | { type: "file"; file: File; kind: z.infer<typeof referenceKind> };
export type ReferenceChoice = { sourceNodeId: string; sourceHandle: string; path: string; kind: z.infer<typeof referenceKind> };

function validateMp4(content: ArrayBuffer) {
  const view = new DataView(content), bytes = new Uint8Array(content);
  let count = 0, references = 0;
  const readBoxes = (start: number, end: number, dataReferences = false, depth = 0) => {
    if (depth > 8) throw new Error("参考视频容器嵌套过深");
    let entries = 0;
    for (let offset = start; offset < end;) {
      if (++count > 20000 || offset + 8 > end) throw new Error("参考视频容器结构无效或过于复杂");
      let size = view.getUint32(offset), header = 8;
      if (size === 1) { if (offset + 16 > end) throw new Error("参考视频容器长度无效"); size = Number(view.getBigUint64(offset + 8)); header = 16; }
      if (size === 0) size = end - offset;
      if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error("参考视频容器长度无效");
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), payload = offset + header, next = offset + size;
      if (dataReferences) {
        if (type !== "url " || next !== payload + 4 || view.getUint32(payload) !== 1) throw new Error("参考视频包含外部媒体引用，请先在本地导出为自包含MP4");
        references++;
      } else if (type === "dref") {
        if (next < payload + 8 || view.getUint32(payload) !== 0) throw new Error("参考视频数据引用无效");
        if (readBoxes(payload + 8, next, true, depth + 1) !== view.getUint32(payload + 4)) throw new Error("参考视频数据引用数量无效");
      } else if (["moov", "trak", "mdia", "minf", "dinf"].includes(type)) readBoxes(payload, next, false, depth + 1);
      else if (["cmov", "rmra"].includes(type)) throw new Error("不支持压缩或外部引用电影，请先在本地导出为自包含MP4");
      entries++; offset = next;
    }
    return entries;
  };
  readBoxes(0, content.byteLength);
  if (!references) throw new Error("参考视频缺少自包含媒体引用，不接受外链或不完整MP4");
}

export async function inspectReference(content: ArrayBuffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!content.byteLength || content.byteLength > maximumReferenceBytes) throw new Error("参考视频须大于0且不超过256 MiB");
  const header = new Uint8Array(content, 0, Math.min(12, content.byteLength));
  const mimeType = header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3 ? "video/webm"
    : String.fromCharCode(...header.slice(4, 8)) === "ftyp" ? "video/mp4" : undefined;
  if (!mimeType) throw new Error("参考素材必须是自包含 MP4/MOV 或 WebM 视频，不接受播放列表、图片或外链");
  if (mimeType === "video/mp4") validateMp4(content);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), byte => byte.toString(16).padStart(2, "0")).join("");
  signal?.throwIfAborted();
  const metadata = await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const video = document.createElement("video"), url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const mediaFailure = observeMediaError(video);
    let settled = false;
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); signal?.removeEventListener("abort", aborted);
      const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      mediaFailure.dispose(); video.onloadedmetadata = null; video.onloadeddata = null; video.onerror = null; video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
      if (failure) reject(new Error(`${failure.message}（${content.byteLength} bytes，SHA256 ${sha256}）`, { cause: failure })); else resolve(metadata);
    };
    const aborted = () => finish(new Error("参考视频读取已取消"));
    const timeout = setTimeout(() => finish(new Error(mediaFailure.describe("参考视频解码超时，旧参考保留"))), 15000);
    video.muted = true; video.preload = "auto"; video.onloadeddata = () => finish();
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 3600 || !video.videoWidth || !video.videoHeight || video.videoWidth > 8192 || video.videoHeight > 8192 || video.videoWidth * video.videoHeight > 33554432) finish(new Error("参考视频须不超过1小时、单边8192像素且总像素不超过33554432"));
    };
    video.onerror = () => finish(new Error(mediaFailure.describe("参考视频加载失败，旧参考保留")));
    signal?.addEventListener("abort", aborted, { once: true }); video.src = url;
    if (signal?.aborted) aborted();
  });
  signal?.throwIfAborted();
  return referenceMetadata.omit({ kind: true }).parse({ ...metadata, mimeType, bytes: content.byteLength, sha256 });
}
