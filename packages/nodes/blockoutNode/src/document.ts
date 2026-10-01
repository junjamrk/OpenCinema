import { z } from "zod";
import { ASSET_CATALOG } from "./nativeBlockout/assets";
import { parseProject, serializeProject, shotCameras } from "./nativeBlockout/schema";
import type { ProjectDoc } from "./nativeBlockout/types";
import { referenceMetadata, referenceSettings } from "./referenceVideo";
import { scanRef } from "./scanEditing";

const coordinate = z.number().finite().min(-100000).max(100000);
const vector = z.object({ x: coordinate, y: coordinate, z: coordinate });
const mark = z.looseObject({
  id: z.string().min(1), time: z.number().min(0).max(300), hold: z.number().min(0).max(300),
  easeIn: z.number().min(0).max(1), easeOut: z.number().min(0).max(1), position: vector,
  via: z.array(vector).max(100).optional(),
});
const actorMark = mark.extend({ gait: z.enum(["stand", "walk", "jog", "run", "sit", "lie", "crouch", "gesture", "fall"]), arriveHeading: coordinate.optional().describe("到达朝向，单位弧度，0朝−Z。wheeled素材一段路径的首尾标记都显式填写时，车头按两端角度插值，可与移动方向分离用于漂移；否则跟随路径。显式lookAt/附着关系仍优先。"), joints: z.record(z.string(), coordinate).optional(), attachTo: z.string().min(1).optional(), lookAtEntityId: z.string().min(1).optional() });
export const cameraNameSchema = z.string().min(1).max(80).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "机位名称不能含首尾空白或控制字符");
const camera = z.looseObject({
  sensorId: z.enum(["super16", "super35", "fullFrame", "imax65"]),
  rig: z.enum(["sticks", "dolly", "steadicam", "handheld", "crane", "drone", "carMount"]),
  rigIntensity: z.number().min(0).max(1), seed: z.number().int().min(0).max(4294967295),
  trackEntityId: z.string().min(1).optional(),
  focusMarks: z.array(z.looseObject({ id: z.string().min(1), time: z.number().finite().min(0).max(300), entityId: z.string().min(1).nullable(), transition: z.number().finite().min(0).max(10) })).max(2000).optional(),
  mountEntityId: z.string().min(1).optional(),
  marks: z.array(mark.extend({ pan: coordinate, tilt: coordinate, roll: coordinate, focalLength: z.number().min(1).max(1000), focusDistance: z.number().positive().optional() })).max(2000),
});
const shot = z.looseObject({
  id: z.string().min(1), name: z.string(), duration: z.number().min(0.2).max(300), fps: z.number().int().min(1).max(60),
  aspect: z.enum(["16:9", "9:16", "2.39:1", "4:3", "1:1"]), blockingTakeId: z.string().min(1), camera,
  cameraName: cameraNameSchema.optional(), cameraBank: z.array(z.looseObject({ name: cameraNameSchema, camera })).max(25).optional(),
  cameraEntryFields: z.record(z.string(), z.json()).refine(value => !("name" in value) && !("camera" in value), "活动机位附加字段不能覆盖名称或摄影机").optional(),
  referenceVideo: z.looseObject({ path: z.string().min(1).max(4096), ...referenceSettings.shape, ...referenceMetadata.partial().shape }).optional(),
  notes: z.string().optional(), draftOf: z.string().min(1).optional(),
});
const project = z.looseObject({
  version: z.literal(1), id: z.string().min(1), name: z.string(), settings: z.looseObject({ defaultProfileId: z.string() }),
  scenes: z.array(z.looseObject({
    id: z.string().min(1), name: z.string(), number: z.number().int(),
    environment: z.looseObject({ lighting: z.string(), sunAzimuth: coordinate, sunElevation: coordinate, fog: z.number().min(0).max(1) }),
    scans: z.array(scanRef).refine(scans => scans.filter(scan => scan.metadata).length <= 16, "每场景最多16项节点自有扫描；旧未迁移引用保留").optional(),
    entities: z.array(z.looseObject({
      id: z.string().min(1), name: z.string(), assetId: z.string().refine(id => ASSET_CATALOG.some(asset => asset.id === id) || /^custom\.[a-zA-Z0-9]+$/.test(id), "暂不支持的 Blockout 素材"),
      sourceFile: z.string().regex(/^model[0-9a-f]{32}\.glb$/).optional(),
      excludeFromExport: z.boolean().optional(),
      transform: z.object({ position: vector, rotationY: coordinate, scale: z.number().positive().max(1000) }),
      params: z.record(z.string(), z.union([coordinate, z.string()])).optional(),
      label: z.object({ text: z.string(), color: z.string().regex(/^#[0-9a-f]{6}$/i) }).optional(),
      attachedTo: z.string().min(1).optional(), attachedLocal: vector.extend({ rotY: coordinate }).optional(),
    })).max(200),
    blocking: z.array(z.looseObject({ id: z.string().min(1), name: z.string(), confirmed: z.boolean().optional(), tracks: z.array(z.object({ entityId: z.string(), marks: z.array(actorMark).max(2000) })).max(200) })).min(1).max(100),
    shots: z.array(shot).min(1).max(100),
    drafts: z.array(shot).max(100).optional(),
  })).min(1).max(100),
});
export const projectSchema = project;

export function readProject(value: unknown): ProjectDoc {
  const checked = project.parse(value);
  const result = parseProject(JSON.stringify(checked));
  if (!result.doc) throw new Error(result.issues.map(issue => `${issue.path}: ${issue.message}`).join("；"));
  if (new Set(result.doc.scenes.map(scene => scene.id)).size !== result.doc.scenes.length) throw new Error("Blockout 场景 ID 重复");
  for (const scene of result.doc.scenes) {
    if (new Set(scene.scans?.map(scan => scan.id)).size !== (scene.scans?.length ?? 0)) throw new Error("Blockout 扫描 ID 重复");
    const ids = scene.entities.map(entity => entity.id);
    if (new Set(ids).size !== ids.length || ids.includes("camera")) throw new Error("Blockout 物体 ID 重复或保留");
    const shots = [...scene.shots, ...scene.drafts ?? []];
    if (new Set(scene.blocking.map(take => take.id)).size !== scene.blocking.length || new Set(shots.map(shot => shot.id)).size !== shots.length) throw new Error("Blockout 走位、主镜或备选镜头 ID 重复");
    const mainIds = new Set(scene.shots.map(shot => shot.id));
    if (scene.shots.some(shot => shot.draftOf !== undefined) || scene.drafts?.some(shot => !shot.draftOf || !mainIds.has(shot.draftOf))) throw new Error("Blockout 备选镜头必须关联同场景真实主镜，主镜不能带备选关联");
    for (const take of scene.blocking) {
      if (new Set(take.tracks.map(track => track.entityId)).size !== take.tracks.length || take.tracks.some(track => !ids.includes(track.entityId))) throw new Error("Blockout 走位轨道引用无效");
      const marks = take.tracks.flatMap(track => track.marks);
      if (new Set(marks.map(mark => mark.id)).size !== marks.length) throw new Error("Blockout 走位标记 ID 重复");
      for (const track of take.tracks) for (const mark of track.marks) {
        for (const target of [mark.attachTo, mark.lookAtEntityId]) if (target && (!ids.includes(target) || target === track.entityId)) throw new Error("Blockout 人物关系引用无效");
      }
    }
    for (const entity of scene.entities) {
      if (entity.assetId.startsWith("custom.") && !entity.sourceFile) throw new Error("Blockout 自定义模型缺少节点资源引用");
      if (!!entity.attachedTo !== !!entity.attachedLocal) throw new Error("Blockout 附着关系缺少目标或局部偏移");
      let target = entity.attachedTo;
      const chain = new Set([entity.id]);
      while (target) {
        if (!ids.includes(target) || chain.has(target) || chain.size > 4) throw new Error("Blockout 附着关系无效、成环或超过四层");
        chain.add(target); target = scene.entities.find(item => item.id === target)?.attachedTo;
      }
    }
    for (const shot of shots) {
      const cameras = shotCameras(shot);
      if (new Set(cameras.map(item => item.name.toLowerCase())).size !== cameras.length) throw new Error("Blockout 同一镜头的机位名称重复");
      for (const { camera } of cameras) {
        for (const target of [camera.trackEntityId, camera.mountEntityId]) if (target && !ids.includes(target)) throw new Error("Blockout 摄影机主体引用无效");
        if (new Set(camera.marks.map(mark => mark.id)).size !== camera.marks.length) throw new Error("Blockout 摄影机标记 ID 重复");
        const focus = [...camera.focusMarks ?? []].sort((a, b) => a.time - b.time);
        if (new Set(focus.map(mark => mark.id)).size !== focus.length) throw new Error("Blockout 摄影关注标记 ID 重复");
        for (const [index, mark] of focus.entries()) {
          if (mark.entityId && !ids.includes(mark.entityId)) throw new Error("Blockout 摄影关注主体不存在");
          if (mark.time + mark.transition > shot.duration || index > 0 && mark.time < focus[index - 1].time + Math.max(1 / shot.fps, focus[index - 1].transition)) throw new Error("Blockout 摄影关注标记超出镜头或转向时段重叠");
        }
      }
    }
  }
  return result.doc;
}

export function cloneProject(value: ProjectDoc) {
  return readProject(JSON.parse(serializeProject(value)));
}
