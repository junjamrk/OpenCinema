import { useEffect, useRef, useState, type Ref } from "react";
import { readVideoPoster } from "../videoPoster";
import { observeMediaError } from "../mediaError";
import NodeIcon from "./reactIcon";

export default function VideoPreview({ url, label, playerRef, controls = true, muted = false, onReady, onError }: { url: string; label: string; playerRef?: Ref<HTMLVideoElement>; controls?: boolean; muted?: boolean; onReady?(video: HTMLVideoElement): void; onError?(message: string): void }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [cover, setCover] = useState<{ source: string; poster?: { url: string; width: number; height: number }; error?: string }>();
  const [playback, setPlayback] = useState<{ source: string; played?: boolean; failed?: boolean }>();
  const poster = cover?.source === url ? cover.poster : undefined;
  const posterError = cover?.source === url ? cover.error : undefined;
  const played = playback?.source === url && playback.played;
  const failed = playback?.source === url && playback.failed;
  useEffect(() => { const video = container.current?.querySelector("video"); return () => video?.pause(); }, [url, controls]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const lifetime = new AbortController();
    if (visible && !poster) void readVideoPoster(url, lifetime.signal).then(value => { if (!lifetime.signal.aborted) setCover({ source: url, poster: value }); }).catch(error => { if (!lifetime.signal.aborted) setCover({ source: url, error: error instanceof Error ? error.message : String(error) }); });
    return () => lifetime.abort();
  }, [url, visible, poster]);
  return <span ref={container} className="nodeVideoPreview" style={{ aspectRatio: poster ? `${poster.width} / ${poster.height}` : "16 / 9" }} data-preview-state={failed ? "failed" : poster || played ? "ready" : posterError ? "posterUnavailable" : visible ? "loading" : "deferred"}>
    {controls ? <video ref={playerRef} className="nodeMedia" src={url} poster={poster?.url} controls muted={muted} playsInline preload="metadata" aria-label={label}
      onLoadedMetadata={event => { if (event.currentTarget.currentSrc !== url) return; setPlayback({ source: url }); onReady?.(event.currentTarget); }} onPlay={event => { if (event.currentTarget.currentSrc === url) setPlayback({ source: url, played: true }); }} onError={event => {
        if (event.currentTarget.currentSrc !== url) return;
        setPlayback({ source: url, failed: true }); const failure = observeMediaError(event.currentTarget); const message = failure.describe("视频无法预览"); failure.dispose(); onError?.(message);
      }} /> : poster && <img src={poster.url} alt={label} draggable={false} />}
    {!poster && !played && <span className="nodeVideoPreviewStatus" role="status"><NodeIcon name={failed ? "info" : "movie"} />{failed ? "视频暂无法预览" : posterError ? "封面暂不可用，点击播放" : visible ? "正在读取视频封面…" : "视频预览待加载"}</span>}
  </span>;
}
