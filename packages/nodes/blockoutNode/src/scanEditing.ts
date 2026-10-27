// OpenCinema adaptation of Blockout's scene scan editing (Apache-2.0).
// Copyright 2026 Sam Wasserman (wassermanproductions.com); see ../licenses/blockoutNotice.txt.
// Source: blockout@3f2d0564fd575f70fc28e9bfaa7e94b05e3955d9, store.ts:1064–1126.
import { z } from "zod";
import { newId } from "./nativeBlockout/ids";
import type { ScanRef, Scene } from "./nativeBlockout/types";

export const scanFormats = ["ply", "splat", "ksplat", "spz"] as const;
export const scanFile = z.string().regex(/^scan[0-9a-f]{32}\.(ply|splat|ksplat|spz)$/);
export const scanMetadata = z.looseObject({
  format: z.enum(scanFormats), bytes: z.int().positive().max(100 * 1024 ** 2),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const coordinate = z.number().finite().min(-100000).max(100000);
const vector = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const scale = z.number().finite().positive().max(1000);
const id = z.string().min(1).max(200);

// ACT: legacy references keep their original file string and transform extent.
// Only metadata-bearing node-owned files can be read by the host scan resource path.
export const scanRef = z.looseObject({
  id: z.string().min(1).default(() => newId("scan")), name: z.string().default("Scan"), file: z.string().min(1),
  position: z.looseObject({ x: z.number().finite().default(0), y: z.number().finite().default(0), z: z.number().finite().default(0) }).default({ x: 0, y: 0, z: 0 }),
  rotationY: z.number().finite().default(0), scale: z.number().finite().positive().default(1),
  visible: z.boolean().default(true), flipped: z.boolean().optional(), holdout: z.boolean().optional(),
  metadata: scanMetadata.optional(),
}).refine(scan => !scan.metadata || scanFile.safeParse(scan.file).success && scan.file.endsWith(`.${scan.metadata.format}`), "扫描元信息须对应本节点 scan<id>.<format> 文件");

const editableFields = {
  name: z.string().min(1).max(200).optional(), position: vector.optional(), rotationY: coordinate.optional(),
  scale: scale.optional(), visible: z.boolean().optional(), flipped: z.boolean().optional(), holdout: z.boolean().optional(),
};
export const addScanCommand = z.strictObject({
  type: z.literal("addScan"), sceneId: id, ...editableFields,
  name: z.string().min(1).max(200), file: scanFile, metadata: scanMetadata,
}).refine(command => command.file.endsWith(`.${command.metadata.format}`), "扫描文件扩展名与格式不一致");
export const updateScanCommand = z.strictObject({ type: z.literal("updateScan"), sceneId: id, scanId: id, ...editableFields })
  .refine(command => Object.entries(command).some(([key, value]) => !["type", "sceneId", "scanId"].includes(key) && value !== undefined), "请明确至少一项扫描修改");
export const removeScanCommand = z.strictObject({ type: z.literal("removeScan"), sceneId: id, scanId: id });
const scanCommand = z.discriminatedUnion("type", [addScanCommand, updateScanCommand, removeScanCommand]);
type ScanCommand = z.infer<typeof scanCommand>;

/** File bytes and SHA are checked by the host before the complete document is published. */
export function applyScanEdit(scene: Scene, value: ScanCommand) {
  const command = scanCommand.parse(value);
  if (scene.id !== command.sceneId) throw new Error("扫描场景绑定已变化，请重新读取");
  let scanId: string;
  if (command.type === "addScan") {
    // ACT: cap only new additions; legacy scenes above 16 remain readable and removable.
    if ((scene.scans?.length ?? 0) >= 16) throw new Error("每场景最多新增至16项扫描，请先移除不再使用的引用");
    const { type, sceneId, ...fields } = command;
    const scan: ScanRef = scanRef.parse({ ...fields, id: newId("scan") });
    scene.scans ??= []; scene.scans.push(scan); scanId = scan.id;
  } else {
    const index = scene.scans?.findIndex(scan => scan.id === command.scanId) ?? -1;
    if (index < 0) throw new Error("Blockout 扫描引用不存在，请重新读取");
    scanId = command.scanId;
    if (command.type === "removeScan") scene.scans!.splice(index, 1);
    else {
      const { type, sceneId, scanId, ...patch } = command;
      const current = scene.scans![index];
      const updates = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      scene.scans![index] = scanRef.parse({ ...current, ...updates,
        ...(patch.position ? { position: { ...current.position, ...patch.position } } : {}),
      });
    }
  }
  return { scanId, affectedShotIds: [...scene.shots, ...scene.drafts ?? []].map(shot => shot.id), sceneScope: "场景共享扫描参考；不改Take，移除仅删引用并保留资产供历史恢复" };
}
