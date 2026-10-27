import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { uploadNodeFile } from "@toonflow/nodes-scaffold/nodeFiles";
import { errorText, listMediaHistory, readMedia, useMediaUrl, type MediaType, type NodeViewProps } from "../reactNode";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import MediaDialog from "./reactMediaDialog";
import AudioPlayer from "./reactAudioPlayer";
import VideoPreview from "./reactVideoPreview";
import NodeIcon from "./reactIcon";
import { attachMediaPlayer } from "../mediaEditor";
import "../theme/nodeControls.scss";

function HistoryPreview({ value, mediaType, controller, disabled, onClose, onSelect }: { value: NodeMediaValue; mediaType: MediaType; controller: NodeViewProps["controller"]; disabled?: boolean; onClose(): void; onSelect(): void }) {
  const { url, error } = useMediaUrl(controller, value); const [ready, setReady] = useState(false); const [decodeError, setDecodeError] = useState("");
  return <MediaDialog title="媒体历史预览" onClose={onClose}>
    {url && mediaType === "image" && <img src={url} alt="历史图片" onLoad={() => setReady(true)} onError={() => setDecodeError("浏览器无法预览此历史图片")} />}
    {url && mediaType === "video" && <VideoPreview key={url} url={url} label="历史视频" onReady={() => setReady(true)} onError={setDecodeError} />}
    {url && mediaType === "audio" && <audio src={url} controls onLoadedMetadata={() => setReady(true)} onError={() => setDecodeError("浏览器无法预览此历史音频")} />}
    {(error || decodeError) && <p className="nodeError" role="alert">{error || decodeError}</p>}
    <span className="nodeStatus">{value.url}</span><button type="button" className="nodePrimary" disabled={disabled || !url || !ready || !!error || !!decodeError} onClick={onSelect}>设为当前结果</button>
  </MediaDialog>;
}

export default function MediaNode(props: NodeViewProps & { mediaType: MediaType; children?: ReactNode; disabled?: boolean; compact?: boolean; toolbarAction?: ReactNode; stageOverlay?: ReactNode; emptyAction?: ReactNode; fallbackPreview?: NodeMediaValue; fallbackCaption?: string; onVideoReady?(video: HTMLVideoElement): void; onAudioReady?(audio: HTMLAudioElement): void }) {
  const { node, controller, readOnly, mediaType, children, onVideoReady } = props;
  const value = readMedia(node.data, mediaType);
  const { url, error: previewError } = useMediaUrl(controller, value ?? props.fallbackPreview);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<NodeMediaValue[] | undefined>();
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [historyPreview, setHistoryPreview] = useState<NodeMediaValue>();
  const disabled = readOnly || busy || props.disabled;
  useEffect(() => { setError(""); }, [value?.url]);
  const input = useRef<HTMLInputElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const detachPlayer = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => { detachPlayer.current?.(); }, [controller, node.id, value?.url]);
  function readyPlayer(element: HTMLMediaElement) { detachPlayer.current?.(); detachPlayer.current = attachMediaPlayer(controller.getNodeService(node.id), element); }
  const title = mediaType === "image" ? "图片" : mediaType === "video" ? "视频" : "音频";
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  async function select(value: NodeMediaValue) {
    await controller.callNodeTool(node.id, `set${mediaType[0]!.toUpperCase()}${mediaType.slice(1)}`, { path: value.url, mimeType: value.mimeType });
    setHistory(undefined);
  }
  const toolbar = <div className={`nodeMediaToolbar nodrag nopan${props.toolbarMount ? " nodeMediaToolbarMounted" : props.compact ? " nodeMediaToolbarCompact" : ""}`} role="toolbar" aria-label={`${title}操作`} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
    if (event.defaultPrevented || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.target instanceof HTMLElement && event.target.closest("dialog")) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button:not(:disabled), a[href]")].filter(control => !control.closest("dialog") && control.getClientRects().length > 0);
    if (!controls.length) return;
    event.preventDefault(); event.stopPropagation();
    const index = controls.findIndex(control => control === event.target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowLeft" ? controls.length - 1 : 1)) % controls.length;
    controls[next]?.focus();
  }}>
    {props.toolbarAction && <div className="nodeMediaToolGroup nodeMediaCreativeTools" role="group" aria-label="继续创作">{props.toolbarAction}</div>}
    <div className="nodeMediaToolGroup" role="group" aria-label="管理素材">
      {(value || props.fallbackPreview || props.emptyAction) && <button className="nodeMediaTool" type="button" disabled={disabled} title={value ? `替换${title}` : `上传${title}`} aria-label={value ? `替换${title}` : `上传${title}`} onClick={() => input.current?.click()}><NodeIcon name="upload" /></button>}
      <button className="nodeMediaTool" ref={historyButton} type="button" disabled={busy} title={`${title}历史`} aria-label={`${title}历史`} aria-expanded={!!history} aria-haspopup="dialog" onClick={() => void perform(async () => { setPage(0); setHistory(history ? undefined : await listMediaHistory(controller.getNodeService(node.id), node.id, mediaType, value)); })}><NodeIcon name="history" /></button>
    </div>
    {url && <div className="nodeMediaToolGroup" role="group" aria-label="查看与下载">
      {value && <a className="nodeMediaTool" href={url} download={value.url.split("/").at(-1)} title={`下载${title}`} aria-label={`下载${title}`}><NodeIcon name="download" /></a>}
      {mediaType === "image" && <button className="nodeMediaTool" type="button" title="放大预览" aria-label="放大预览" onClick={() => setExpanded(true)}><NodeIcon name="expand" /></button>}
      {mediaType === "video" && <button className="nodeMediaTool" type="button" title="全屏视频" aria-label="全屏视频" onClick={() => void player.current?.requestFullscreen().catch(reason => setError(errorText(reason)))}><NodeIcon name="expand" /></button>}
    </div>}
  </div>;
  const historyContent = history && <div className="nodeMediaHistory" aria-label={`${title}历史`}>
    {history.slice(page * 20, (page + 1) * 20).map(item => <button type="button" key={item.url} disabled={busy} className={item.url === value?.url ? "selected" : ""} onClick={() => setHistoryPreview(item)} title={item.url}>{item.url.split("/").at(-1)}</button>)}
    {history.length > 20 && <div className="nodeActions"><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1}/{Math.ceil(history.length / 20)}</span><button type="button" disabled={(page + 1) * 20 >= history.length} onClick={() => setPage(page + 1)}>下一页</button></div>}
    {!history.length && <span>暂无媒体历史</span>}
  </div>;
  return <div className={`nodeControls nodeMediaControls nodrag nopan nowheel${url ? " nodeMediaHasPreview" : ""}`} data-media-type={mediaType} onDoubleClick={event => event.stopPropagation()}>
    <input ref={input} className="nodeFileInput" type="file" accept={`${mediaType}/*`} aria-label={`选择${title}`} disabled={disabled}
      onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        void perform(async () => {
          if (!file.type.startsWith(`${mediaType}/`)) throw new Error(`请选择${title}文件`);
          if (!file.size || file.size > 100 * 1024 ** 2) throw new Error("文件须为 100 MiB 以内的非空文件");
          const path = await uploadNodeFile(controller.getNodeService(node.id).files, node.id, file);
          await select({ url: path, mimeType: file.type });
        });
      }} />
    <div className="nodeMediaFrame"><div className={`nodeMediaStage${props.stageOverlay ? " nodeMediaStageGenerating" : ""}`} aria-busy={!!props.stageOverlay || !!(value || props.fallbackPreview) && !url && !previewError}>
      {url && mediaType === "image" && <img className="nodeMedia" src={url} alt={String(node.data?.label ?? title)} draggable={false} onError={() => setError("浏览器无法解码此图片，原文件保留")} />}
      {url && mediaType === "video" && <VideoPreview key={url} url={url} label={String(node.data?.label ?? title)} playerRef={player} onReady={video => { setError(""); readyPlayer(video); onVideoReady?.(video); }} onError={setError} />}
      {url && mediaType === "audio" && <AudioPlayer url={url} label={String(node.data?.label ?? title)} onReady={element => { readyPlayer(element); props.onAudioReady?.(element); }} onError={() => setError("浏览器无法预览此音频格式，仍可尝试本地 FFmpeg 处理")} />}
      {!url && (value || props.fallbackPreview) && !props.stageOverlay && <div className="nodeComposerEmpty" role="status"><NodeIcon name={previewError ? "info" : mediaType === "video" ? "movie" : mediaType === "audio" ? "volume" : "camera"} /><span>{previewError ? `${title}暂无法读取` : `正在读取${title}…`}</span></div>}
      {!value && !props.fallbackPreview && !props.stageOverlay && (props.emptyAction ?? <button className="nodeUploadArea" type="button" disabled={disabled} onClick={() => input.current?.click()}><NodeIcon name="upload" size={20} />选择{title}</button>)}
      {props.stageOverlay}
    </div>{props.toolbarMount ? createPortal(toolbar, props.toolbarMount) : toolbar}</div>
    {!value && props.fallbackPreview && props.fallbackCaption && <span className="nodeStatus">{props.fallbackCaption}</span>}
    {expanded && url && <MediaDialog title={String(node.data?.label ?? title)} onClose={() => setExpanded(false)}><img src={url} alt={String(node.data?.label ?? title)} /></MediaDialog>}
    {children}
    {history && <MediaDialog title={`${title}历史`} onClose={() => { setHistory(undefined); setHistoryPreview(undefined); }}>{historyContent}</MediaDialog>}
    {historyPreview && <HistoryPreview key={historyPreview.url} value={historyPreview} mediaType={mediaType} controller={controller} disabled={disabled} onClose={() => setHistoryPreview(undefined)} onSelect={() => void perform(async () => { await select(historyPreview); setHistoryPreview(undefined); requestAnimationFrame(() => historyButton.current?.focus()); })} />}
    {(error || previewError) && <p className="nodeError" role="alert">{error || previewError}</p>}
    {busy && <span className="nodeStatus" role="status">正在处理</span>}
  </div>;
}
