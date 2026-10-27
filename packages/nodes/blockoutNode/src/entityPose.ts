import { GAITS } from "./nativeBlockout/gaits";
import type { Entity, GaitId } from "./nativeBlockout/types";

export const personPoses = [
  { id: "stand", name: "站立" },
  { id: "sit", name: "坐姿" },
  { id: "crouch", name: "蹲伏" },
  { id: "lie", name: "躺姿" },
  { id: "gesture", name: "交谈" },
  { id: "fall", name: "倒地" },
] as const;

/** Symmetric UI ranges in degrees; persisted joint offsets remain radians. */
export const personJoints = [
  { key: "shoulderLX", name: "左臂前摆", rangeDegrees: 180 },
  { key: "shoulderRX", name: "右臂前摆", rangeDegrees: 180 },
  { key: "shoulderLZ", name: "左臂外展", rangeDegrees: 150 },
  { key: "shoulderRZ", name: "右臂外展", rangeDegrees: 150 },
  { key: "elbowL", name: "左肘", rangeDegrees: 150 },
  { key: "elbowR", name: "右肘", rangeDegrees: 150 },
  { key: "hipLX", name: "左腿", rangeDegrees: 120 },
  { key: "hipRX", name: "右腿", rangeDegrees: 120 },
  { key: "hipLZ", name: "左腿外展", rangeDegrees: 90 },
  { key: "hipRZ", name: "右腿外展", rangeDegrees: 90 },
  { key: "kneeL", name: "左膝", rangeDegrees: 150 },
  { key: "kneeR", name: "右膝", rangeDegrees: 150 },
  { key: "torsoX", name: "躯干前倾", rangeDegrees: 60 },
  { key: "torsoY", name: "躯干扭转", rangeDegrees: 80 },
  { key: "torsoZ", name: "躯干侧倾", rangeDegrees: 50 },
  { key: "headX", name: "点头", rangeDegrees: 45 },
  { key: "headY", name: "转头", rangeDegrees: 80 },
  { key: "headZ", name: "头部侧倾", rangeDegrees: 45 },
] as const;
export const personJointNames = personJoints.map(joint => joint.key);

/** The scene-level pose contribution actually consumed by native people. */
export function entityPoseBase(entity: Pick<Entity, "assetId" | "sourceFile" | "params">, hasTrack: boolean, fallbackGait: GaitId = "stand"): { gait: GaitId | undefined; joints: Record<string, number> } {
  let gait: GaitId | undefined;
  const joints: Record<string, number> = {};
  if (!entity.assetId.startsWith("person.") || entity.sourceFile) return { gait, joints };
  if (!hasTrack) {
    const pose = entity.params?.pose;
    // 旧params保留未知值；只有真实gait名参与姿态，不让旧工程因未消费的字符串失去预览。
    gait = typeof pose === "string" && Object.hasOwn(GAITS, pose) ? pose as GaitId : fallbackGait;
  }
  for (const name of personJointNames) {
    const value = entity.params?.[`joint_${name}`];
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value)) throw new Error(`Blockout 人物关节值无效：${name}`);
    if (value !== 0) joints[name] = value;
  }
  return { gait, joints };
}
