import { z } from "zod";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { editorSession } from "@toonflow/node-shared/editorSession";
export const blockoutViewSchema = z.strictObject({ open: z.boolean(), sceneId: z.string(), shotId: z.string(), selected: z.string(), selectedIds: z.array(z.string()).max(1000), markId: z.string(), time: z.number().finite().nonnegative(), playing: z.boolean(), editScope: z.enum(["scene", "take"]), mode: z.enum(["translate", "rotate", "scale"]) });
export function blockoutView(workbench: NodeWorkbenchService) {
  return editorSession<z.output<typeof blockoutViewSchema>>(workbench, "blockoutView", { open: false, sceneId: "", shotId: "", selected: "", selectedIds: [], markId: "", time: 0, playing: false, editScope: "take", mode: "translate" });
}
