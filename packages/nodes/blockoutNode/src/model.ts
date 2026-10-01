import * as THREE from "three";
import { GLTFLoader, type GLTFParser } from "three/addons/loaders/GLTFLoader.js";
import { z } from "zod";
import type { BuiltAsset } from "./nativeBlockout/builders";
import type { V3 } from "./nativeBlockout/types";

export const maximumModelBytes = 64 * 1024 * 1024;
const maximumModelJsonBytes = 8 * 1024 * 1024;
const maximumModelResources = 256;
const modelResources = new WeakMap<THREE.Object3D, (THREE.Object3D | THREE.Material | THREE.Texture)[]>();
const compressedExtensions = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression", "KHR_texture_basisu"]);
const supportedExtensions = new Set([
  "KHR_lights_punctual", "KHR_materials_anisotropy", "KHR_materials_clearcoat", "KHR_materials_dispersion",
  "KHR_materials_emissive_strength", "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_transmission",
  "KHR_materials_iridescence", "KHR_materials_sheen", "KHR_materials_unlit", "KHR_materials_volume",
  "KHR_mesh_quantization", "KHR_texture_transform", "EXT_materials_bump", "EXT_mesh_gpu_instancing", "EXT_texture_webp",
]);
const modelDocument = z.looseObject({
  asset: z.looseObject({ version: z.literal("2.0") }),
  buffers: z.array(z.looseObject({ uri: z.string().min(1).optional(), byteLength: z.int().positive().max(maximumModelBytes) })).optional(),
  bufferViews: z.array(z.looseObject({
    buffer: z.int().nonnegative(), byteOffset: z.int().nonnegative().optional(), byteLength: z.int().positive().max(maximumModelBytes),
  })).optional(),
  images: z.array(z.looseObject({
    uri: z.string().min(1).optional(), bufferView: z.int().nonnegative().optional(), mimeType: z.string().optional(),
  }).refine(image => (image.uri !== undefined) !== (image.bufferView !== undefined), "图片须指定 URI 或 bufferView")).optional(),
  extensionsUsed: z.array(z.string()).optional(),
  extensionsRequired: z.array(z.string()).optional(),
});
type ModelDocument = z.infer<typeof modelDocument>;

function readDocument(value: unknown) {
  const doc = modelDocument.parse(value);
  if ((doc.buffers?.length ?? 0) + (doc.images?.length ?? 0) > maximumModelResources) throw new Error("模型资源不能超过 256 项");
  for (const extension of [...doc.extensionsUsed ?? [], ...doc.extensionsRequired ?? []]) {
    if (compressedExtensions.has(extension)) throw new Error("模型需要尚未配置的 Draco、Meshopt 或 KTX2 解码器，请导出未压缩模型");
    if (!supportedExtensions.has(extension)) throw new Error(`当前模型导入不支持扩展 ${extension}`);
  }
  for (const extension of doc.extensionsRequired ?? []) {
    if (!supportedExtensions.has(extension) || !doc.extensionsUsed?.includes(extension)) throw new Error(`不支持模型必需扩展 ${extension}`);
  }
  const pending: unknown[] = [doc];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (key === "extras") continue;
      if (key === "extensions" && value && typeof value === "object") {
        const unsupported = Object.keys(value).find(extension => !supportedExtensions.has(extension));
        if (unsupported) throw new Error(`当前模型导入不支持扩展 ${unsupported}`);
      }
      if (value && typeof value === "object") pending.push(value);
    }
  }
  return doc;
}

function imageMimeType(bytes: Uint8Array) {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP" && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8 === bytes.length) return "image/webp";
  throw new Error("模型贴图仅支持有效的 PNG、JPEG 或 WebP 文件");
}

function readDataUri(uri: string, image: boolean) {
  const match = /^data:(application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match || match[2].length % 4 || image !== match[1].startsWith("image/")) throw new Error("模型 data URI 须为受支持类型的完整 Base64 数据");
  const decoded = atob(match[2]);
  if (!decoded.length || decoded.length > maximumModelBytes) throw new Error("模型资源为空或超过 64 MiB");
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  if (image && imageMimeType(bytes) !== match[1]) throw new Error("模型贴图 MIME 与实际文件格式不一致");
  return bytes;
}

export function modelResourcePath(uri: string) {
  if (!uri || /^[a-z][a-z0-9+.-]*:/i.test(uri) || /^[\\/]/.test(uri) || /[\\?#\u0000-\u001f\u007f-\u009f]/.test(uri)) throw new Error("模型资源须为源文件目录内的相对路径");
  let parts: string[];
  try { parts = uri.split("/").map(part => decodeURIComponent(part)); }
  catch { throw new Error("模型资源路径编码无效"); }
  if (parts.some(part => !part || part === ".." || /[\\/:?#%\u0000-\u001f\u007f-\u009f]/.test(part))) throw new Error("模型资源路径超出源文件目录或含有非法字符");
  const path = parts.filter(part => part !== ".").join("/");
  if (!path) throw new Error("模型资源路径不能为空");
  return path;
}

function readGlb(content: ArrayBuffer) {
  if (content.byteLength < 20 || content.byteLength > maximumModelBytes) throw new Error("GLB 文件须小于 64 MiB，且包含有效的二进制头");
  const header = new DataView(content);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== content.byteLength) throw new Error("仅支持有效的 glTF 2.0 GLB 文件");
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 || jsonLength > content.byteLength - 20) throw new Error("GLB JSON 块无效");
  const doc = readDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(content, 20, jsonLength))));
  let binary: Uint8Array | undefined;
  for (let offset = 20 + jsonLength; offset < content.byteLength;) {
    if (content.byteLength - offset < 8) throw new Error("GLB 数据块头不完整");
    const length = header.getUint32(offset, true);
    if (length % 4 || length > content.byteLength - offset - 8) throw new Error("GLB 数据块长度无效");
    if (header.getUint32(offset + 4, true) === 0x004e4942) {
      if (binary) throw new Error("GLB 只能包含一个二进制块");
      binary = new Uint8Array(content, offset + 8, length);
    }
    offset += 8 + length;
  }
  return { doc, binary };
}

function validateBufferViews(doc: ModelDocument) {
  for (const view of doc.bufferViews ?? []) {
    const buffer = doc.buffers?.[view.buffer];
    if (!buffer || (view.byteOffset ?? 0) + view.byteLength > buffer.byteLength) throw new Error("模型 bufferView 超出其 buffer 边界");
  }
  for (const image of doc.images ?? []) {
    if (image.bufferView !== undefined && !doc.bufferViews?.[image.bufferView]) throw new Error("模型贴图引用了不存在的 bufferView");
  }
}

export function readModelDocument(content: ArrayBuffer) {
  const { doc, binary } = readGlb(content);
  const buffers = (doc.buffers ?? []).map((buffer, index) => {
    if (buffer.uri && !buffer.uri.startsWith("data:")) throw new Error("GLB 包含外部资源，请改为导入 glTF 及其资源目录");
    const bytes = buffer.uri ? readDataUri(buffer.uri, false) : index === 0 ? binary : undefined;
    if (!bytes || buffer.byteLength > bytes.byteLength || (!buffer.uri && bytes.byteLength - buffer.byteLength > 3)) throw new Error("模型 buffer 长度与其声明不一致");
    return bytes;
  });
  validateBufferViews(doc);
  for (const image of doc.images ?? []) {
    if (image.uri) {
      if (!image.uri.startsWith("data:")) throw new Error("GLB 包含外部贴图，请改为导入 glTF 及其资源目录");
      const bytes = readDataUri(image.uri, true);
      if (image.mimeType && image.mimeType !== imageMimeType(bytes)) throw new Error("模型贴图 MIME 与实际文件格式不一致");
      continue;
    }
    const view = doc.bufferViews![image.bufferView!];
    const bytes = buffers[view.buffer].subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    if (imageMimeType(bytes) !== image.mimeType) throw new Error("模型贴图 MIME 与实际文件格式不一致");
  }
  return doc;
}

export async function prepareModel(file: File, readResource?: (relativePath: string) => Promise<ArrayBuffer>, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  const binaryInput = /\.glb$/i.test(file.name);
  if (!binaryInput && !/\.gltf$/i.test(file.name)) throw new Error("请选择 glTF 2.0 的 .glb 或 .gltf 文件");
  if (!file.size || file.size > (binaryInput ? maximumModelBytes : maximumModelJsonBytes)) throw new Error(binaryInput ? "GLB 文件须小于 64 MiB" : "glTF JSON 文件须小于 8 MiB");
  const content = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (binaryInput) { readModelDocument(content); return content; }
  if (content.byteLength > maximumModelJsonBytes) throw new Error("glTF JSON 文件须小于 8 MiB");
  const doc = readDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
  validateBufferViews(doc);
  let resourceBytes = content.byteLength;
  async function readUri(uri: string, image: boolean) {
    signal?.throwIfAborted();
    let bytes: Uint8Array;
    if (uri.startsWith("data:")) bytes = readDataUri(uri, image);
    else {
      const path = modelResourcePath(uri);
      if (!readResource) throw new Error("此 glTF 引用了外部资源，请选择其完整资源目录");
      bytes = new Uint8Array(await readResource(path));
    }
    signal?.throwIfAborted();
    resourceBytes += bytes.byteLength;
    if (!bytes.byteLength || resourceBytes > maximumModelBytes) throw new Error("模型闭包为空或总大小超过 64 MiB");
    if (image) imageMimeType(bytes);
    return bytes;
  }
  const chunks: { bytes: Uint8Array; offset: number }[] = [];
  let binaryLength = 0;
  function append(bytes: Uint8Array) {
    const offset = binaryLength;
    binaryLength += Math.ceil(bytes.byteLength / 4) * 4;
    if (binaryLength > maximumModelBytes) throw new Error("模型二进制数据超过 64 MiB");
    chunks.push({ bytes, offset });
    return offset;
  }
  const bufferOffsets: number[] = [];
  for (const buffer of doc.buffers ?? []) {
    if (!buffer.uri) throw new Error("glTF buffer 缺少资源 URI");
    const bytes = await readUri(buffer.uri, false);
    if (bytes.byteLength < buffer.byteLength) throw new Error("模型 buffer 小于其声明长度");
    bufferOffsets.push(append(bytes.subarray(0, buffer.byteLength)));
  }
  for (const view of doc.bufferViews ?? []) {
    view.byteOffset = bufferOffsets[view.buffer] + (view.byteOffset ?? 0);
    view.buffer = 0;
  }
  for (const image of doc.images ?? []) {
    if (image.uri) {
      const bytes = await readUri(image.uri, true);
      const mimeType = imageMimeType(bytes);
      if (image.mimeType && image.mimeType !== mimeType) throw new Error("模型贴图 MIME 与实际文件格式不一致");
      doc.bufferViews ??= [];
      image.bufferView = doc.bufferViews.length;
      image.mimeType = mimeType;
      doc.bufferViews.push({ buffer: 0, byteOffset: append(bytes), byteLength: bytes.byteLength });
      delete image.uri;
    }
  }
  // ACT: 直接合并原始资源，避免 Three 导出时重建场景、动画及贴图造成信息丢失。
  const bufferMetadata = doc.buffers?.[0];
  doc.buffers = binaryLength ? [{ ...bufferMetadata, byteLength: binaryLength }] : [];
  if (doc.buffers[0]) delete doc.buffers[0].uri;
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const totalLength = 20 + jsonLength + (binaryLength ? 8 + binaryLength : 0);
  if (totalLength > maximumModelBytes) throw new Error("合并后的 GLB 超过 64 MiB");
  const result = new ArrayBuffer(totalLength);
  const header = new DataView(result);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, totalLength, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  const bytes = new Uint8Array(result);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(json, 20);
  if (binaryLength) {
    header.setUint32(20 + jsonLength, binaryLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
    for (const chunk of chunks) bytes.set(chunk.bytes, 28 + jsonLength + chunk.offset);
  }
  signal?.throwIfAborted();
  readModelDocument(result);
  return result;
}

export function disposeModel(object: THREE.Object3D, resources: Iterable<THREE.Object3D | THREE.Material | THREE.Texture> = []) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  function collect(child: THREE.Object3D) {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) materials.add(material);
  }
  const owned = [...resources];
  object.traverse(child => { collect(child); owned.push(...modelResources.get(child) ?? []); modelResources.delete(child); });
  for (const resource of owned) {
    if (resource instanceof THREE.Object3D) resource.traverse(collect);
    else if (resource instanceof THREE.Material) materials.add(resource);
    else if (resource instanceof THREE.Texture) textures.add(resource);
  }
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    const source = texture.source.data;
    if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
    texture.dispose();
  }
  geometries.forEach(geometry => geometry.dispose());
  object.clear();
}

export async function loadModel(content: ArrayBuffer): Promise<BuiltAsset & { dimensions: V3 }> {
  const doc = readModelDocument(content);
  const declaredUrls = new Set([...doc.buffers ?? [], ...doc.images ?? []].flatMap(resource => resource.uri ? [resource.uri] : []));
  const ownedUrls = new Set<string>();
  let blockedError: Error | undefined;
  let resourceError: Error | undefined;
  let activeParser: GLTFParser | undefined;
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (!declaredUrls.has(url) && !ownedUrls.has(url)) {
      blockedError = new Error("模型只允许读取已声明的内部资源");
      throw blockedError;
    }
    return url;
  });
  manager.onError = () => { resourceError = new Error("模型资源或贴图加载失败"); };
  const loader = new GLTFLoader(manager).register(parser => {
    activeParser = parser;
    return {
      name: "openCinemaInternalImages",
      async beforeRoot() {
        for (const image of parser.json.images as ModelDocument["images"] ?? []) {
          if (image.bufferView === undefined) continue;
          const bytes: ArrayBuffer = await parser.getDependency("bufferView", image.bufferView);
          const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
          ownedUrls.add(url);
          image.uri = url;
          delete image.bufferView;
        }
      },
      async afterRoot() {
        const textures = await parser.getDependencies("texture");
        if (textures.some(texture => !texture)) throw new Error("模型包含无法加载的贴图");
      },
    };
  });
  const loaded = await loader.parseAsync(content, "").then(result => {
    // GLTFLoader 会吞掉贴图失败并返回缺贴图材质，此处必须把资源错误还原为导入失败。
    if (blockedError || resourceError) throw blockedError ?? resourceError;
    return result;
  }).catch(error => {
    disposeModel(new THREE.Group(), activeParser?.associations.keys());
    throw error;
  }).finally(() => { ownedUrls.forEach(url => URL.revokeObjectURL(url)); });
  const group = new THREE.Group();
  modelResources.set(group, [...loaded.scenes, ...activeParser?.associations.keys() ?? []]);
  group.add(loaded.scene);
  const bounds = new THREE.Box3().setFromObject(group);
  const height = bounds.max.y - bounds.min.y;
  const dimensions = bounds.getSize(new THREE.Vector3());
  if (bounds.isEmpty() || ![bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z, dimensions.x, dimensions.y, dimensions.z].every(value => Number.isFinite(value) && Math.abs(value) <= 100000) || height <= 0) {
    disposeModel(group); throw new Error("模型没有可用的几何体或尺寸超出支持范围");
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const origin = new THREE.Group();
  origin.position.set(-center.x, -bounds.min.y, -center.z); origin.add(loaded.scene); group.add(origin);
  const mixer = loaded.animations.length ? new THREE.AnimationMixer(loaded.scene) : undefined;
  if (mixer) mixer.clipAction(loaded.animations[0]).play();
  const originals = new Map<THREE.Material & { color: THREE.Color }, THREE.Color>();
  group.traverse(child => {
    const mesh = child as THREE.Mesh;
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      if ("color" in material && material.color instanceof THREE.Color) originals.set(material as THREE.Material & { color: THREE.Color }, material.color.clone());
    }
  });
  return {
    group, height, dimensions: { x: dimensions.x, y: dimensions.y, z: dimensions.z },
    animate: mixer ? input => { mixer.setTime(Math.max(0, input.time)); } : undefined,
    setTint(color) { originals.forEach((original, material) => { material.color.copy(original); if (color) material.color.lerp(new THREE.Color(color), 0.45); }); },
  };
}
