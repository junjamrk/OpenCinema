import NodeIcon from "./reactIcon";
import { useEffect, useRef, useState } from "react";
import { readMedia, useMediaUrl, type NodeViewProps } from "../reactNode";
import AudioPlayer from "./reactAudioPlayer";
import { attachMediaPlayer, mediaEditor } from "../mediaEditor";
import { useEditorSession } from "../editorSession";
import "../theme/mediaInteractions.scss";

type AudioRange = { start: number; end: number };
type EditState = { groups: AudioRange[][]; selected: number; playhead: number };

function readClips(groups: AudioRange[][]) {
  let offset = 0;
  return groups.map(ranges => { let length = 0; const parts = ranges.map(range => { const part = { ...range, offset: length, length: range.end - range.start }; length += part.length; return part; }); const clip = { parts, offset, length }; offset += length; return clip; });
}

export default function AudioClipEditor({ node, controller, readOnly }: NodeViewProps) {
  const source = readMedia(node.data, "audio"); const { url, error } = useMediaUrl(controller, source);
  const draft = mediaEditor(controller.getNodeService(node.id));
  const { value: state } = useEditorSession(draft);
  const setState = (next: EditState | ((current: EditState) => EditState)) => { const current = draft.read().value; draft.replace({ ...current, ...(typeof next === "function" ? next(current) : next) }); };
  const latest = useRef<EditState>(state); latest.current = state;
  const [player, setPlayer] = useState<HTMLAudioElement>(); const [duration, setDuration] = useState(0); const [peaks, setPeaks] = useState<number[]>([]);
  const position = useRef({ clip: 0, part: 0 }); const initialized = useRef(false);
  const clips = readClips(state.groups); const total = clips.reduce((sum, clip) => sum + clip.length, 0); const clip = clips[state.selected];
  const canSplit = !!clip && state.playhead - clip.offset >= .01 && clip.offset + clip.length - state.playhead >= .01;
  const valid = !!state.groups.length && duration > 0 && state.groups.flat().every(range => range.start >= 0 && range.end > range.start && range.end <= duration);
  function seek(time: number, groups = latest.current.groups, pause = true) {
    const values = readClips(groups); const total = values.reduce((sum, item) => sum + item.length, 0); const playhead = Math.min(total, Math.max(0, time));
    const index = values.findIndex(item => item.offset + item.length > playhead); const selected = index < 0 ? Math.max(0, values.length - 1) : index;
    const clip = values[selected]; const partIndex = clip?.parts.findIndex(part => clip.offset + part.offset + part.length > playhead) ?? -1; const part = clip?.parts[partIndex < 0 ? clip.parts.length - 1 : partIndex];
    position.current = { clip: selected, part: partIndex < 0 ? Math.max(0, (clip?.parts.length ?? 1) - 1) : partIndex };
    if (player) { if (pause) player.pause(); if (part) player.currentTime = part.start + playhead - clip!.offset - part.offset; }
    return { groups, selected, playhead };
  }
  function apply(next: EditState) { player?.pause(); const value = seek(next.playhead, next.groups); value.selected = Math.min(Math.max(0, next.selected), Math.max(0, next.groups.length - 1)); latest.current = value; setState(value); }
  function commit(groups: AudioRange[][], selected = state.selected, playhead = state.playhead) { if (!readOnly) apply({ groups, selected, playhead }); }
  function split() {
    if (readOnly || !clip || !canSplit) return; const time = state.playhead - clip.offset; const left: AudioRange[] = []; const right: AudioRange[] = [];
    for (const part of clip.parts) { if (part.offset + part.length <= time) left.push({ start: part.start, end: part.end }); else if (part.offset >= time) right.push({ start: part.start, end: part.end }); else { const sourceTime = part.start + time - part.offset; left.push({ start: part.start, end: sourceTime }); right.push({ start: sourceTime, end: part.end }); } }
    const groups = [...state.groups]; groups.splice(state.selected, 1, left, right); commit(groups, state.selected + 1);
  }
  function merge() { if (readOnly || state.groups.length < 2) return; const index = Math.max(0, state.selected - 1); const groups = [...state.groups]; groups.splice(index, 2, [...groups[index]!, ...groups[index + 1]!]); commit(groups, index); }
  function undo() { if (readOnly) return; player?.pause(); draft.undo(); }
  function redo() { if (readOnly) return; player?.pause(); draft.redo(); }
  function remove() { if (readOnly || !state.groups[state.selected]) return; const groups = state.groups.filter((_group, index) => index !== state.selected); const index = Math.min(state.selected, Math.max(0, groups.length - 1)); commit(groups, index, readClips(groups)[index]?.offset ?? 0); }
  useEffect(() => {
    initialized.current = false; position.current = { clip: 0, part: 0 }; setPeaks([]); setDuration(0);
    if (draft.read().value.source !== source?.url) draft.replace({ source: source?.url ?? "", sourceRevision: null, start: 0, end: 5, groups: [], selected: 0, playhead: 0 });
  }, [url]);
  useEffect(() => {
    if (!player) return;
    return attachMediaPlayer(controller.getNodeService(node.id), player, "clip");
  }, [controller, node.id, player]);
  useEffect(() => {
    if (player?.paused) seek(state.playhead, state.groups, false);
  }, [player, state.playhead, state.groups]);
  useEffect(() => {
    if (!player) return; let frame = 0;
    // ACT: 浏览器试听按动画帧跳过删除区间；最终导出由 FFmpeg 按采样时间精确裁切与拼接。
    const tick = () => {
      if (player.paused) return; const values = readClips(latest.current.groups); let current = values[position.current.clip]; let part = current?.parts[position.current.part];
      if (!current || !part) { player.pause(); return; }
      if (player.currentTime >= part.end) {
        let next = current.parts[++position.current.part]; if (!next) { next = values[++position.current.clip]?.parts[0]; position.current.part = 0; }
        if (!next) { player.pause(); const total = values.reduce((sum, clip) => sum + clip.length, 0); setState(value => ({ ...value, playhead: total })); return; }
        player.currentTime = next.start; current = values[position.current.clip]!; part = next;
      }
      setState(value => ({ ...value, selected: position.current.clip, playhead: current!.offset + part!.offset + Math.max(0, Math.min(part!.length, player.currentTime - part!.start)) })); frame = requestAnimationFrame(tick);
    };
    const play = () => { latest.current = draft.read().value; const values = readClips(latest.current.groups); const total = values.reduce((sum, clip) => sum + clip.length, 0); if (!total || readOnly) { player.pause(); return; } const next = seek(latest.current.playhead >= total ? 0 : latest.current.playhead, latest.current.groups, false); setState(next); cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); };
    const pause = () => cancelAnimationFrame(frame); player.addEventListener("play", play); player.addEventListener("pause", pause);
    return () => { player.pause(); cancelAnimationFrame(frame); player.removeEventListener("play", play); player.removeEventListener("pause", pause); };
  }, [player, readOnly]);
  return <div className="nodeAudioClipEditor" onKeyDown={event => { if (readOnly) return; const key = event.key.toLowerCase(); if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(key)) { event.preventDefault(); event.stopPropagation(); key === "y" || event.shiftKey ? redo() : undo(); } else if ((event.target as HTMLElement).closest(".nodeClipTrack") && ["Delete", "Backspace"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); remove(); } }}>
    {url && <AudioPlayer url={url} hideWaveform label="音频剪辑预览" onPeaks={setPeaks} onReady={element => { setPlayer(element); const duration = element.duration; setDuration(Number.isFinite(duration) ? duration : 0); if (!initialized.current && duration > 0 && Number.isFinite(duration)) { initialized.current = true; if (!draft.read().value.groups.length && !draft.history.canUndo && !draft.history.canRedo) { const value = { ...draft.read().value, groups: [[{ start: 0, end: duration }]], selected: 0, playhead: 0 }; latest.current = value; draft.replace(value, undefined, null); } } }} />}
    <div className="nodeClipTrack" role="group" aria-label="音频剪辑轨道">{clips.map((clip, index) => <button type="button" key={index} style={{ left: `${clip.offset / (total || 1) * 100}%`, width: `${clip.length / (total || 1) * 100}%` }} aria-pressed={state.selected === index} disabled={readOnly} aria-label={`片段 ${index + 1}，时长${clip.length.toFixed(2)}秒`} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setState(seek(clip.offset + (event.detail ? (event.clientX - bounds.left) / bounds.width * clip.length : 0))); }}><span>片段 {index + 1}</span>{peaks.length > 0 && clip.parts.map((part, partIndex) => <svg key={partIndex} style={{ left: `${part.offset / clip.length * 100}%`, width: `${part.length / clip.length * 100}%` }} viewBox={`${part.start / duration * 512} 0 ${part.length / duration * 512} 100`} preserveAspectRatio="none" aria-hidden="true">{peaks.map((peak, bar) => <rect key={bar} x={bar * 4 + 1} y={50 - Math.max(2, peak * 78) / 2} width="2" height={Math.max(2, peak * 78)} rx="1" />)}</svg>)}<small>{clip.length.toFixed(2)} 秒</small></button>)}{total > 0 && <i className="nodeClipPlayhead" style={{ left: `${state.playhead / total * 100}%` }} />}</div>
    <label className="nodeField"><span>剪辑游标 · {state.playhead.toFixed(2)} / {total.toFixed(2)} 秒</span><input type="range" min="0" max={total || 1} step=".01" value={state.playhead} disabled={readOnly || !valid} aria-label="剪辑游标" onChange={event => setState(seek(Number(event.target.value)))} /></label>
    <div className="nodeActions"><button type="button" disabled={readOnly || !draft.history.canUndo} onClick={undo}><NodeIcon name="undo" />撤销剪辑</button><button type="button" disabled={readOnly || !draft.history.canRedo} onClick={redo}><NodeIcon name="redo" />恢复剪辑</button><button type="button" disabled={readOnly || !canSplit} onClick={split}><NodeIcon name="cut" />分割</button><button type="button" disabled={readOnly || state.groups.length < 2} onClick={merge}><NodeIcon name="merge" />粘合</button><button type="button" disabled={readOnly || !state.groups[state.selected]} onClick={remove}><NodeIcon name="trash" />删除选中片段</button></div>
    {error && <p className="nodeError" role="alert">{error}</p>}
  </div>;
}
