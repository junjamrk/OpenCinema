import { useCallback, useEffect, useRef, useState } from "react";
import NodeIcon from "@toonflow/node-shared/reactIcon";
import { errorText, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import { fileSha256 } from "./motion/depthResult";
import { readMotionPreviewReport, type MotionPreviewReport } from "./motion/reportPreview";
import { body25Colors, body25Pairs, mediaPipeToBody25 } from "./motion/openPose";
import { motionView } from "./editorView";
import { useEditorSession } from "@toonflow/node-shared/editorSession";
import type { MotionService } from "./reactService";

export default function MotionPreview({
  controller,
  nodeId,
  reportPath,
}: {
  controller: NodeViewProps["controller"];
  nodeId: string;
  reportPath?: string;
}) {
  const view = motionView(controller.getNodeService(nodeId));
  const { value: state } = useEditorSession(view);
  const field = <K extends keyof typeof state>(key: K) => (value: typeof state[K]) => view.replace({ ...view.read().value, [key]: value });
  const { time, overlay, sourceVisible, playing, confidence } = state;
  const setTime = field("time"), setOverlay = field("overlay"), setSourceVisible = field("sourceVisible"), setPlaying = field("playing"), setConfidence = field("confidence");
  const [report, setReport] = useState<MotionPreviewReport>(),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const bindVideo = useCallback((element: HTMLVideoElement | null) => { if (!element && video.current) { video.current.pause(); setPlaying(false); } video.current = element; }, [view]);
  const latest = useRef({ report, error, reportPath }); latest.current = { report, error, reportPath };
  async function applyPlayback(value: { time?: number; playing?: boolean }, signal: AbortSignal) {
    signal.throwIfAborted();
    const element = video.current, report = latest.current.report;
    if (!element || !report || element.readyState < 1) throw new Error("Motion报告播放器尚未就绪");
    if (value.time !== undefined) { element.pause(); element.currentTime = report.settings.start + value.time; setTime(value.time); }
    if (value.playing === false) element.pause();
    if (value.playing === true) {
      if (view.read().value.time >= report.settings.end - report.settings.start) { element.currentTime = report.settings.start; setTime(0); }
      const cancel = () => element.pause(); signal.addEventListener("abort", cancel, { once: true });
      try { await element.play(); signal.throwIfAborted(); }
      finally { signal.removeEventListener("abort", cancel); }
    }
    setPlaying(!element.paused);
    setError("");
  }
  const playback = useRef(applyPlayback); playback.current = applyPlayback;
  useEffect(() => {
    const service = controller.getPluginService(nodeId) as MotionService | undefined;
    return service?.bindPreview({ read() { const current = latest.current, element = video.current; return { ready: !!current.report && !!element && element.readyState >= 1 && !element.error, reportPath: current.reportPath ?? "", duration: current.report ? current.report.settings.end - current.report.settings.start : 0, sourceStart: current.report?.settings.start ?? 0, paused: element?.paused ?? true, error: current.error }; }, apply: (value, signal) => playback.current(value, signal) });
  }, [controller, nodeId]);
  useEffect(() => {
    setReport(undefined);
    setUrl("");
    setError("");
    if (view.read().value.reportPath !== (reportPath ?? "")) view.replace({ ...view.read().value, reportPath: reportPath ?? "", time: 0, playing: false });
    if (!reportPath) return;
    let active = true,
      release: (() => void) | undefined;
    const abort = new AbortController();
    void (async () => {
      if (
        !reportPath.startsWith(`assets/${nodeId}/`) ||
        reportPath.split("/").some((part) => !part || part === "." || part === "..") ||
        reportPath.includes("\\")
      )
        throw new Error("分析报告须属于当前节点");
      const files = controller.getNodeService(nodeId).files;
      const bytes = await files.read(reportPath, 16 * 1024 ** 2, abort.signal);
      const parsed = readMotionPreviewReport(JSON.parse(new TextDecoder().decode(bytes)), false);
      if (!parsed.source) throw new Error("本地分析报告缺少冻结原片");
      const source = await files.read(parsed.source.url, 256 * 1024 ** 2, abort.signal);
      if ((await fileSha256(source)) !== parsed.sourceFingerprint)
        throw new Error("原片内容与冻结报告不同，报告保留，未叠加到变更后的素材");
      abort.signal.throwIfAborted();
      const media = await controller.acquireMedia(parsed.source.url, parsed.source.mimeType);
      if (!active) {
        media.release();
        return;
      }
      release = media.release;
      setUrl(media.url);
      setReport(parsed);
    })().catch((failure) => {
      if (active) setError(errorText(failure));
    });
    return () => {
      active = false;
      abort.abort();
      video.current?.pause();
      release?.();
    };
  }, [controller, nodeId, reportPath]);
  const duration = report ? report.settings.end - report.settings.start : 0;
  const pose = report?.pose?.frames.findLast((frame) => frame.time <= time + 0.00001),
    camera = report?.camera?.frames.findLast((frame) => frame.time <= time + 0.00001);
  const width = report?.pose?.width ?? report?.camera?.width ?? 16,
    height = report?.pose?.height ?? report?.camera?.height ?? 9;
  const points = pose ? mediaPipeToBody25(pose.landmarks, width, height) : [];
  function seek(at: number) {
    if (!report || !video.current) return;
    const next = Math.max(0, Math.min(duration, at));
    void applyPlayback({ time: next, playing: false }, new AbortController().signal).catch(failure => setError(errorText(failure)));
  }
  function toggle() {
    if (!report || !video.current) return;
    void applyPlayback({ playing: video.current.paused }, new AbortController().signal).catch(failure => setError(errorText(failure)));
  }
  const series = report?.camera?.frames ?? [];
  const traces = [
    { key: "x", label: "水平运动 / px", values: series.map((frame) => frame.imageMotion.xPixels) },
    { key: "y", label: "垂直运动 / px", values: series.map((frame) => frame.imageMotion.yPixels) },
    { key: "scale", label: "缩放比", values: series.map((frame) => frame.imageMotion.scale) },
    {
      key: "roll",
      label: "画面旋转 / 度",
      values: series.map((frame) => (frame.imageMotion.rollRadians * 180) / Math.PI),
    },
  ];
  return (
    <section className="motionPreview" aria-label="冻结报告预览">
      {!reportPath && <small>分析完成后可预览原片、姿态和二维运动。</small>}
      {error && (
        <p className="motionError" role="alert">
          {error}
        </p>
      )}
      {reportPath && !report && !error && <small role="status">正在读取报告并核对原片内容…</small>}
      {report && (
        <>
          <div className="motionPreviewStage" style={{ aspectRatio: `${width}/${height}` }}>
            <video
              ref={bindVideo}
              src={url}
              muted
              playsInline
              preload="auto"
              style={{ opacity: sourceVisible ? 1 : 0 }}
              onLoadedMetadata={() => {
                if (video.current) video.current.currentTime = report.settings.start + Math.min(duration, view.read().value.time);
              }}
              onTimeUpdate={() => {
                const element = video.current!;
                const at = element.currentTime - report.settings.start;
                if (at >= duration) {
                  element.pause();
                  setPlaying(false);
                  setTime(duration);
                } else setTime(Math.max(0, at));
              }}
              onEnded={() => setPlaying(false)}
              onPause={() => setPlaying(false)}
              onError={() => setError("原片无法播放，报告仍保留")}
            />
            {overlay && (
              <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="报告记录的姿态骨架">
                {body25Pairs.map(
                  ([a, b], index) =>
                    points[a] &&
                    points[b] &&
                    Math.min(points[a]!.c, points[b]!.c) >= confidence && (
                      <line
                        key={index}
                        x1={points[a]!.x}
                        y1={points[a]!.y}
                        x2={points[b]!.x}
                        y2={points[b]!.y}
                        stroke={body25Colors[index % body25Colors.length]}
                        strokeWidth={Math.max(1, width / 180)}
                        strokeDasharray={pose?.filled ? "6 4" : undefined}
                      />
                    ),
                )}
                {points.map(
                  (point, index) =>
                    point.c >= confidence && (
                      <circle
                        key={index}
                        cx={point.x}
                        cy={point.y}
                        r={Math.max(1, width / 220)}
                        fill={body25Colors[index]}
                      />
                    ),
                )}
              </svg>
            )}
          </div>
          <div className="motionActions">
            <button type="button" onClick={toggle}><NodeIcon name={playing ? "pause" : "play"} />{playing ? "暂停" : "播放区间"}</button>
            <button
              disabled={time <= 0}
              onClick={() => seek(time - 1 / (report.pose?.fps ?? report.camera?.fps ?? 6))}>
              <NodeIcon name="arrowLeft" />上一采样
            </button>
            <button
              disabled={time >= duration}
              onClick={() => seek(time + 1 / (report.pose?.fps ?? report.camera?.fps ?? 6))}>
              <NodeIcon name="arrowRight" />下一采样
            </button>
          </div>
          <input
            aria-label="报告预览时间"
            type="range"
            min={0}
            max={duration}
            step={0.001}
            value={time}
            onChange={(event) => seek(event.target.valueAsNumber)}
          />
          <small>
            {time.toFixed(3)} / {duration.toFixed(3)}s · 原片{" "}
            {(report.settings.start + time).toFixed(3)}s
          </small>
          <label className="motionCheck">
            <input
              type="checkbox"
              checked={sourceVisible}
              onChange={(event) => setSourceVisible(event.target.checked)}
            />
            原片
          </label>
          <label className="motionCheck">
            <input
              type="checkbox"
              checked={overlay}
              onChange={(event) => setOverlay(event.target.checked)}
            />
            报告姿态
          </label>
          <label className="motionSetting">
            关节置信阈值
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={confidence}
              onChange={(event) => {
                if (Number.isFinite(event.target.valueAsNumber))
                  setConfidence(Math.max(0, Math.min(1, event.target.valueAsNumber)));
              }}
            />
          </label>
          <small>
            Pose{" "}
            {pose
              ? `${pose.time.toFixed(3)}s · ${pose.landmarks.length ? (pose.filled || pose.source === "filled" ? "补帧" : "实测") : "缺失"} · ${Math.round(pose.score * 100)}%`
              : "未分析"}
            ；显示最近的已采样帧，不插值。
          </small>
          {camera && (
            <small>
              二维运动置信度 {Math.round(camera.confidence * 100)}%，不代表三维摄影机位姿。
            </small>
          )}
          {series.length > 0 && (
            <details open>
              <summary>二维运动轨迹</summary>
              {traces.map((trace) => {
                const min = Math.min(...trace.values),
                  max = Math.max(...trace.values),
                  range = max - min || 1;
                return (
                  <figure key={trace.key}>
                    <figcaption>
                      {trace.label} · {min.toFixed(3)} – {max.toFixed(3)}
                    </figcaption>
                    <svg viewBox="0 0 300 60" role="img" aria-label={trace.label}>
                      <polyline
                        points={trace.values
                          .map(
                            (value, index) =>
                              `${series.length <= 1 ? 0 : (index / (series.length - 1)) * 300},${56 - ((value - min) / range) * 52}`,
                          )
                          .join(" ")}
                      />
                      <line
                        x1={(time / duration) * 300}
                        x2={(time / duration) * 300}
                        y1={0}
                        y2={60}
                      />
                    </svg>
                  </figure>
                );
              })}
            </details>
          )}
          {report.diagnostics.map((diagnostic, index) => (
            <small key={index}>{diagnostic}</small>
          ))}
          <small>源片 SHA-256 {report.sourceFingerprint}</small>
        </>
      )}
    </section>
  );
}
