import { cp, mkdir, readFile, writeAtomic } from "@toonflow/file";
import { resolve } from "node:path";
import { build } from "vite";
import { listWorkbenchTools } from "../../../apps/web/src/lib/workbenchTools";
import { createOpenCinemaTool, getOpenCinemaResource } from "../src/widget";

const packageRoot = resolve(import.meta.dir, "..");
const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as { version: string };
const output = resolve(packageRoot, "../../build/mcp");
const webRoot = resolve(packageRoot, "../../apps/web");
await build({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  base: "./",
  plugins: [{
    name: "openCinemaInlineAssets",
    enforce: "pre",
    resolveId(source, importer) {
      if (!/[?&]no-inline(?:&|$)/.test(source)) return;
      return this.resolve(source.replace(/([?&])no-inline(?=&|$)/g, "$1inline"), importer, { skipSelf: true });
    },
  }],
  build: {
    outDir: resolve(output, "widgetWeb"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    modulePreload: false,
    reportCompressedSize: false,
    // Widget 将 React 唯一入口内联到沙箱，不产生网络加载块。
    rolldownOptions: { input: resolve(webRoot, "index.html"), output: { codeSplitting: false } },
  },
});
const widget = await Bun.build({
  entrypoints: [resolve(packageRoot, "src/widgetApp.ts")],
  outdir: output,
  target: "browser",
  format: "esm",
  minify: true,
});
if (!widget.success) throw new AggregateError(widget.logs, "OpenCinema Widget 构建失败");
const result = await Bun.build({
  entrypoints: [resolve(packageRoot, "src/index.ts"), resolve(packageRoot, "src/stdio.ts"), resolve(packageRoot, "src/widget.ts"), resolve(packageRoot, "src/runtimeInfo.ts"), resolve(packageRoot, "src/client.ts")],
  outdir: output,
  target: "node",
  format: "esm",
  minify: true,
  // ACT: Node 不包含移动端 Bun FFI；保留运行时平台检测，避免错误平台被常量伪装。
  define: { "process.env.TOONFLOW_PLATFORM": '""' },
  external: [resolve(packageRoot, "../file/src/renameExclusive.ts")],
});
if (!result.success) throw new AggregateError(result.logs, "MCP 构建失败");
await mkdir(output, { recursive: true });
await cp(resolve(packageRoot, "skills"), resolve(output, "skills"), { recursive: true });
await cp(resolve(packageRoot, "README.md"), resolve(output, "README.md"));
await cp(resolve(packageRoot, "src/skill.d.ts"), resolve(output, "skill.d.ts"));
const resource = await getOpenCinemaResource(resolve(output, "widgetApp.js"), new AbortController().signal);
const renderTool = createOpenCinemaTool(async () => { throw new Error("Widget 由 Go 宿主打开"); }, resource.contents[0]!.uri);
await writeAtomic(resolve(output, "widgetResource.json"), JSON.stringify({ ...resource, tools: listWorkbenchTools(), renderToolMeta: renderTool._meta }));
await writeAtomic(resolve(output, "package.json"), JSON.stringify({
  name: "@toonflow/mcp",
  version: metadata.version,
  type: "module",
  exports: { ".": "./index.js", "./widget": "./widget.js", "./client": "./client.js", "./runtimeInfo": "./runtimeInfo.js", "./skill": { types: "./skill.d.ts", default: "./skills/toonflow/SKILL.md" } },
  bin: { "toonflow-mcp": "./stdio.js" },
}, null, 2));
console.log(`MCP 已构建到 ${output}`);
