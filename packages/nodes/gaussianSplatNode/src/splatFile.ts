// 扫描文件的格式识别与结构预检。只读文件头与长度关系，不解码几何；完整解码交给渲染器。
export const splatFormats = ["ply", "splat", "ksplat", "spz"] as const;
export type SplatFormat = typeof splatFormats[number];
export const maximumSplatBytes = 100 * 1024 ** 2;
export const maximumSplatCount = 2000000;
export const splatMimeTypes: Record<SplatFormat, string> = {
  ply: "application/x-gaussian-splat-ply", splat: "application/x-gaussian-splat", ksplat: "application/x-gaussian-ksplat", spz: "application/x-gaussian-spz",
};
export const splatFileAccept = ".ply,.splat,.ksplat,.spz";

export function splatFormatOf(path: string): SplatFormat | undefined {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  return (splatFormats as readonly string[]).includes(extension ?? "") ? extension as SplatFormat : undefined;
}

function requireCount(count: number) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximumSplatCount) throw new Error(`扫描须含 1 至 ${maximumSplatCount.toLocaleString("en-US")} 个 Gaussian；超过上限请先在原工具中抽稀，这里不会自动处理`);
  return count;
}

async function spzCount(content: ArrayBuffer, signal?: AbortSignal) {
  // 只解压到文件头：魔数、版本与数量在前 16 字节；其余交给渲染器完整解码。
  const reader = new Blob([content]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const header = new Uint8Array(16);
  let size = 0;
  try {
    while (size < 16) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      header.set(result.value.subarray(0, Math.min(result.value.byteLength, 16 - size)), size);
      size += result.value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (size < 16) throw new Error("SPZ 文件不完整");
  const view = new DataView(header.buffer);
  if (view.getUint32(0, true) !== 1347635022 || ![1, 2].includes(view.getUint32(4, true))) throw new Error("仅支持 Gaussian SPZ v1/v2，文件头无效");
  return requireCount(view.getUint32(8, true));
}

export function splatCountOf(content: ArrayBuffer, format: SplatFormat): number | Promise<number> {
  if (!content.byteLength || content.byteLength > maximumSplatBytes) throw new Error("扫描文件须非空且不超过 100 MiB");
  if (format === "spz") return spzCount(content);
  if (format === "splat") {
    if (content.byteLength % 32) throw new Error("标准 SPLAT 每个 Gaussian 占 32 字节，文件长度无效");
    return requireCount(content.byteLength / 32);
  }
  if (format === "ksplat") {
    if (content.byteLength < 5120) throw new Error("KSPLAT 文件头或分段缺失");
    const view = new DataView(content), sections = view.getUint32(4, true);
    if (!sections || sections > 4096 || 4096 + sections * 1024 > content.byteLength) throw new Error("KSPLAT 分段无效");
    return requireCount(view.getUint32(12, true));
  }
  const text = new TextDecoder().decode(new Uint8Array(content, 0, Math.min(content.byteLength, 65536)));
  const end = text.indexOf("end_header");
  if (!(text.startsWith("ply\n") || text.startsWith("ply\r\n")) || end < 0) throw new Error("PLY 文件头无效或超过 64 KiB");
  const header = text.slice(0, end);
  if (!/^format binary_little_endian 1\.0\s*$/m.test(header)) throw new Error("仅支持二进制小端 Gaussian PLY，不接受 ASCII PLY 或普通点云");
  const fields = new Set([...header.matchAll(/^property \w+ (\w+)\s*$/gm)].map(match => match[1]));
  const standard = ["x", "y", "z", "scale_0", "rot_0", "opacity", "f_dc_0"].every(field => fields.has(field));
  const packed = ["packed_position", "packed_rotation", "packed_scale", "packed_color"].every(field => fields.has(field));
  if (!standard && !packed && !/^element codebook_centers \d+\s*$/m.test(header)) throw new Error("PLY 缺少 Gaussian 的尺度、旋转或颜色字段，不能把普通点云当作扫描");
  return requireCount([...header.matchAll(/^element vertex(?:_\w+)? (\d+)\s*$/gm)].reduce((sum, item) => sum + Number(item[1]), 0));
}

export async function sha256Of(content: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), value => value.toString(16).padStart(2, "0")).join("");
}

export async function inspectSplatFile(content: ArrayBuffer, format: SplatFormat, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const splatCount = await splatCountOf(content, format);
  signal?.throwIfAborted();
  const sha256 = await sha256Of(content);
  signal?.throwIfAborted();
  return { splatCount, sha256, bytes: content.byteLength };
}
