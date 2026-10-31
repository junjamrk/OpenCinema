#!/usr/bin/env node
import { readFile, stat } from "@toonflow/file";
import { parseArgs } from "node:util";

// 配合 vite build --watch 使用：install.json 一变就提交给本机工作台，不用每次手动选文件。工作台里点“刷新目录”加载新版本。
const { values, positionals } = parseArgs({ allowPositionals: true, options: { server: { type: "string", default: "http://127.0.0.1:47920" } } });
const path = positionals[0] ?? "dist/install.json";
const origin = new URL(values.server).origin;
let lastChange = 0;

async function installChanged() {
  const change = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0;
  if (!change || change === lastChange) return;
  lastChange = change;
  const value = JSON.parse(await readFile(path, "utf8"));
  const response = await fetch(`${origin}/api/nodes/install`, { method: "POST", headers: { "Content-Type": "application/json", "X-Toonflow-Workspace": "1", Origin: origin }, body: JSON.stringify({ ...value, fileName: `${value.manifest.id}.js`, force: true }) });
  const result = await response.json();
  console.log(response.ok ? `已安装 ${value.manifest.id} ${value.manifest.version}` : `安装失败：${result.message}`);
}

console.log(`监听 ${path}，提交到 ${origin}`);
setInterval(() => void installChanged().catch(error => console.error(`安装失败：${error.message}`)), 1000);
