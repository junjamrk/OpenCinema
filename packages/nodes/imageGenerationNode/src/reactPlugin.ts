import { cloneMediaNodeData } from "@toonflow/node-shared/reactNode";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { getGenerationComposerState, registerGenerationTools } from "@toonflow/node-shared/reactGeneration";
import ImageGenerationNodeView from "./reactView";
import { buildImageEditPrompt, composeInpaintResult, registerImageEditingTools } from "@toonflow/node-image/reactImageProcessing";

const plugin: NodePluginDefinition<typeof ImageGenerationNodeView> = {
  cloneData: cloneMediaNodeData,
  apiVersion: 1, id: "imageGenerationNode", name: "图片生成", version: "2.0.0", renderer: "react", view: ImageGenerationNodeView,
  composer: { label: "生成图片", placeholder: "描述画面、主体、光线或想要修改的细节…", tool: "generateImage", defaultAction: true, getState: getGenerationComposerState },
  createData: () => ({ label: "图片生成", prompt: "", model: "", handles: [
    { id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO", "AUDIO"], label: "参考输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "输出" },
  ], outputs: {} }),
  activate(context) {
    registerImageEditingTools(context);
    registerGenerationTools(context, "image", {
      prompt: buildImageEditPrompt,
      prepare(input, data) {
        const inpaint = data.inpaint as { original: string; guide: string; images?: { path: string; mimeType: string }[] } | undefined;
        if (!inpaint) return input;
        return { ...input, prompt: `对第一张原图片进行局部重绘。第二张图中红色涂抹为选区，只修改选区，保持区域外内容，返回完整图片。\n${input.prompt}`, images: [{ path: inpaint.original, mimeType: "image/png" }, { path: inpaint.guide, mimeType: "image/png" }, ...(inpaint.images ?? []), ...(input.images as object[] ?? [])] };
      },
      result: composeInpaintResult,
    });
  },
};

export default plugin;
