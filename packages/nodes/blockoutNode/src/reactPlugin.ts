import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import BlockoutNodeView from "./reactView";
import { createBlockoutService } from "./reactService";

export default {
  apiVersion: 1,
  id: "blockoutNode",
  name: "3D Blockout",
  version: "2.0.0",
  renderer: "react",
  view: BlockoutNodeView,
  cloneData(data) {
    const { exportProgress: _exportProgress, ...copy } = data;
    return structuredClone(copy);
  },
  createData: () => ({
    label: "3D Blockout",
    handles: [
      {
        id: "in",
        type: "target",
        dataType: ["STRING", "IMAGE", "VIDEO"],
        label: "文本、图片、视频输入",
      },
      ...[
        ["video", "VIDEO"],
        ["depth", "VIDEO"],
        ["normal", "FILE"],
        ["exportManifest", "FILE"],
        ["stillPackage", "FILE"],
        ["stillPreview", "IMAGE"],
        ["contactSheet", "IMAGE"],
        ["contactPackage", "FILE"],
        ["topDown", "IMAGE"],
        ["topDownPackage", "FILE"],
        ["animatic", "VIDEO"],
        ["animaticManifest", "FILE"],
        ["scenePackage", "FILE"],
        ["sceneGlb", "FILE"],
        ["sceneCamera", "FILE"],
        ["sceneManifest", "FILE"],
        ["imageManifest", "FILE"],
      ].map(([id, dataType]) => ({ id, type: "source", dataType, label: id })),
    ],
    historyFields: ["blockoutPath", "outputs"],
  }),
  activate(context) {
    return { service: createBlockoutService(context) };
  },
} satisfies NodePluginDefinition<typeof BlockoutNodeView>;
