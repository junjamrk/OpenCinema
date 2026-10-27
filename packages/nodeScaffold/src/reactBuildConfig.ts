import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import * as React from "react";
import { z } from "zod";
import { nodeRequirementsSchema } from "./nodeCapabilities.ts";
import { nodeResourceManifestSchema, type NodeResource } from "./nodeResources.ts";

export interface NodeConfig {
  name: string;
  displayName: string;
  author: string;
  github: string;
  configRules?: Record<string, unknown>[];
  scope?: "canvas" | "workspace";
  requires?: Record<string, number>;
  resources?: Record<string, Omit<NodeResource, "size"> & { path: string }>;
}

function namespaceBridge(namespace: object, host: string) {
  const names = Object.keys(namespace).filter(name => name !== "default" && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name));
  return `import { ${host} as hostNamespace } from "/pluginSdk.js";\n${names.map((name, index) => `const value${index} = hostNamespace[${JSON.stringify(name)}]; export { value${index} as ${name} };`).join("\n")}\n${host === "z" && !names.includes("z") ? "export { hostNamespace as z };" : ""}\nexport default hostNamespace;`;
}

function sdkBridge(): Plugin {
  const sources = new Map([
    ["react", namespaceBridge(React, "React")],
    ["react/jsx-runtime", 'export { jsx, jsxs, Fragment } from "/pluginSdk.js";'],
    ["react/jsx-dev-runtime", 'export { jsx as jsxDEV, Fragment } from "/pluginSdk.js";'],
    ["react-dom", 'export { createPortal } from "/pluginSdk.js";'],
    ["zod", namespaceBridge(z, "z")],
  ]);
  return {
    name: "reactPluginSdk", enforce: "pre",
    resolveId(id) { if (sources.has(id)) return `\0openCinemaSdk:${id}`; },
    load(id) { if (id.startsWith("\0openCinemaSdk:")) return sources.get(id.slice("\0openCinemaSdk:".length)); },
  };
}

const mimeTypes: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain" };

export function createReactNodeConfig(config: NodeConfig, configUrl: string) {
  nodeRequirementsSchema.parse(config.requires ?? {});
  z.array(z.record(z.string(), z.json())).max(100).parse(config.configRules ?? []);
  if (!config.displayName.trim()) throw new Error("插件显示名不能为空");
  if (config.github) {
    const github = new URL(config.github);
    if (github.origin !== "https://github.com" || github.username || github.password) throw new Error("GitHub 地址必须是 https://github.com 下的地址");
  }
  const root = fileURLToPath(new URL(".", configUrl));
  const id = config.name;
  if (!/^[a-z][a-zA-Z0-9]*$/.test(id)) throw new Error("React 插件 ID 须使用小驼峰");
  const output = fileURLToPath(new URL(`../../../build/nodes/${id}`, import.meta.url));
  const sourceEntry = resolve(root, "src/reactPlugin.ts");
  const entryName = "virtual:openCinemaReactEntry";
  const entryId = "\0openCinemaReactEntry";
  const urls = new Map<string, string>();
  let manifest: Record<string, unknown>;
  let installPackage: Record<string, unknown>;
  return defineConfig({
    root,
    plugins: [
      sdkBridge(),
      {
        name: "reactPluginAssets", enforce: "pre",
        async resolveId(id, importer) {
          if (!id.endsWith("?url")) return;
          const resolved = await this.resolve(id.slice(0, -4), importer, { skipSelf: true });
          if (!resolved || resolved.external) throw new Error(`插件资源无法解析：${id}`);
          const key = `\0openCinemaAsset:${resolved.id}`; urls.set(key, resolved.id); return key;
        },
        async load(id) {
          const path = urls.get(id); if (!path) return;
          this.addWatchFile(path);
          const content = await readFile(path);
          if (!content.length || content.length > 32 * 1024 ** 2) throw new Error(`插件资源须为32MiB以内的非空文件：${basename(path)}`);
          const reference = this.emitFile({ type: "asset", name: basename(path), source: content });
          return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
        },
      },
      react(),
      {
        name: "reactPluginPackage",
        resolveId(id) { if (id === entryName) return entryId; },
        async load(value) {
          if (value !== entryId) return;
          const path = resolve(root, "package.json"); this.addWatchFile(path);
          const info = JSON.parse(await readFile(path, "utf8"));
          return `import plugin from ${JSON.stringify(sourceEntry)}; if (plugin.id !== ${JSON.stringify(config.name)} || plugin.renderer !== "react" || plugin.apiVersion !== 1) throw new Error("插件源码合同与发行入口不一致"); export default { ...plugin, version: ${JSON.stringify(info.version)}, name: ${JSON.stringify(config.displayName)}, scope: ${JSON.stringify(config.scope === "workspace" ? "workspace" : "node")}, requires: { ...${JSON.stringify(config.requires ?? {})}, ...plugin.requires } };`;
        },
        async generateBundle(_options, bundle) {
          const info = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
          if (typeof info.version !== "string" || !info.version.trim()) throw new Error("插件 package.json 缺少版本");
          const readme = await readFile(resolve(root, "readme.md"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
          const resources: Record<string, unknown> = {};
          for (const [name, resource] of Object.entries(config.resources ?? {})) {
            const content = await readFile(resolve(root, resource.path));
            if (content.length > 32 * 1024 ** 2 || createHash("sha256").update(content).digest("hex") !== resource.sha256) throw new Error(`插件资源 SHA 或大小不符：${name}`);
            const { path: _path, ...metadata } = resource; resources[name] = { ...metadata, size: content.length };
          }
          nodeResourceManifestSchema.parse(resources);
          if (Object.keys(resources).length && !config.requires?.pluginResources) throw new Error("包含资源的插件须声明 pluginResources 宿主能力");
          manifest = { apiVersion: 1, id, renderer: "react", scope: config.scope === "workspace" ? "workspace" : "node", name: config.displayName, displayName: config.displayName, version: info.version, author: config.author, github: config.github, requires: config.requires ?? {}, configRules: config.configRules ?? [], readme, resources };
          const module = bundle["index.js"];
          if (!module || module.type !== "chunk") throw new Error("未生成 React ESM 插件入口");
          const styles = Object.values(bundle).filter(asset => asset.type === "asset" && asset.fileName.endsWith(".css"));
          if (styles.length) {
            const hrefs = styles.map(asset => asset.fileName);
            module.code = `const styles = ${JSON.stringify(hrefs)}; if (typeof document !== "undefined") await Promise.all(styles.map(path => new Promise((resolve, reject) => { const href = new URL(path, import.meta.url).href; if (document.querySelector('link[data-open-cinema-plugin-style="'+CSS.escape(href)+'"]')) return resolve(); const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href; link.dataset.openCinemaPluginStyle = href; link.onload = () => resolve(); link.onerror = () => { link.remove(); reject(new Error("插件样式加载失败")); }; document.head.append(link); })));\n${module.code}`;
          }
          if (Buffer.byteLength(module.code) > 20 * 1024 ** 2) throw new Error("插件 ESM 超过20MiB");
          const assets = Object.values(bundle).filter(asset => asset.fileName !== "index.js").map(asset => {
            const bytes = Buffer.from(asset.type === "chunk" ? asset.code : typeof asset.source === "string" ? asset.source : asset.source);
            if (bytes.length > 32 * 1024 ** 2) throw new Error(`插件资产超过32MiB：${asset.fileName}`);
            return { path: asset.fileName, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: mimeTypes[extname(asset.fileName)] ?? "application/octet-stream", size: bytes.length };
          });
          if (assets.reduce((sum, asset) => sum + asset.size, 0) > 64 * 1024 ** 2) throw new Error("插件资产合计超过64MiB");
          installPackage = { manifest, source: module.code, assets };
          this.emitFile({ type: "asset", fileName: "manifest.json", source: `${JSON.stringify(manifest, null, 2)}\n` });
        },
        async writeBundle() {
          await mkdir(output, { recursive: true });
          await writeAtomic(resolve(output, "install.json"), `${JSON.stringify(installPackage)}\n`);
        },
      },
    ],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: output, emptyOutDir: true, sourcemap: false, cssCodeSplit: true, minify: true, assetsInlineLimit: 0,
      lib: { entry: entryName, formats: ["es"], fileName: () => "index.js" },
      rolldownOptions: {
        input: entryName,
        external: ["/pluginSdk.js"],
        output: { entryFileNames: "index.js", chunkFileNames: "assets/c[hash].js", assetFileNames: "assets/a[hash][extname]", preserveModules: false, hashCharacters: "hex", exports: "default" },
      },
    },
    worker: { format: "iife" },
  });
}
