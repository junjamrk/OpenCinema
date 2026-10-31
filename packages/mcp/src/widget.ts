import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/server";
import { readFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { McpTool, ReadResourceResult, Resource } from "./index";

export function getOpenCinemaResourceUri(html: string) {
  return `ui://openCinema/workspace/v3-${createHash("sha256").update(html).digest("hex").slice(0, 24)}.html`;
}

export function createOpenCinemaTool(execute: McpTool["execute"], resourceUri: string): McpTool {
  return {
    name: "renderOpenCinema",
    title: "OpenCinema 工作台",
    description: "在 Codex 原生 Widget 中打开 OpenCinema 完整工作台。先读取 getAppState 确认现有工程，再传入 directory 与可选 canvasId；不重新导入或创建工程。选择节点后可发送到当前对话；修改、保存和撤销重做必须使用现有实时画布工具，禁止直接改画布 JSON。本工具不发起媒体生成。",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string", minLength: 1, maxLength: 4096 }, canvasId: { type: "string", minLength: 1, maxLength: 256 } },
      required: ["directory"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri },
      [RESOURCE_URI_META_KEY]: resourceUri,
      "openai/outputTemplate": resourceUri,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "正在打开 OpenCinema",
      "openai/toolInvocation/invoked": "OpenCinema 已准备",
    },
    execute,
  };
}

function resourceMeta() {
  return {
    ui: { prefersBorder: false, permissions: { clipboardWrite: {} }, csp: { connectDomains: ["https://api.toonflow.net", "https://opencinema.site"], resourceDomains: ["blob:", "data:"], frameDomains: ["https://api.toonflow.net"] } },
    "openai/widgetDescription": "OpenCinema 视频工作台，保留现有画布、节点、工程文件和扩展插件。",
    "openai/widgetPrefersBorder": false,
    "openai/widgetCSP": { connect_domains: ["https://api.toonflow.net", "https://opencinema.site"], resource_domains: ["blob:", "data:"], frame_domains: ["https://api.toonflow.net"] },
    "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" },
  };
}

export function getOpenCinemaResourceDescription(uri: string): Resource {
  return { uri, name: "OpenCinema Studio", description: "OpenCinema 完整视频工作台", mimeType: RESOURCE_MIME_TYPE, _meta: resourceMeta() };
}

export async function getOpenCinemaResource(scriptPath: string, signal: AbortSignal): Promise<ReadResourceResult> {
  signal.throwIfAborted();
  const meta = resourceMeta();
  const webRoot = resolve(dirname(scriptPath), "widgetWeb");
  async function read(path: string) {
    return readFile(path, { encoding: "utf8", signal }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("请先构建 MCP 包，生成 OpenCinema 完整工作台资源");
      throw error;
    });
  }
  const [script, html] = await Promise.all([read(scriptPath), read(resolve(webRoot, "index.html"))]);
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi)];
  const styles = [...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")(?=[^>]*\bhref="([^"]+)")[^>]*>/gi)];
  if (sources.length !== 1 || !styles.length) throw new Error("OpenCinema 工作台构建必须包含唯一入口和内联样式");
  function asset(path: string) {
    const target = resolve(webRoot, path.replace(/^\.\//, ""));
    if (!target.startsWith(webRoot + sep)) throw new Error("OpenCinema 构建资源路径无效");
    return read(target);
  }
  const [entry, css] = await Promise.all([asset(sources[0]![1]!), Promise.all(styles.map(style => asset(style[1]!)))]);
  let text = html.replace(sources[0]![0], "");
  for (const style of styles) text = text.replace(style[0], "");
  const shellStyle = "<style>body{margin:0;display:flex;flex-direction:column;min-height:720px;height:100dvh;background:#0e1117;color:#dfe4ee}.widgetHeader{display:flex;align-items:center;gap:12px;flex:none;min-height:32px;padding:4px 16px;font:12px -apple-system,BlinkMacSystemFont,Inter,sans-serif;border-bottom:1px solid #ffffff12;background:#121720;color:#a6b0c1}.widgetTitle{font-weight:600;color:#dfe4ee;letter-spacing:-.01em}.widgetStatus{flex:1;font-size:11px}.fullscreenButton{font:inherit;border:1px solid #ffffff20;border-radius:6px;padding:3px 9px;background:transparent;color:inherit;cursor:pointer}.fullscreenButton:focus-visible{outline:2px solid #8998ff;outline-offset:2px}body>#app{flex:1;min-height:0;height:0}body>#app .openCinemaWorkbench{height:100%;min-height:0}body.fullscreen{min-height:0}</style>";
  const header = '<header class="widgetHeader"><span class="widgetTitle">OpenCinema Studio</span><span class="widgetStatus" role="status" aria-live="polite">正在连接 Agent</span><button class="fullscreenButton" type="button" hidden>全屏</button></header>';
  text = text.replace("</head>", () => shellStyle + "</head>").replace(/<body([^>]*)>/i, (_match, attributes: string) => "<body" + attributes + ">" + header);
  // ACT: 当前宿主限制 HTML 为 20 MB；全部工作台资源压缩内联，本地解压后先装 SDK 再挂载 React。
  const compressedEntry = gzipSync(JSON.stringify({ app: script, entry, css: css.join("\n") }), { level: 9 }).toString("base64");
  const loader = `try {
    const bytes = Uint8Array.from(atob("${compressedEntry}"), character => character.charCodeAt(0));
    const source = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
    const style = document.createElement("style");
    style.textContent = source.css;
    document.head.append(style);
    await new Promise((resolve, reject) => {
      const app = document.createElement("script");
      app.type = "module";
      const cleanup = () => {
        window.removeEventListener("openCinemaSdkInstalled", installed);
        window.removeEventListener("error", failed);
      };
      const installed = () => {
        cleanup();
        if (!window.openCinemaTransport) reject(new Error("OpenCinema 宿主传输尚未安装"));
        else resolve();
      };
      const failed = () => { cleanup(); reject(new Error("OpenCinema 宿主 SDK 加载失败")); };
      window.addEventListener("openCinemaSdkInstalled", installed, { once: true });
      window.addEventListener("error", failed, { once: true });
      app.onerror = failed;
      app.textContent = source.app + ${JSON.stringify(';window.dispatchEvent(new Event("openCinemaSdkInstalled"));')};
      document.body.append(app);
    });
    const entry = document.createElement("script");
    entry.type = "module";
    entry.textContent = source.entry;
    document.body.append(entry);
  } catch (error) {
    document.querySelector(".widgetStatus").textContent = "OpenCinema 工作台资源加载失败";
    console.error(error);
  }`;
  text = text.replace("</body>", () => '<script type="module">' + loader + "</script></body>");
  if (Buffer.byteLength(text) > 20_000_000) throw new Error("OpenCinema 工作台资源超过 Codex 的 20 MB 显示上限");
  return { contents: [{ uri: getOpenCinemaResourceUri(text), mimeType: RESOURCE_MIME_TYPE, text, _meta: meta }] };
}
