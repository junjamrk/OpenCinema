import { KSplatLoader, PlyLoader, SplatLoader, SpzLoader, type SplatBuffer } from "@mkkellogg/gaussian-splats-3d";
import { Quaternion, Vector3 } from "three";
import { scanMetadata } from "./scanEditing";
import type { ScanRef } from "./nativeBlockout/types";

export const maximumScanBytes = 100 * 1024 ** 2;
export const maximumScanSplats = 2000000;
export const storedScanPath = /^scan[0-9a-f]{32}\.(ply|splat|ksplat|spz)$/;
export type ScanFormat = "ply" | "splat" | "ksplat" | "spz";

export function scanFormat(name: string): ScanFormat {
  return scanMetadata.shape.format.parse(name.split(".").at(-1)?.toLowerCase());
}

function requireCount(count: number) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > maximumScanSplats) throw new Error("扫描须含1至2000000个Gaussian；超过上限须在原工具中处理，不会自动抽稀");
  return count;
}

async function inspectSpz(content: ArrayBuffer, signal?: AbortSignal) {
  const reader = new Blob([content]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const header = new Uint8Array(16);
  let size = 0;
  const aborted = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", aborted, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      if (size < 16) header.set(result.value.subarray(0, 16 - size), size);
      size += result.value.byteLength;
      if (size > 128 * 1024 ** 2) throw new Error("SPZ解压后超过128MiB上限");
      if (size >= 16) {
        const view = new DataView(header.buffer);
        if (view.getUint32(0, true) !== 1347635022 || ![1, 2].includes(view.getUint32(4, true)) || header[12]! > 3 || header[13]! > 24) throw new Error("仅支持Gaussian SPZ v1/v2、SH0至SH3，文件头无效或版本不支持");
        requireCount(view.getUint32(8, true));
      }
    }
    signal?.throwIfAborted();
    if (size < 16) throw new Error("SPZ文件不完整");
    const view = new DataView(header.buffer), count = requireCount(view.getUint32(8, true));
    const coefficients = [0, 3, 8, 15][header[12]!]!;
    const expected = 16 + count * ((view.getUint32(4, true) === 1 ? 6 : 9) + 10 + 3 * coefficients);
    if (size !== expected) throw new Error("SPZ数据长度与Gaussian数量不一致，拒绝截断或多余数据");
    return count;
  } finally { signal?.removeEventListener("abort", aborted); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function preflightScan(content: ArrayBuffer, format: ScanFormat, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!content.byteLength || content.byteLength > maximumScanBytes) throw new Error("扫描文件须非空且不超过100MiB");
  if (format === "spz") return inspectSpz(content, signal);
  if (format === "splat") {
    if (content.byteLength % 32) throw new Error("标准SPLAT每个Gaussian须占32字节，文件长度无效");
    return requireCount(content.byteLength / 32);
  }
  if (format === "ksplat") {
    if (content.byteLength < 5120) throw new Error("KSPLAT文件头或分段缺失");
    const view = new DataView(content), sections = view.getUint32(4, true);
    if (!sections || sections > 4096 || 4096 + sections * 1024 > content.byteLength || view.getUint32(8, true) > sections || view.getUint16(20, true) > 2) throw new Error("KSPLAT分段或压缩等级无效");
    const count = requireCount(view.getUint32(12, true));
    let total = 0;
    for (let index = 0; index < sections; index++) total += view.getUint32(4096 + index * 1024 + 4, true);
    if (total !== count) throw new Error("KSPLAT分段Gaussian数量与文件头不一致");
    return count;
  }
  const text = new TextDecoder().decode(new Uint8Array(content, 0, Math.min(content.byteLength, 65536)));
  const end = text.indexOf("end_header");
  if (!text.startsWith("ply\n") && !text.startsWith("ply\r\n") || end < 0) throw new Error("PLY文件头无效或超过64KiB");
  const header = text.slice(0, end);
  if (!/^format binary_little_endian 1\.0\s*$/m.test(header)) throw new Error("仅支持Gaussian二进制小端PLY，不接受普通点云或ASCII PLY");
  const fields = new Set([...header.matchAll(/^property \w+ (\w+)\s*$/gm)].map(match => match[1]));
  const standard = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2"].every(field => fields.has(field));
  const packed = ["packed_position", "packed_rotation", "packed_scale", "packed_color"].every(field => fields.has(field));
  if (!standard && !packed && !/^element codebook_centers \d+\s*$/m.test(header)) throw new Error("PLY缺少Gaussian尺度、旋转和颜色字段，不能把普通点云当作扫描");
  const vertices = [...header.matchAll(/^element vertex(?:_\w+)? (\d+)\s*$/gm)];
  for (const element of header.matchAll(/^element \w+ (\d+)\s*$/gm)) {
    const count = Number(element[1]);
    if (!Number.isSafeInteger(count) || count > maximumScanSplats) throw new Error("PLY分段元素数量超出2000000上限");
  }
  return requireCount(vertices.reduce((sum, item) => sum + Number(item[1]), 0));
}

async function digest(content: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), value => value.toString(16).padStart(2, "0")).join("");
}

export async function inspectScan(content: ArrayBuffer, format: ScanFormat, signal?: AbortSignal) {
  const count = await preflightScan(content, format, signal);
  signal?.throwIfAborted();
  // ACT: 使用上游完整解码器，minAlpha=0、不抽稀；SH预览上限2，源文件逐字保留含全部SH。
  const parsed: SplatBuffer = format === "ply" ? await PlyLoader.loadFromFileData(content, 0, 0, true, 2)
    : format === "splat" ? await SplatLoader.loadFromFileData(content, 0, 0, false)
      : format === "spz" ? await SpzLoader.loadFromFileData(content, 0, 0, false, 2) : await KSplatLoader.loadFromFileData(content);
  signal?.throwIfAborted();
  if (requireCount(parsed.getSplatCount()) !== count) throw new Error("Gaussian解码数量与源文件头不一致");
  for (const section of parsed.sections) if (!Number.isSafeInteger(section.base + section.storageSizeBytes) || section.base < 0 || section.base + section.storageSizeBytes > parsed.bufferData.byteLength) throw new Error("Gaussian分段超出文件边界");
  const center = new Vector3(), scale = new Vector3(), rotation = new Quaternion();
  for (let index = 0; index < count; index++) {
    parsed.getSplatCenter(index, center); parsed.getSplatScaleAndRotation(index, scale, rotation);
    if (![center.x, center.y, center.z, scale.x, scale.y, scale.z, rotation.x, rotation.y, rotation.z, rotation.w].every(Number.isFinite) || scale.x < 0 || scale.y < 0 || scale.z < 0) throw new Error("扫描含非有限坐标、尺度或旋转，不发布损坏几何");
    if (index % 8192 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted(); }
  }
  const sha256 = await digest(content); signal?.throwIfAborted();
  return { metadata: scanMetadata.parse({ format, bytes: content.byteLength, sha256 }), splatCount: count };
}

export async function validateScanContent(scan: ScanRef, content: ArrayBuffer, signal?: AbortSignal) {
  if (!storedScanPath.test(scan.file) || !scan.metadata) throw new Error(`扫描“${scan.name}”为旧引用，请明确选择原文件重新导入；未读取旧路径`);
  const expected = scanMetadata.parse(scan.metadata);
  if (scanFormat(scan.file) !== expected.format || content.byteLength !== expected.bytes || await digest(content) !== expected.sha256) throw new Error(`扫描“${scan.name}”的格式、长度或SHA256与记录不一致`);
  await preflightScan(content, expected.format, signal); signal?.throwIfAborted();
}
