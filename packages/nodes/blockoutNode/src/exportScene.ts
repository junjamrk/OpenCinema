// Adapted from Blockout's glTF handoff, commit 3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9.
// Copyright 2026 Sam Wasserman (wassermanproductions.com). Apache-2.0; see ../readme.md.
// OpenCinema: isolated resources, complete local TRS/morph baking, lens sidecar and bounded delivery.
import { AnimationClip, InterleavedBufferAttribute, NumberKeyframeTrack, PerspectiveCamera, QuaternionKeyframeTrack, Scene, ShaderMaterial, Texture, VectorKeyframeTrack } from "three";
import type { BufferAttribute, KeyframeTrack, Material, Mesh, Object3D, SkinnedMesh } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { zipSync } from "fflate";
import { z } from "zod";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";
import readme from "../readme.md?raw";
import { cloneProject } from "./document";
import { getShot } from "./editing";
import { disposeModel, loadModel, maximumModelBytes, readModelDocument } from "./model";
import { buildAsset, type BuiltAsset } from "./nativeBlockout/builders";
import { ASPECT_RATIOS, verticalFov } from "./nativeBlockout/camera";
import { ShotEvaluator } from "./nativeBlockout/evaluate";
import { GAITS } from "./nativeBlockout/gaits";
import { serializeProject } from "./nativeBlockout/schema";
import type { ProjectDoc } from "./nativeBlockout/types";

export const sceneExportSchema = z.strictObject({
  sceneId: z.string().min(1), shotId: z.string().min(1), start: z.number().finite().min(0).optional(), end: z.number().finite().positive().optional(), fps: z.number().int().min(1).max(60).optional(),
});
export type SceneExportInput = z.infer<typeof sceneExportSchema>;
const limits = { projectBytes: 8 * 1024 ** 2, inputBytes: 64 * 1024 ** 2, geometryBytes: 64 * 1024 ** 2, texturePixels: 16777216, textureDimension: 4096,
  nodes: 4096, sourceMeshes: 4096, sourcePrimitives: 4096, materials: 2048, animationFloats: 8000000, glbBytes: maximumModelBytes, sidecarBytes: 4 * 1024 ** 2, manifestBytes: 8 * 1024 ** 2, zipBytes: 80 * 1024 ** 2, samples: 900, duration: 30 };
const notice = "Blockout — a previs tool for AI-native filmmaking\nCopyright 2026 Sam Wasserman\nhttps://wassermanproductions.com · https://wasserman.ai\nSource: wassermanproductions/blockout@3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9; Apache-2.0.\nOpenCinema modifies export to bake local transforms/morphs on a private resource graph and retain lens samples separately.\nThis is a GLB handoff, not an OpenCinema restorable project. User-imported model licensing is not granted by this notice.\nThe accompanying readme.txt contains the original NOTICE and complete license.\n";

type BakedNode = { object: Object3D; id: string; position: Float32Array; quaternion: Float32Array; scale: Float32Array; morph?: Float32Array; morphCount: number };

async function sha256(content: ArrayBuffer | Uint8Array) {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)), value => value.toString(16).padStart(2, "0")).join("");
}

/** Reject expanding accessors before the loader allocates sparse or animation arrays. */
function modelCost(content: ArrayBuffer) {
  const document = z.object({ nodes: z.array(z.unknown()).max(limits.nodes).optional(), accessors: z.array(z.object({ count: z.number().int().nonnegative(),
    componentType: z.number().int(), type: z.string() })).max(16384).optional(),
    materials: z.array(z.unknown()).max(limits.materials).optional(),
    meshes: z.array(z.object({ primitives: z.array(z.object({ targets: z.array(z.record(z.string(), z.unknown())).optional() })).max(limits.sourcePrimitives) })).max(limits.sourceMeshes).optional() }).parse(readModelDocument(content));
  // ACT: 单源mesh/primitive展开预算；多个node实例的实际对象数仍由加载后的graph限约束，不是预分配RSS上限。
  if ((document.meshes ?? []).reduce((count, mesh) => count + mesh.primitives.length, 0) > limits.sourcePrimitives) throw new Error("源模型primitive合计超过4096，未加载模型");
  // GLTFLoader先忽略TANGENT等morph，必须在加载前拒绝；常规vertex COLOR_0不在此限制内。
  for (const mesh of document.meshes ?? []) for (const primitive of mesh.primitives) for (const target of primitive.targets ?? []) {
    if (Object.keys(target).some(name => !["POSITION", "NORMAL"].includes(name))) throw new Error("导入模型含不支持的morph目标；仅允许POSITION/NORMAL，不静默丢弃TANGENT、COLOR_0或其它形变数据");
  }
  let bytes = 0;
  for (const accessor of document.accessors ?? []) {
    const componentBytes = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[accessor.componentType];
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as Record<string, number>)[accessor.type];
    if (!componentBytes || !components) throw new Error("GLB accessor类型暂不支持，未加载模型");
    bytes += accessor.count * componentBytes * components;
    if (!Number.isSafeInteger(bytes) || bytes > limits.geometryBytes) throw new Error("模型展开的几何/原动画accessor超过64MiB，未加载");
  }
  return bytes;
}

async function inspectGraph(root: Scene, check: () => void) {
  const nodes: Object3D[] = [], buffers = new Set<ArrayBufferLike>(), materials = new Set<Material>(), textures = new Set<Texture>();
  let geometryBytes = 0, texturePixels = 0;
  root.traverse(object => { if (object !== root) nodes.push(object); });
  if (nodes.length > limits.nodes) throw new Error("GLB对象树超过4096节点，请缩小场景后导出");
  const nodeSet = new Set(nodes);
  function attribute(value: BufferAttribute | InterleavedBufferAttribute) {
    const array = value instanceof InterleavedBufferAttribute ? value.data.array : value.array;
    if (buffers.has(array.buffer)) return;
    buffers.add(array.buffer); geometryBytes += array.buffer.byteLength;
    if (geometryBytes > limits.geometryBytes) throw new Error("导出几何缓冲超过64MiB");
    for (const value of array) if (!Number.isFinite(value)) throw new Error("导出几何包含非有限数，未输出GLB");
  }
  for (const [index, object] of nodes.entries()) {
    check();
    if (!object.matrixAutoUpdate || object.pivot !== null || (object as { isSprite?: boolean; isLine?: boolean; isPoints?: boolean }).isSprite
      || (object as { isLine?: boolean }).isLine || (object as { isPoints?: boolean }).isPoints) throw new Error("场景含无法完整烘焙的手工矩阵、pivot、Sprite或线/点图元，未输出GLB");
    const mesh = object as Mesh;
    if (mesh.geometry) {
      if (mesh.geometry.index) attribute(mesh.geometry.index);
      Object.values(mesh.geometry.attributes).forEach(attribute);
      if (mesh.morphTargetInfluences?.length && !Object.keys(mesh.geometry.morphAttributes).length) throw new Error("形变权重没有实际morph几何，未输出GLB");
      for (const [name, attributes] of Object.entries(mesh.geometry.morphAttributes)) {
        if (!["position", "normal"].includes(name) || attributes.length !== mesh.morphTargetInfluences?.length || !mesh.geometry.attributes[name]) throw new Error("GLTFExporter仅完整支持position/normal morph；不静默丢弃tangent或不匹配的形变数据");
        attributes.forEach(attribute);
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!material || material instanceof ShaderMaterial || !("color" in material)) throw new Error("场景含不支持的自定义shader或材质，未输出GLB");
        materials.add(material);
        if (materials.size > limits.materials) throw new Error("GLB材质超过2048项");
        for (const value of Object.values(material)) if (value instanceof Texture && !textures.has(value)) {
          textures.add(value);
          const image = value.image as { width?: number; height?: number } | undefined;
          const width = Number(image?.width), height = Number(image?.height);
          if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= limits.textureDimension)) throw new Error("GLB贴图缺少有效像素或超过4096单边，不自动缩图");
          texturePixels += width * height;
          if (texturePixels > limits.texturePixels) throw new Error("GLB贴图合计超过1600万像素，不自动缩图");
        }
      }
    }
    const instanced = object as Object3D & { instanceMatrix?: BufferAttribute; instanceColor?: BufferAttribute };
    if (instanced.instanceMatrix) attribute(instanced.instanceMatrix);
    if (instanced.instanceColor) attribute(instanced.instanceColor);
    const skinned = object as SkinnedMesh;
    if (skinned.isSkinnedMesh && (!skinned.skeleton.bones.length || skinned.skeleton.bones.some(bone => !nodeSet.has(bone))
      || skinned.skeleton.boneInverses.length !== skinned.skeleton.bones.length
      || [...skinned.bindMatrix.elements, ...skinned.skeleton.boneInverses.flatMap(matrix => matrix.elements)].some(value => !Number.isFinite(value)))) throw new Error("骨骼引用、绑定矩阵或逆矩阵无效，不能生成完整GLB");
    if (index % 32 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
  }
  return { nodes, geometryBytes, texturePixels, materialCount: materials.size };
}

export async function exportScene(options: {
  files: WorkspaceFiles; directory: string; project: ProjectDoc; revision: string; input: SceneExportInput; signal: AbortSignal;
  check: () => void; progress: (phase: string, percent: number) => void;
}) {
  const { files, directory, revision, signal, progress } = options;
  const check = () => { signal.throwIfAborted(); options.check(); };
  check();
  const assetDirectory = directory.slice(0, directory.lastIndexOf("/"));
  if (!/^assets\/[^/\\\u0000-\u001f]+\/sceneExport[0-9a-f]{32}$/.test(directory) || [".", ".."].includes(directory.split("/")[1]!)
    || !new RegExp(`^${assetDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/blockout[0-9a-f]{32}\\.json$`).test(revision)) throw new Error("GLB导出须使用已保存节点版本及同节点独占sceneExport目录");
  const serialized = serializeProject(options.project);
  if (new TextEncoder().encode(serialized).byteLength > limits.projectBytes) throw new Error("导出项目快照超过8MiB");
  const project = cloneProject(options.project), input = sceneExportSchema.parse(options.input);
  const { scene, shot, take } = getShot(project, input.sceneId, input.shotId);
  const start = input.start ?? 0, end = input.end ?? shot.duration, fps = input.fps ?? shot.fps, duration = end - start;
  // ACT: 所有采样点（包含真实end）计入900上限；不暗删尾点，不按视频CFR补持有帧。
  const steps = duration * fps, rounded = Math.round(steps), intervals = Math.max(1, Math.abs(steps - rounded) < 1e-9 ? rounded : Math.ceil(steps)), sampleCount = intervals + 1;
  if (duration <= 0 || duration > limits.duration || end > shot.duration || sampleCount > limits.samples) throw new Error("GLB须为镜头内最多30秒、含end不超过900采样点的正区间，请显式缩小范围或帧率");
  const times = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index++) {
    times[index] = index === sampleCount - 1 ? duration : index / fps;
    if (index > 0 && times[index]! <= times[index - 1]!) throw new Error("采样时间在glTF float32时钟中重合，请调整导出范围或帧率");
  }
  const root = new Scene(); root.name = "openCinemaScene";
  const assets = new Map<string, BuiltAsset>();
  const sourceModels: { entityId: string; path: string; bytes: number; sha256: string }[] = [];
  const camera = new PerspectiveCamera(50, ASPECT_RATIOS[shot.aspect], 0.05, 5000);
  camera.name = `openCinemaShotCamera${camera.uuid.replaceAll("-", "")}`; camera.rotation.order = "YXZ"; root.add(camera);
  let created = false;
  try {
    let inputBytes = 0, expandedInputBytes = 0;
    for (const [index, entity] of scene.entities.entries()) {
      check();
      if (entity.excludeFromExport) continue;
      progress(`正在建立独立GLB物体 ${index + 1}/${scene.entities.length}`, Math.round(index / Math.max(1, scene.entities.length) * 15));
      let built: BuiltAsset;
      if (entity.sourceFile) {
        const path = `${assetDirectory}/${entity.sourceFile}`;
        const content = await files.read(path, maximumModelBytes, signal); check();
        inputBytes += content.byteLength;
        if (inputBytes > limits.inputBytes) throw new Error("本次导入GLB实例原数据合计超过64MiB");
        expandedInputBytes += modelCost(content);
        if (expandedInputBytes > limits.geometryBytes) throw new Error("本次模型展开的几何及原动画accessor合计超过64MiB");
        const digest = await sha256(content); check();
        built = await loadModel(content);
        root.add(built.group); // 先收归私有图，再检查取消，保证迟到的加载结果也释放。
        sourceModels.push({ entityId: entity.id, path, bytes: content.byteLength, sha256: digest });
      } else { built = buildAsset(entity.assetId, entity.params); root.add(built.group); }
      assets.set(entity.id, built); check();
      built.group.scale.setScalar(entity.transform.scale); built.setTint(entity.label?.color ?? null);
      await new Promise(resolve => setTimeout(resolve, 0)); check();
    }
    const graph = await inspectGraph(root, check); check();
    const morphCounts = graph.nodes.map(node => (node as Mesh).morphTargetInfluences?.length ?? 0);
    const animationFloats = sampleCount * graph.nodes.reduce((count, _node, index) => count + 13 + (morphCounts[index] ? morphCounts[index]! + 1 : 0), 0);
    if (!Number.isSafeInteger(animationFloats) || animationFloats > limits.animationFloats) throw new Error("全对象TRS/morph及每轨时钟超过800万float预算，请缩短范围、降低fps或减少物体；不退化为仅根动画");
    const baked: BakedNode[] = graph.nodes.map((object, index) => ({ object, id: `sceneNode${index}`, position: new Float32Array(sampleCount * 3),
      quaternion: new Float32Array(sampleCount * 4), scale: new Float32Array(sampleCount * 3), morphCount: morphCounts[index]!,
      ...(morphCounts[index] ? { morph: new Float32Array(sampleCount * morphCounts[index]!) } : {}) }));
    const evaluator = new ShotEvaluator(scene, shot);
    const cameraFrames: { time: number; sourceTime: number; position: number[]; quaternion: number[]; focalLength: number; verticalFov: number; focusDistance: number | null }[] = [];
    for (let index = 0; index < sampleCount; index++) {
      check();
      const relativeTime = index === sampleCount - 1 ? duration : index / fps, sourceTime = start + relativeTime;
      const state = evaluator.evaluate(sourceTime);
      for (const entity of state.entities) {
        const built = assets.get(entity.entityId);
        if (!built) continue;
        // Evaluator已解出附着/boarding的world位姿；根直接应用，不再乘附着父实体。
        built.group.position.set(entity.position.x, entity.position.y, entity.position.z); built.group.rotation.y = entity.heading;
        const scale = scene.entities.find(item => item.id === entity.entityId)!.transform.scale;
        const stride = GAITS[entity.gait].strideLength * Math.max(scale, 0.2);
        built.animate?.({ gait: entity.gait, phase: stride ? entity.distanceTravelled / stride % 1 : 0, speed: entity.speed, distance: entity.distanceTravelled, time: sourceTime, overrides: entity.joints });
      }
      camera.position.set(state.camera.position.x, state.camera.position.y, state.camera.position.z);
      camera.rotation.set(state.camera.tilt, state.camera.pan, state.camera.roll, "YXZ");
      const vfov = verticalFov(shot.camera.sensorId, state.camera.focalLength, shot.aspect);
      camera.fov = vfov * 180 / Math.PI; camera.updateProjectionMatrix(); root.updateMatrixWorld(true);
      cameraFrames.push({ time: relativeTime, sourceTime, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), focalLength: state.camera.focalLength, verticalFov: vfov, focusDistance: state.camera.focusDistance ?? null });
      for (const node of baked) {
        const object = node.object, mesh = object as Mesh;
        const values = [...object.position.toArray(), ...object.quaternion.toArray(), ...object.scale.toArray(), ...(mesh.morphTargetInfluences ?? [])];
        if (values.some(value => !Number.isFinite(value) || Math.abs(value) > 100000000) || (mesh.morphTargetInfluences?.length ?? 0) !== node.morphCount) throw new Error("实际动画含非有限数、过大局部值或变长morph，未生成GLB");
        object.position.toArray(node.position, index * 3); object.scale.toArray(node.scale, index * 3);
        const quaternion = object.quaternion;
        const previous = index * 4 - 4;
        const sign = index && quaternion.x * node.quaternion[previous]! + quaternion.y * node.quaternion[previous + 1]! + quaternion.z * node.quaternion[previous + 2]! + quaternion.w * node.quaternion[previous + 3]! < 0 ? -1 : 1;
        node.quaternion.set([quaternion.x * sign, quaternion.y * sign, quaternion.z * sign, quaternion.w * sign], index * 4);
        if (node.morph) node.morph.set(mesh.morphTargetInfluences!, index * node.morphCount);
      }
      progress(`正在烘焙全部对象/骨骼/morph ${index + 1}/${sampleCount}`, 15 + Math.round((index + 1) / sampleCount * 60));
      if (index % 8 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); check(); }
    }
    const tracks: KeyframeTrack[] = [];
    for (const node of baked) {
      // UUID只用于实际私有tree的轨道绑定；保留原name以免破坏已求值的内嵌模型语义。
      tracks.push(new VectorKeyframeTrack(`${node.object.uuid}.position`, times, node.position), new QuaternionKeyframeTrack(`${node.object.uuid}.quaternion`, times, node.quaternion), new VectorKeyframeTrack(`${node.object.uuid}.scale`, times, node.scale));
      if (node.morph) tracks.push(new NumberKeyframeTrack(`${node.object.uuid}.morphTargetInfluences`, times, node.morph));
      node.object.position.fromArray(node.position); node.object.quaternion.fromArray(node.quaternion); node.object.scale.fromArray(node.scale);
      if (node.morph) (node.object as Mesh).morphTargetInfluences = Array.from(node.morph.subarray(0, node.morphCount));
      node.object.userData = { openCinemaNodeId: node.id };
      const mesh = node.object as Mesh;
      if (mesh.geometry) mesh.geometry.userData = {};
      for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
        material.userData = {};
        for (const value of Object.values(material)) if (value instanceof Texture) value.userData = {};
      }
    }
    camera.fov = cameraFrames[0]!.verticalFov * 180 / Math.PI; camera.updateProjectionMatrix(); root.updateMatrixWorld(true);
    const clip = new AnimationClip("openCinemaBakedShot", duration, tracks);
    progress("正在序列化自包含GLB；取消将等待序列化收尾", 78); check();
    // ACT: exporter无中止API；必须等其settle后再检查取消、释放模型，不能race后提前宣称已结束。
    const binary = await new GLTFExporter().parseAsync(root, { binary: true, trs: true, onlyVisible: false, animations: [clip], maxTextureSize: limits.textureDimension, includeCustomExtensions: false });
    check();
    if (!(binary instanceof ArrayBuffer) || !binary.byteLength || binary.byteLength > limits.glbBytes) throw new Error("导出GLB为空或超过64MiB，未发布");
    const exported = z.object({ nodes: z.array(z.object({ extras: z.object({ openCinemaNodeId: z.string() }), skin: z.number().int().nonnegative().optional() })),
      accessors: z.array(z.object({ count: z.number().int(), min: z.array(z.number()).optional(), max: z.array(z.number()).optional() })),
      skins: z.array(z.object({ joints: z.array(z.number().int().nonnegative()).min(1), skeleton: z.number().int().nonnegative(), inverseBindMatrices: z.number().int().nonnegative() })).optional(),
      animations: z.array(z.object({ samplers: z.array(z.object({ input: z.number().int(), output: z.number().int() })), channels: z.array(z.object({ sampler: z.number().int(), target: z.object({ node: z.number().int(), path: z.string() }) })) })) }).parse(readModelDocument(binary));
    const channels = exported.animations[0]?.channels, expectedChannels = baked.length * 3 + baked.filter(node => node.morph).length;
    if (exported.nodes.length !== baked.length || new Set(exported.nodes.map(node => node.extras.openCinemaNodeId)).size !== baked.length || exported.animations.length !== 1 || channels?.length !== expectedChannels) throw new Error("GLB实际节点/动画通道缺失，不能退化为根轨迹交付");
    const bakedById = new Map(baked.map(node => [node.id, node])), idByObject = new Map(baked.map(node => [node.object, node.id]));
    const skinnedNodes = baked.filter(node => (node.object as SkinnedMesh).isSkinnedMesh);
    if ((exported.skins?.length ?? 0) !== skinnedNodes.length) throw new Error("GLB实际骨骼skin数量不匹配，未发布");
    for (const node of skinnedNodes) {
      const source = node.object as SkinnedMesh, skinIndex = exported.nodes.find(item => item.extras.openCinemaNodeId === node.id)?.skin;
      const skin = skinIndex === undefined ? undefined : exported.skins?.[skinIndex];
      if (!skin || skin.joints.length !== source.skeleton.bones.length || skin.joints.some((joint, index) => exported.nodes[joint]?.extras.openCinemaNodeId !== idByObject.get(source.skeleton.bones[index]!))
        || exported.nodes[skin.skeleton]?.extras.openCinemaNodeId !== idByObject.get(source.skeleton.bones[0]!) || exported.accessors[skin.inverseBindMatrices]?.count !== source.skeleton.bones.length) throw new Error("GLB实际骨骼joint、root或逆绑定矩阵缺失，未发布");
    }
    const bindings = new Set<string>();
    for (const channel of channels) {
      const id = exported.nodes[channel.target.node]?.extras.openCinemaNodeId, node = id === undefined ? undefined : bakedById.get(id);
      const sampler = exported.animations[0]!.samplers[channel.sampler], time = sampler && exported.accessors[sampler.input], values = sampler && exported.accessors[sampler.output];
      if (!node || !["translation", "rotation", "scale", ...(node.morph ? ["weights"] : [])].includes(channel.target.path) || bindings.has(`${id}:${channel.target.path}`)
        || time?.count !== sampleCount || !Number.isFinite(time.max?.[0]) || Math.abs(time.max![0]! - duration) > 0.00001 || time.min?.[0] !== 0
        || values?.count !== sampleCount * (channel.target.path === "weights" ? node.morphCount : 1)) throw new Error("GLB实际动画绑定、采样点或终点无效，未发布");
      bindings.add(`${id}:${channel.target.path}`);
    }
    const cameraId = baked.find(node => node.object === camera)!.id, cameraNode = exported.nodes.findIndex(node => node.extras.openCinemaNodeId === cameraId);
    const cameraSidecar = { schema: "openCinema-blockout-camera-samples-v1", cameraNode, cameraNodeId: cameraId, cameraName: camera.name, sensorId: shot.camera.sensorId, aspect: shot.aspect, aspectRatio: ASPECT_RATIOS[shot.aspect], clipNear: camera.near, clipFar: camera.far,
      clock: { fps, sampleCount, duration, encodedEndTime: times[sampleCount - 1], finalSample: "evaluateExactEnd", intermediateKeys: "i/fps < duration", interpolation: "glTF LINEAR; sampled TRS/morph approximation", sourceTimeOffset: start },
      glbCamera: { positionAndQuaternionBaked: true, verticalFov: cameraFrames[0]!.verticalFov, animatedLensIncluded: false },
      requiredConsumerAction: "glTF标准不动画camera yfov/焦距/景深；导入方须按本文件真实采样自行应用，不能把GLB静态首帧焦距当作全镜头变焦。verticalFov单位弧度，focalLength为毫米，focusDistance为米或null深焦。",
      frames: cameraFrames };
    const cameraBytes = new TextEncoder().encode(JSON.stringify(cameraSidecar, null, 2));
    if (cameraBytes.byteLength > limits.sidecarBytes) throw new Error("实际摄影机采样JSON超过4MiB");
    for (const model of sourceModels) {
      const current = await files.read(model.path, maximumModelBytes, signal); check();
      if (current.byteLength !== model.bytes || await sha256(current) !== model.sha256) throw new Error("源模型在导出期间变化，原工程保留，未发布本次GLB");
      check();
    }
    await files.mkdir(directory); created = true; check();
    const entries: Record<string, Uint8Array> = {}, payloads: { path: string; mimeType: string; bytes: number; sha256: string }[] = [];
    async function add(path: string, bytes: Uint8Array, mimeType: string) {
      check(); const digest = await sha256(bytes); check();
      await files.write(`${directory}/${path}`, bytes.slice().buffer, true); check();
      entries[path] = bytes; payloads.push({ path, mimeType, bytes: bytes.byteLength, sha256: digest });
    }
    await add("scene.glb", new Uint8Array(binary), "model/gltf-binary"); await add("cameraSamples.json", cameraBytes, "application/json");
    await add("readme.txt", new TextEncoder().encode(readme), "text/plain"); await add("notice.txt", new TextEncoder().encode(notice), "text/plain");
    const manifest = { schema: "openCinema-blockout-scene-v1", createdAt: new Date().toISOString(), source: { projectId: project.id, revision: revision.split("/").at(-1), projectSha256: await sha256(new TextEncoder().encode(serializeProject(project))), sceneId: scene.id, shotId: shot.id, cameraName: shot.cameraName ?? "A", takeId: take.id, takeConfirmed: !!take.confirmed },
      clock: cameraSidecar.clock, range: { start, end }, payloads, camera: { path: "cameraSamples.json", node: cameraNode, staticGlbFov: cameraFrames[0]!.verticalFov, animatedLensIncluded: false },
      baking: { graphNodes: baked.length, trackCount: tracks.length, animationFloats, geometryBytes: graph.geometryBytes, texturePixels: graph.texturePixels, materials: graph.materialCount, inputBytes, expandedInputBytes,
        transforms: "all exported Object3D local position/quaternion/scale", morphWeights: "all existing morphTargetInfluences", attachments: "ShotEvaluator world-state on independent entity roots; no second parent transform", customModels: "loadModel first embedded clip sampled through animate; original clips are not exported", sourceModels: sourceModels.map(({ path: _path, ...model }) => model) },
      excludedEntities: scene.entities.filter(entity => entity.excludeFromExport).map(entity => ({ id: entity.id, reason: "excludeFromExport" })), limits,
      environment: { included: false, settings: structuredClone(scene.environment), reason: "天空、雾、太阳/环境光、背景、默认地面和Three曝光不作为标准glTF场景复原；仅实体内真实几何/材质/骨骼与镜头导出" },
      attribution: { name: "Blockout", author: "Sam Wasserman (wassermanproductions.com)", license: "Apache-2.0", commit: "3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9", modified: true },
      limitations: ["GLB+采样sidecar是DCC交付包，不是OpenCinema工程备份，不包含sourceFile工作区引用或原Take可编辑曲线", "全节点TRS/morph在指定fps及真实end采样，键间为glTF插值近似，不保证高速旋转或步态在采样间与原算法逐时刻一致", "camera位置/四元数可在GLB播放，变焦/景深须由接收方应用cameraSamples.json，标准GLB只有首帧投影", "材质按GLTFExporter转换到glTF PBR；Lambert等照明外观、Three阴影/后处理、材质动画与可见性动画不宣称复原", "参考Ghost/PiP、编辑辅助与未选场景/机位不进入几何；不调用Blender、模型或供应商", "每个载荷由SHA-256和bytes核对，manifest不自哈，ZIP摘要在回执；用户导入模型的许可由其权利人决定" ] };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    if (manifestBytes.byteLength > limits.manifestBytes) throw new Error("GLB来源清单超过8MiB");
    await files.write(`${directory}/manifest.json`, manifestBytes.buffer, true); check(); entries["manifest.json"] = manifestBytes;
    progress("正在封装GLB、真实摄影机采样与许可", 94);
    // ACT: 输入/几何各64MiB，贴图1600万像素，烘焙800万float；同步store ZIP仅限80MiB，不缩图、不删轨、不派生worker。
    const packed = zipSync(entries, { level: 0 });
    if (packed.byteLength > limits.zipBytes) throw new Error("GLB交付ZIP超过80MiB");
    check(); const archiveSha256 = await sha256(packed); check();
    const archivePath = `${directory}/scenePackage.zip`;
    await files.write(archivePath, packed.slice().buffer, true); check(); progress("GLB交付已完成，等待宿主一次发布", 100);
    return { directory, scenePath: `${directory}/scene.glb`, cameraPath: `${directory}/cameraSamples.json`, manifestPath: `${directory}/manifest.json`, archivePath, archiveSha256, archiveBytes: packed.byteLength, manifest };
  } catch (failure) {
    if (created) try { await files.remove(directory, true); } catch (cleanup) { throw new AggregateError([failure, cleanup], `GLB未发布且清理失败，原工程与输出保留：${directory}`); }
    throw failure;
  } finally { disposeModel(root); }
}
