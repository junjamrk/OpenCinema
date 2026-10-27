import { useEffect, useRef, useState } from "react";
import { getWaveformPeaks } from "../audioWaveform";
import { errorText } from "../reactNode";
import NodeIcon from "./reactIcon";

function formatTime(value: number) {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function AudioPlayer({ url, label = "节点音频", onError, onReady, onPeaks, hideWaveform }: { url: string; label?: string; onError?(): void; onReady?(element: HTMLAudioElement): void; onPeaks?(peaks: number[]): void; hideWaveform?: boolean }) {
  const player = useRef<HTMLAudioElement>(null);
  const callbacks = useRef({ onReady, onPeaks }); callbacks.current = { onReady, onPeaks };
  const [peaks, setPeaks] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const operation = new AbortController(); setPeaks([]); setDuration(0); setCurrent(0); setPlaying(false); setFailed(false); setError(""); setLoading(true);
    void (async () => {
      const response = await fetch(url, { signal: operation.signal }); if (!response.ok) throw new Error("音频波形读取失败");
      const content = await response.arrayBuffer(); operation.signal.throwIfAborted();
      if (content.byteLength > 100 * 1024 ** 2) throw new Error("超大音频保留播放，不完整解码波形");
      const context = new OfflineAudioContext(1, 1, 48000); const buffer = await context.decodeAudioData(content); operation.signal.throwIfAborted();
      const values = getWaveformPeaks(Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))); setPeaks(values); callbacks.current.onPeaks?.(values);
    })().catch(() => {}).finally(() => { if (!operation.signal.aborted) setLoading(false); });
    return () => { operation.abort(); player.current?.pause(); };
  }, [url]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0; const update = () => { setCurrent(player.current?.currentTime ?? 0); frame = requestAnimationFrame(update); }; update();
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  function readDuration() { const value = player.current?.duration; setDuration(value && Number.isFinite(value) ? Math.max(0, value) : 0); if (player.current) callbacks.current.onReady?.(player.current); }
  function seek(value: number) { if (!player.current || !Number.isFinite(value)) return; player.current.currentTime = Math.min(duration, Math.max(0, value)); setCurrent(player.current.currentTime); }
  async function toggle() { const element = player.current; if (!element) return; if (!element.paused) element.pause(); else try { await element.play(); } catch (reason) { setError(errorText(reason)); } }
  const progress = duration ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
  return <div className="nodeAudioPlayer nodeControls" onKeyDown={event => event.stopPropagation()}>
    <audio ref={player} src={url} preload="metadata" aria-label={label} onLoadedMetadata={readDuration} onDurationChange={readDuration} onTimeUpdate={() => setCurrent(player.current?.currentTime ?? 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onVolumeChange={() => { setVolume(player.current?.volume ?? 1); setMuted(!!player.current?.muted); }} onError={() => { setFailed(true); setPlaying(false); onError?.(); }} />
    {!hideWaveform && <div style={{ position: "relative", height: 72, minWidth: 180 }}>
      {peaks.length > 0 ? <svg width="100%" height="72" viewBox="0 0 512 100" preserveAspectRatio="none" aria-hidden="true">{peaks.map((peak, index) => <rect key={index} x={index * 4 + 1} y={50 - Math.max(2, peak * 78) / 2} width="2" height={Math.max(2, peak * 78)} rx="1" fill={index / peaks.length * 100 <= progress ? "var(--actionPrimary, #14b8a6)" : "currentColor"} opacity={index / peaks.length * 100 <= progress ? 1 : .4} />)}</svg> : <span className="nodeStatus">{failed ? "无法播放音频" : loading ? "正在读取波形…" : "当前音频无法显示波形"}</span>}
      <input type="range" min="0" max={duration || 1} step=".01" value={current} disabled={!duration || failed} aria-label="音频播放进度" aria-valuetext={`${formatTime(current)} / ${formatTime(duration)}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }} onChange={event => seek(Number(event.target.value))} onKeyDown={event => { if (event.code === "Space") { event.preventDefault(); void toggle(); } }} />
      {duration > 0 && <span style={{ position: "absolute", top: 0, bottom: 0, left: `${progress}%`, width: 1, background: "currentColor", pointerEvents: "none" }} />}
    </div>}
    <div className="nodeActions"><button type="button" disabled={!duration || failed} title={playing ? "暂停音频" : "播放音频"} aria-label={playing ? "暂停音频" : "播放音频"} onClick={() => void toggle()}><NodeIcon name={playing ? "pause" : "play"} /></button><span className="nodeStatus">{formatTime(current)} / {formatTime(duration)}</span><button type="button" disabled={failed} title={muted || !volume ? "取消静音" : "静音音频"} aria-label={muted || !volume ? "取消静音" : "静音音频"} aria-pressed={muted || !volume} onClick={() => { if (!player.current) return; if (!volume) player.current.volume = 1; player.current.muted = !muted && volume > 0; }}><NodeIcon name={muted || !volume ? "mute" : "volume"} /></button><input type="range" min="0" max="1" step=".01" value={muted ? 0 : volume} disabled={failed} aria-label="音频音量" onChange={event => { if (!player.current) return; player.current.volume = Number(event.target.value); player.current.muted = false; }} /></div>
    {error && <p className="nodeError" role="alert">{error}</p>}
  </div>;
}
