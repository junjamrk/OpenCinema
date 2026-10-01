import { useEffect, useState } from "react";
import type { ReactNodeViewProps } from "@toonflow/nodes-scaffold/react";
import VideoPreview from "./reactVideoPreview";

export default function MediaPreview({ node, controller, mediaType }: ReactNodeViewProps & { mediaType: "image" | "video" | "audio" }) {
  const outputs = node.data?.outputs;
  const values = outputs && typeof outputs === "object" ? Object.values(outputs) : [];
  const output = values.find(item => item && typeof item === "object" && "value" in item && item.value && typeof item.value === "object"
    && "url" in item.value && "mimeType" in item.value && typeof item.value.mimeType === "string" && item.value.mimeType.startsWith(`${mediaType}/`));
  const value = output && typeof output === "object" && "value" in output ? output.value as { url: string; mimeType: string } : undefined;
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    setUrl(""); setError("");
    if (value) void controller.acquireMedia(value.url, value.mimeType).then(media => {
      if (!active) { media.release(); return; }
      release = media.release; setUrl(media.url);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; release?.(); };
  }, [controller, value?.url, value?.mimeType]);
  return <div className="nodeMediaView nodrag nowheel">
    {url && mediaType === "image" && <img className="nodeMedia" src={url} alt={String(node.data?.label ?? "图片")} draggable={false} />}
    {url && mediaType === "video" && <VideoPreview key={url} url={url} label={String(node.data?.label ?? "视频")} onError={setError} />}
    {url && mediaType === "audio" && <audio className="nodeMedia" src={url} controls preload="metadata" />}
    {error && <span role="alert">{error}</span>}
  </div>;
}
