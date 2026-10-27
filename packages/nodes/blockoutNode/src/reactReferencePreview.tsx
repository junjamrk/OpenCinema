import { useEffect, useRef, useState } from "react";
import type { NodeViewProps } from "@toonflow/node-shared/reactNode";
import type { ReferenceVideo, Shot } from "./nativeBlockout/types";
import { ASPECT_RATIOS } from "./nativeBlockout/camera";
import { storedReferencePath } from "./referenceVideo";

export default function ReferencePreview({
  reference,
  nodeId,
  controller,
  time,
  playing,
  aspect,
}: {
  reference?: ReferenceVideo;
  nodeId: string;
  controller: NodeViewProps["controller"];
  time: number;
  playing: boolean;
  aspect: Shot["aspect"];
}) {
  const root = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const target = time + (reference?.timeOffset ?? 0),
    inRange = target >= 0 && target < (reference?.duration ?? 0);
  useEffect(() => {
    setUrl("");
    setError("");
    setReady(false);
    if (!reference || !storedReferencePath.test(reference.path)) return;
    let active = true,
      release: (() => void) | undefined;
    void controller
      .acquireMedia(`assets/${nodeId}/${reference.path}`, reference.mimeType ?? "video/mp4")
      .then((value) => {
        if (!active) {
          value.release();
          return;
        }
        release = value.release;
        setUrl(value.url);
      })
      .catch((failure) => {
        if (active) setError(failure instanceof Error ? failure.message : "参考视频读取失败");
      });
    return () => {
      active = false;
      video.current?.pause();
      release?.();
    };
  }, [controller, nodeId, reference?.path]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const value = entries[0]?.contentRect;
      if (value) setSize({ width: value.width, height: value.height });
    });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  function sync() {
    const element = video.current;
    if (!element || !url || element.readyState < 1) return;
    if (!inRange || error) {
      element.pause();
      return;
    }
    if (!element.seeking && Math.abs(element.currentTime - target) > (playing ? 0.15 : 0.02)) {
      setReady(false);
      element.currentTime = target;
    }
    if (playing && element.paused)
      void element.play().catch((failure) => {
        if (failure?.name !== "AbortError") setError("参考视频播放失败，引用已保留");
      });
    else if (!playing) element.pause();
  }
  useEffect(sync, [url, target, playing, error]);
  const width = Math.min(size.width, size.height * ASPECT_RATIOS[aspect]),
    height = width / ASPECT_RATIOS[aspect];
  const pip = reference?.mode === "pip";
  const notice = !reference
    ? ""
    : !storedReferencePath.test(reference.path)
      ? "旧参考尚未迁入本节点，请重新选择视频"
      : error ||
        (!url
          ? "正在读取参考视频…"
          : !inRange
            ? "参考视频时间范围外"
            : !ready
              ? "正在定位参考帧…"
              : "");
  return (
    <div className="blockoutReferencePreview" ref={root} aria-live="polite">
      {url && (
        <div
          className={`blockoutReferenceLayer${pip ? " pip" : ""}`}
          style={{
            width: width * (pip ? 0.36 : 1),
            height: height * (pip ? 0.36 : 1),
            left: (size.width - width) / 2 + (pip ? width * 0.64 : 0),
            top: (size.height - height) / 2 + (pip ? height * 0.64 : 0),
            opacity: ready && inRange && !error ? (reference?.opacity ?? 0.5) : 0,
          }}>
          <video
            ref={video}
            src={url}
            muted
            playsInline
            preload="auto"
            onLoadedData={() => {
              setReady(true);
              sync();
            }}
            onSeeked={() => {
              setReady(true);
              sync();
            }}
            onError={() =>
              setError(`参考读取失败，引用保留（MediaError ${video.current?.error?.code ?? 0}）`)
            }
          />
          <span>
            {reference?.kind?.toUpperCase() ?? "未标注类型"} · {pip ? "PiP" : "Ghost"}
          </span>
        </div>
      )}
      {notice && <small role="status">{notice}</small>}
    </div>
  );
}
