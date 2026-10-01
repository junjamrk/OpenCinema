import { z } from "zod";
import type { NodeWorkbenchService } from "@toonflow/nodes-scaffold/workbenchServices";
import { editorSession } from "@toonflow/node-shared/editorSession";
export const directorViewSchema = z.strictObject({ open: z.boolean(), selected: z.string(), mode: z.enum(["translate", "rotate", "scale"]), time: z.number().finite().nonnegative(), playing: z.boolean(), freeView: z.boolean(), aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]) });
export function directorView(workbench: NodeWorkbenchService) {
  return editorSession<z.output<typeof directorViewSchema>>(workbench, "directorView", { open: false, selected: "", mode: "translate", time: 0, playing: false, freeView: false, aspectRatio: "16:9" });
}
