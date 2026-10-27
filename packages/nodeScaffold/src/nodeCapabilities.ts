import { z } from "zod";

export const nodeRequirementsSchema = z.record(
  z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), z.number().int().min(1).max(1024),
).refine(value => Object.keys(value).length <= 32, "插件要求的能力不能超过32项");
export type NodeRequirements = z.infer<typeof nodeRequirementsSchema>;
