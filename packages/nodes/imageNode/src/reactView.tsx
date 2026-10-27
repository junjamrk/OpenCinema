import MediaNode from "@toonflow/node-shared/reactMediaNode";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";
import ImageEditor from "./reactImageEditor";

export default function ImageNodeView(props: NodeViewProps) {
  return <MediaNode {...props} mediaType="image" toolbarAction={<ImageEditor {...props} toolbar />} />;
}
