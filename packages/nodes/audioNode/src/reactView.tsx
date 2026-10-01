import { useRef } from "react";
import MediaNode from "@toonflow/node-shared/reactMediaNode";
import MediaActions from "@toonflow/node-shared/reactMediaActionsView";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";

export default function AudioNodeView(props: NodeViewProps) {
  const player = useRef<HTMLAudioElement | undefined>(undefined);
  return <MediaNode {...props} mediaType="audio" onAudioReady={audio => { player.current = audio; }}><MediaActions {...props} mediaType="audio" currentTime={() => player.current?.currentTime ?? 0} /></MediaNode>;
}
