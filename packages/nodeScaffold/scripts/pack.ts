import { chmod, rm } from "@toonflow/file";
import { resolve } from "node:path";

// npm pack 的 prepack 入口。Node 不转译 node_modules 下的 TypeScript，tarball 也不含工作区包，
// 所以构建配置和骨架脚本在这里打成 dist 下的 JS；其余公开子路径保持 TS 源码，由插件项目的 Vite 转译。
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
await rm(output, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [resolve(root, "src/reactBuildConfig.ts"), resolve(root, "scripts/createPlugin.ts")],
  outdir: output, target: "node", format: "esm", naming: "[name].[ext]",
  // ACT: 与 packages/openCinema 发行构建一致，Node 发行物使用标准文件原语，不打包移动端 Bun FFI。
  define: { "process.env.TOONFLOW_PLATFORM": '""' },
  external: ["vite", "@vitejs/plugin-react", "react", "zod", resolve(root, "../file/src/renameExclusive.ts")],
});
if (!result.success) throw new AggregateError(result.logs, "脚手架发行构建失败");
await chmod(resolve(output, "createPlugin.js"), 0o755);
