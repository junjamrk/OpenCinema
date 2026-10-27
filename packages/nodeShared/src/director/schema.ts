import { z } from "zod";

export const mannequinJoints = [
  "hips", "spine", "neck", "head",
  "leftShoulder", "leftElbow", "leftWrist", "rightShoulder", "rightElbow", "rightWrist",
  "leftHip", "leftKnee", "leftAnkle", "rightHip", "rightKnee", "rightAnkle",
] as const;

const coordinate = z.number().min(-10000).max(10000);
const vector = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const color = z.string().regex(/^#[\da-f]{6}$/i);
// ACT: 场景只接入基础几何体和内置人偶，不接受可执行脚本、HTML 或外部资源配置。
export const sceneSchema = z.strictObject({
  version: z.literal("next"),
  sceneConfig: z.strictObject({
    scene: z.strictObject({ background: color }),
    camera: z.strictObject({ position: vector, fov: z.number().min(10).max(120), near: z.number().min(0.01).max(10), far: z.number().min(20).max(10000) }),
    controls: z.strictObject({ target: vector }),
    lights: z.array(z.strictObject({
      type: z.enum(["ambient", "directional", "point", "spot", "hemisphere"]),
      color, intensity: z.number().min(0).max(100), position: vector.optional(), target: vector.optional(),
    })).max(16),
  }),
  objectList: z.array(z.strictObject({
    threeJsonId: z.string().trim().min(1).max(100), name: z.string().max(100).optional(),
    objType: z.enum(["box", "sphere", "cylinder", "cone", "ring", "torus", "capsule", "plane", "mannequin"]),
    geometry: z.record(z.string().regex(/^[a-zA-Z]+$/), z.union([z.number().min(0).max(10000), z.boolean()]))
      .refine(value => Object.entries(value).every(([key, size]) => !/segments/i.test(key) || (typeof size === "number" && Number.isInteger(size) && size >= 1 && size <= 64)), "细分段数必须是 1～64 的整数"),
    position: vector,
    rotation: z.strictObject({ rotationX: coordinate, rotationY: coordinate, rotationZ: coordinate }).optional(),
    scale: z.strictObject({ scaleX: coordinate, scaleY: coordinate, scaleZ: coordinate }).optional(),
    pose: z.partialRecord(z.enum(mannequinJoints), vector).describe("仅 mannequin：关节相对父关节的局部 XYZ 旋转，弧度，省略为自然站姿").optional(),
    hiddenParts: z.array(z.enum(mannequinJoints)).max(mannequinJoints.length).describe("仅 mannequin：不显示指定关节及其下游部位，省略为完整人偶").optional(),
    material: z.strictObject({
      type: z.enum(["standard", "basic", "phong", "lambert"]), color,
      roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional(),
      opacity: z.number().min(0).max(1).optional(), transparent: z.boolean().optional(), wireframe: z.boolean().optional(),
    }),
  }).refine(object => object.objType === "mannequin" || (!object.pose && !object.hiddenParts), "仅人偶支持关节姿态和部位隐藏")).max(200).refine(objects => new Set(objects.map(object => object.threeJsonId)).size === objects.length, "物体 ID 不能重复"),
});
export type SceneDocument = z.infer<typeof sceneSchema>;
export const cameraViewSchema = sceneSchema.shape.sceneConfig.pick({ camera: true, controls: true });
export type CameraView = z.infer<typeof cameraViewSchema>;

export function createMannequinObject(id: string): SceneDocument["objectList"][number] {
  return {
    threeJsonId: id, name: "关节人偶", objType: "mannequin", geometry: {},
    position: { x: 0, y: 0, z: 0 },
    material: { type: "standard", color: "#c7a77b", roughness: 0.75 },
  };
}

export const anchorSchema = cameraViewSchema.extend({
  id: z.string().min(1).default(() => crypto.randomUUID()),
  time: z.number().min(0).max(300).optional(),
}).strip();
export type CameraAnchor = z.infer<typeof anchorSchema>;
export const cameraFramesSchema = z.array(z.strictObject({
  time: z.number().min(0).max(300),
  view: cameraViewSchema,
  easing: z.enum(["linear", "smooth", "cut"]),
})).min(1).max(120).refine(frames => frames.every((frame, index) => !index || frame.time > frames[index - 1]!.time), "镜头时间必须递增");
export type CameraFrames = z.infer<typeof cameraFramesSchema>;

export const directorPlanSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  duration: z.number().min(0.2).max(300),
  tracks: z.array(z.strictObject({
    objectId: z.string().trim().min(1).max(100),
    joint: z.enum(mannequinJoints).describe("仅人偶关节动画填写；不填时控制整个物体").optional(),
    frames: z.array(z.strictObject({
      time: z.number().min(0).max(300),
      position: vector.optional(),
      rotation: vector.describe("XYZ 欧拉角，单位为弧度"),
      scale: vector.optional(),
    })).min(2).max(120),
  })).max(200),
  cameraFrames: cameraFramesSchema,
}).superRefine((value, context) => {
  // 最后一个镜头保持到结束，无需重复添加结束帧；单帧表示固定镜头。
  if (value.cameraFrames[0]?.time !== 0 || value.cameraFrames.some(frame => frame.time > value.duration)) {
    context.addIssue({ code: "custom", path: ["cameraFrames"], message: "镜头时间必须从 0 开始，且不超过方案时长" });
  }
  const trackIds = new Set<string>();
  let frameCount = 0;
  value.tracks.forEach((track, index) => {
    const key = JSON.stringify([track.objectId, track.joint]);
    if (trackIds.has(key)) {
      context.addIssue({ code: "custom", path: ["tracks", index, "objectId"], message: "同一物体或关节只能有一条轨道" });
    }
    trackIds.add(key);
    if (track.joint && track.frames.some(frame => frame.position || frame.scale)) {
      context.addIssue({ code: "custom", path: ["tracks", index, "frames"], message: "关节动画仅填写 rotation，位置和缩放由骨架固定" });
    }
    frameCount += track.frames.length;
    if (track.frames[0]?.time !== 0 || track.frames.some((frame, frameIndex) => frame.time > value.duration || (frameIndex > 0 && frame.time <= track.frames[frameIndex - 1]!.time))) {
      context.addIssue({ code: "custom", path: ["tracks", index, "frames"], message: "关键帧时间必须从 0 开始、严格递增，且不超过场景时长" });
    }
  });
  if (frameCount > 2000) context.addIssue({ code: "custom", path: ["tracks"], message: "场景动画最多包含 2000 个关键帧" });
});
export type DirectorPlan = z.infer<typeof directorPlanSchema>;
export type DirectorPlanItem = DirectorPlan & { id: string; instruction?: string };
export type DirectorGeneration = { id: string; instruction: string; error?: string };

export function createEmptyScene(): SceneDocument {
  return {
    version: "next",
    sceneConfig: {
      scene: { background: "#202024" },
      camera: { position: { x: 10, y: 8, z: 12 }, fov: 55, near: 0.1, far: 1000 },
      controls: { target: { x: 0, y: 0, z: 0 } },
      lights: [
        { type: "ambient", color: "#ffffff", intensity: 0.8 },
        { type: "directional", color: "#ffffff", intensity: 2, position: { x: 10, y: 16, z: 12 } },
      ],
    },
    objectList: [],
  };
}
