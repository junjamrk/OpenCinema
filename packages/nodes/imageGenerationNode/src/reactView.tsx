import GenerationNode from "@toonflow/node-shared/reactGenerationNode";
import { isGenerationLocked, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import ImageEditor from "@toonflow/node-image/reactImageEditor";

export default function ImageGenerationNodeView(props: NodeViewProps) {
  const status = (props.node.data?.generation as { status?: string } | undefined)?.status;
  return <GenerationNode {...props} mediaType="image" cardAction={<ImageEditor {...props} toolbar readOnly={props.readOnly || isGenerationLocked(status)} />} />;
}
