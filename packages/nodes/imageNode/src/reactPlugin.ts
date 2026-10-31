import { openCinema, version } from "../package.json";
import { registerImageEditingTools } from "./reactImageProcessing";
import { cloneMediaNodeData, registerMediaTools } from "@toonflow/node-shared/reactNode";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import ImageNodeView from "./reactView";

const plugin: NodePluginDefinition<typeof ImageNodeView> = {
  cloneData: cloneMediaNodeData,
  ...openCinema, version, apiVersion: 1, renderer: "react", view: ImageNodeView,
  activate(context) { registerMediaTools(context, "image"); registerImageEditingTools(context); },
  createData: () => ({ label: openCinema.name, handles: [
    { id: "in", type: "target", dataType: "IMAGE", label: "来源图片" },
    { id: "image", type: "source", dataType: "IMAGE", label: "输出" },
  ], outputs: {} }),
};

export default plugin;
