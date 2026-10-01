import MediaActions from "@toonflow/node-shared/reactMediaActionsView";
import GenerationNode from "@toonflow/node-shared/reactGenerationNode";
import VideoDepthAction from "@toonflow/node-video-depth/reactSourceActions";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";
import { useRef } from "react";
import ReferenceDelivery from "./referenceDelivery";

export default function VideoGenerationNodeView(props: NodeViewProps) {
  const player = useRef<HTMLVideoElement | undefined>(undefined);
  return <GenerationNode {...props} mediaType="video" cardAction={<VideoDepthAction {...props} />} onVideoReady={video => { player.current = video; }}><ReferenceDelivery {...props} /><MediaActions {...props} mediaType="video" currentTime={() => player.current?.currentTime ?? 0} /></GenerationNode>;
}
