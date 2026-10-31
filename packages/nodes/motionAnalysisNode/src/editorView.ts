import { z } from "zod";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { editorSession } from "@toonflow/node-shared/editorSession";
import { productionPlanSchema, type ProductionPlan } from "@toonflow/node-shared/motionProduction";

// 编辑中的空标题、未选层及尚未协调的时间范围是草稿；采用时再校验正式配置。
export const motionPlanDraftSchema = z.strictObject({ ...productionPlanSchema.shape, shotTitle: z.string().max(120), layers: productionPlanSchema.shape.layers.unwrap().array().max(10) });
export const motionSettingsDraftSchema = z.strictObject({ start: z.number().finite(), end: z.number().finite(), sampleFps: z.number().finite(), pose: z.boolean().optional(), depth: z.boolean().optional() });
export const motionOutputLabels: Record<string, string> = { analysis: "分析报告", summary: "分析摘要", video: "RGB 片段", openPose: "OpenPose 数据", poseControl: "OpenPose 姿态", depth: "相对深度", exportManifest: "导出清单", cameraMotion: "Camera 二维运动", edges: "边缘", lineart: "线稿", contactSheet: "Contact sheet", frameDifferenceMask: "运动差分遮罩", normalsProxy: "亮度梯度代理", combinedReview: "三路审阅", productionPack: "生产包", shotPlan: "镜头计划" };
export function defaultProductionPlan(label = "镜头计划"): ProductionPlan {
  return { shotTitle: label.trim().slice(0, 120) || "镜头计划", description: "", cameraIntent: "", visualStyle: "", referenceMode: "fullScene", layers: ["rgb"] };
}
export function readProductionPlan(value: unknown, label?: string): ProductionPlan {
  const defaults = defaultProductionPlan(label);
  if (value == null) return defaults;
  const draft = motionPlanDraftSchema.parse(value);
  return productionPlanSchema.parse({ ...draft, shotTitle: draft.shotTitle.trim() || defaults.shotTitle, layers: draft.layers.length ? draft.layers : defaults.layers });
}

export const motionViewSchema = z.strictObject({ tab: z.enum(["analysis", "plan", "outputs", "preview"]), reportPath: z.string(), time: z.number().finite().nonnegative().describe("冻结报告区间内的相对秒数"), playing: z.boolean(), overlay: z.boolean(), sourceVisible: z.boolean(), confidence: z.number().min(0).max(1) });
export function motionView(workbench: NodeWorkbenchService) {
  return editorSession<z.output<typeof motionViewSchema>>(workbench, "motionView", { tab: "analysis", reportPath: "", time: 0, playing: false, overlay: true, sourceVisible: true, confidence: .2 });
}
