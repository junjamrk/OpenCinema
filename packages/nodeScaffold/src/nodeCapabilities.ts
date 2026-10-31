import { z } from "zod";

export const nodeRequirementsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), z.number().int().min(1).max(1024),
).refine(value => Object.keys(value).length <= 32, "插件要求的能力不能超过32项");
export type NodeRequirements = z.infer<typeof nodeRequirementsSchema>;

// 节点元数据的唯一声明位置是 package.json 的 openCinema 块，构建配置与内置清单生成共用此校验。
export const nodeMetadataSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/, "插件 ID 须使用小驼峰"),
  name: z.string().trim().min(1).max(256),
  order: z.number().int().nonnegative().optional(),
  scope: z.enum(["node", "workspace"]).optional(),
  icon: z.string().trim().min(1).max(64).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().min(1).max(512).optional(),
  requires: nodeRequirementsSchema.optional(),
});
