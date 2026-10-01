import mediaInfoFactory, { type MediaInfo } from "mediainfo.js";
import wasmUrl from "mediainfo.js/MediaInfoModule.wasm?url";
import { z } from "zod";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/nodeFiles";

const referenceSchema = z.strictObject({
  url: z.string().min(1).max(4096).refine(path => !/^[\\/]|^[a-z][a-z0-9+.-]*:|\0/i.test(path) && !path.replaceAll("\\", "/").split("/").includes(".."), "仅支持工作区相对路径"),
  mimeType: z.string().min(1).max(200),
});
const fields = ["Format", "Format_Profile", "CodecID", "Duration", "Width", "Height", "FrameRate", "FrameRate_Mode", "BitRate", "BitDepth", "Channels", "SamplingRate", "ColorSpace", "ChromaSubsampling"] as const;

function trackNumber(track: Record<string, unknown> | undefined, field: string) {
  const number = Number(track?.[field]);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function summarize(tracks: Record<string, string | number>[]) {
  const general = tracks.find(track => track.type === "General");
  const video = tracks.find(track => track.type === "Video");
  const image = tracks.find(track => track.type === "Image");
  const audio = tracks.filter(track => track.type === "Audio");
  const duration = trackNumber(general ?? video ?? audio[0], "Duration");
  const visual = video ?? image;
  return [
    general?.Format ? `容器：${general.Format}` : "",
    duration === undefined ? "" : `时长：${duration.toFixed(3)} 秒`,
    visual ? `${video ? "视频" : "图像"}：${visual.Format ?? "未知编码"} · ${visual.Width ?? "?"} × ${visual.Height ?? "?"}${video?.FrameRate ? ` · ${video.FrameRate} fps` : ""}` : "",
    ...audio.map((track, index) => `音轨 ${index + 1}：${track.Format ?? "未知编码"} · ${track.Channels ?? "?"} 声道${track.SamplingRate ? ` · ${track.SamplingRate} Hz` : ""}`),
    !audio.length && video ? "无音轨" : "",
  ].filter(Boolean).join("\n");
}

export function createMediaInfoService(files: WorkspaceFiles, lifetime: AbortSignal) {
    const context = { getFiles: () => files, signal: lifetime };
    if (typeof context.getFiles().readRange !== "function") throw new Error("宿主缺少分段文件读取能力，请更新应用");
    let engine: MediaInfo | undefined;
    let loading: Promise<MediaInfo> | undefined;
    let busy = false;
    function close() { if (engine) { engine.close(); engine = undefined; } }
    context.signal.addEventListener("abort", () => { if (!busy) close(); }, { once: true });
    async function getEngine(signal: AbortSignal) {
      loading ??= mediaInfoFactory({ format: "object", coverData: false, chunkSize: 1024 * 1024, locateFile: () => wasmUrl }).then(value => {
        if (context.signal.aborted) { value.close(); context.signal.throwIfAborted(); }
        engine = value;
        return value;
      }).catch(error => { loading = undefined; throw error; });
      signal.throwIfAborted();
      return new Promise<MediaInfo>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        loading!.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, failure => { signal.removeEventListener("abort", abort); reject(failure); });
        if (signal.aborted) abort();
      });
    }
    return {
      dispose: () => { if (!busy) close(); },
      service: {
        async analyze(reference: NodeMediaValue, signal: AbortSignal, onRead: (bytes: number) => void) {
          const source = referenceSchema.parse(reference);
          const combined = AbortSignal.any([context.signal, signal, AbortSignal.timeout(60000)]);
          combined.throwIfAborted();
          // ACT: 一个画布共用一个WASM实例，同期只检查一份素材；需要并行时改为有上限的Worker池。
          if (busy) throw new Error("当前画布正在检查另一份素材，请完成或取消后再试");
          busy = true;
          try {
            const files = context.getFiles();
            const first = await files.readRange!(source.url, 0, 1, undefined, combined);
            if (!first.size || first.size > 32 * 1024 ** 3) throw new Error("素材须为32GiB以内的非空文件");
            const analyzer = await getEngine(combined);
            combined.throwIfAborted();
            let bytesRead = first.content.byteLength, reads = 1;
            const result = await analyzer.analyzeData(first.size, async (length, offset) => {
              combined.throwIfAborted();
              if (!Number.isSafeInteger(offset) || offset < 0 || offset > first.size || !Number.isSafeInteger(length) || length < 0) throw new Error("媒体解析器请求了无效文件范围");
              if (!length || offset === first.size) return new Uint8Array();
              const size = Math.min(length, first.size - offset);
              if (++reads > 256 || bytesRead + size > 64 * 1024 ** 2) throw new Error("素材信息检查超过64MiB读取预算，请使用桌面媒体工具检查这份素材");
              const chunk = await files.readRange!(source.url, offset, size, first.revision, combined);
              combined.throwIfAborted();
              if (chunk.size !== first.size || chunk.revision !== first.revision) throw new Error("素材已变化，请重新检查");
              bytesRead += chunk.content.byteLength; onRead(bytesRead);
              return new Uint8Array(chunk.content);
            });
            combined.throwIfAborted();
            // 只保存技术字段，不复制标题、作者、位置、封面或任意内嵌标签。
            const tracks = result.media?.track?.slice(0, 128).map(track => {
              const value: Record<string, string | number> = { type: String(track["@type"]) };
              for (const field of fields) {
                const item: unknown = Reflect.get(track, field);
                if (typeof item === "number" && Number.isFinite(item)) value[field] = item;
                else if (typeof item === "string") value[field] = item.slice(0, 240);
              }
              return value;
            }) ?? [];
            if (!tracks.some(track => track.Format && ["Video", "Audio", "Image"].includes(String(track.type)))) throw new Error("未识别到受支持的音视频或图像轨道");
            // 再读一个字节确认最终发布前文件修订未变；该修订号不宣称是内容指纹。
            if (++reads > 256 || bytesRead + 1 > 64 * 1024 ** 2) throw new Error("素材信息检查超过读取预算");
            await files.readRange!(source.url, 0, 1, first.revision, combined);
            bytesRead++;
            combined.throwIfAborted();
            return {
              report: { schemaVersion: 1, engine: { name: "mediainfo.js", version: "0.3.8" }, source: { ...source, size: first.size, revision: first.revision }, tracks, bytesRead },
              summary: summarize(tracks),
            };
          } finally { busy = false; if (context.signal.aborted) close(); }
        },
      },
    };
}

export type MediaInfoService = ReturnType<typeof createMediaInfoService>["service"];
