import MediaActions from "@toonflow/node-shared/reactMediaActionsView";
import GenerationNode from "@toonflow/node-shared/reactGenerationNode";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";
import { useRef } from "react";

export default function AudioGenerationNodeView(props: NodeViewProps) {
  const player = useRef<HTMLAudioElement | undefined>(undefined);
  return <GenerationNode {...props} mediaType="audio" onAudioReady={audio => { player.current = audio; }}><MediaActions {...props} mediaType="audio" currentTime={() => player.current?.currentTime ?? 0} /></GenerationNode>;
}
