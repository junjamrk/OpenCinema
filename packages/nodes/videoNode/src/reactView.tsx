import { useRef } from "react";
import MediaNode from "@toonflow/node-shared/reactMediaNode";
import MediaActions from "@toonflow/node-shared/reactMediaActionsView";
import VideoDepthAction from "@toonflow/node-video-depth/reactSourceActions";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";

export default function VideoNodeView(props: NodeViewProps) {
  const player = useRef<HTMLVideoElement | undefined>(undefined);
  return <MediaNode {...props} mediaType="video" toolbarAction={<VideoDepthAction {...props} />} onVideoReady={video => { player.current = video; }}><MediaActions {...props} mediaType="video" currentTime={() => player.current?.currentTime ?? 0} /></MediaNode>;
}
