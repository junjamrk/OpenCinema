import { z } from "zod";
import hostCapabilities from "./hostCapabilities.json" with { type: "json" };

// 宿主能力的唯一清单：运行时注册、构建校验、市场发布和界面文案都读这里，hostCapabilities.json 也供 site/buildMarket.mjs 直接读取。
export type HostCapability = keyof typeof hostCapabilities;
export const hostCapabilityVersions = Object.fromEntries(Object.entries(hostCapabilities).map(([name, capability]) => [name, capability.version])) as Record<HostCapability, number>;
export function capabilityLabel(name: string) {
  return (hostCapabilities as Record<string, { label: string } | undefined>)[name]?.label ?? name;
}

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
  requires: nodeRequirementsSchema.superRefine((requires, context) => {
    for (const [name, version] of Object.entries(requires)) {
      const provided = (hostCapabilityVersions as Record<string, number | undefined>)[name];
      if (provided === undefined) context.addIssue({ code: "custom", path: [name], message: `未知能力 ${name}，可用能力：${Object.keys(hostCapabilities).join("、")}` });
      else if (version > provided) context.addIssue({ code: "custom", path: [name], message: `能力 ${name} 最高版本为 ${provided}` });
    }
  }).optional(),
});
