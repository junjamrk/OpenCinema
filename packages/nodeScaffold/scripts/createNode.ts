// Scaffold a new OpenCinema node plugin.
//   bun packages/nodeScaffold/scripts/createNode.ts <pluginId> "<显示名>" [--description "..."] [--author "..."] [--github https://github.com/...] [--out <dir>]
// The result compiles and installs as-is: one node, one responsibility, a couple of small verb tools.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((value, index) => !value.startsWith("--") && !args[index - 1]?.startsWith("--"));
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const [id, displayName] = positional;
if (!id || !displayName) {
  console.error('用法：bun packages/nodeScaffold/scripts/createNode.ts <pluginId> "<显示名>" [--description "..."] [--author "..."] [--github <url>] [--out <dir>]');
  process.exit(2);
}
if (!/^[a-z][a-zA-Z0-9]{0,95}$/.test(id)) throw new Error("pluginId 须为小驼峰，例如 depthSliceNode");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const target = resolve(option("out") ?? resolve(repositoryRoot, "packages/nodes", id));
if (existsSync(target)) throw new Error(`目录已存在：${target}`);
const insideRepository = !relative(repositoryRoot, target).startsWith("..");
const description = option("description") ?? `${displayName}：说明这个节点做的一件事。`;
const author = option("author") ?? "OpenCinema community";
const github = option("github") ?? "https://github.com/junjamrk/OpenCinema";
const packageName = `@opencinema/node-${id.replace(/([A-Z])/g, "-$1").toLowerCase()}`;
const workspaceDependency = (name: string) => insideRepository ? "workspace:*" : `file:${relative(target, resolve(repositoryRoot, "packages", name)).replaceAll("\\", "/")}`;

const files: Record<string, string> = {
  "package.json": `${JSON.stringify({
    name: packageName, version: "0.1.0", private: true, type: "module",
    scripts: { build: "vite build --config viteConfig.ts", dev: "vite build --watch --config viteConfig.ts", typecheck: "tsc --noEmit" },
    exports: { "./react": "./src/reactView.tsx", "./reactPlugin": "./src/reactPlugin.ts" },
    dependencies: { "@toonflow/node-shared": workspaceDependency("nodeShared"), "@toonflow/nodes-scaffold": workspaceDependency("nodeScaffold"), zod: "^4.6.2" },
    devDependencies: { "@types/react": "^19.0.0", typescript: "~6.0.3", vite: "^8.2.2" },
    peerDependencies: { react: "^19.0.0" },
  }, null, 2)}\n`,
  "tsconfig.json": `${JSON.stringify({ extends: insideRepository ? "../../../tsconfig.base.json" : `${relative(target, resolve(repositoryRoot, "tsconfig.base.json")).replaceAll("\\", "/")}`, compilerOptions: { lib: ["ESNext", "DOM", "DOM.Iterable"], types: ["vite/client"], jsx: "react-jsx" }, include: ["src", "viteConfig.ts"] }, null, 2)}\n`,
  "viteConfig.ts": `import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: ${JSON.stringify(id)}, displayName: ${JSON.stringify(displayName)}, author: ${JSON.stringify(author)}, github: ${JSON.stringify(github)},
  description: ${JSON.stringify(description)},
  license: "MIT", tags: ["example"],
  // 仓库内插件默认输出到 build/nodes/<id>；第三方插件请指定自己的目录。
  ${insideRepository ? `outDir: "../../../build/market/${id}",` : 'outDir: "./dist",'}
  requires: { workspaceFiles: 1, nodeHistory: 1 },
}, import.meta.url);
`,
  "src/reactPlugin.ts": `import { z } from "zod";
import type { NodePluginDefinition } from "@toonflow/nodes-scaffold/contracts";
import { pluginServices, readNodeData } from "@toonflow/node-shared/reactNode";
import NodeView from "./reactView";

// 一个节点只做一件事；每个工具是一个小动词：get 读状态、set 改状态、run 做事、cancel 取消。
const plugin: NodePluginDefinition<typeof NodeView> = {
  apiVersion: 1, id: ${JSON.stringify(id)}, name: ${JSON.stringify(displayName)}, version: "0.1.0", renderer: "react", view: NodeView,
  createData: () => ({ label: ${JSON.stringify(displayName)}, handles: [
    { id: "input", type: "target", dataType: "STRING", label: "输入文本" },
    { id: "output", type: "source", dataType: "STRING", label: "输出文本" },
  ], outputs: {} }),
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    context.registerTool({
      name: "getState", description: "读取节点当前的输入、输出与修订；不修改任何内容。",
      parameters: z.strictObject({}),
      outputSchema: z.strictObject({ input: z.string().nullable(), output: z.string().nullable(), revision: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute() {
        const input = workbench.getInputs("input")[0]?.value;
        const outputs = readNodeData(document, id).outputs as { output?: { value?: unknown } } | undefined;
        return { input: typeof input === "string" ? input : null, output: typeof outputs?.output?.value === "string" ? outputs.output.value : null, revision: document.getRevision() };
      },
    });
    context.registerTool({
      name: "run", description: "把上游文本转为大写并写入输出端口；纳入画布历史并保存。",
      parameters: z.strictObject({ expectedRevision: z.number().int().nonnegative().optional() }),
      outputSchema: z.strictObject({ output: z.string(), revision: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async execute(args, { signal }) {
        workbench.assertWritable(args.expectedRevision);
        const input = workbench.getInputs("input")[0]?.value;
        if (typeof input !== "string") throw new Error("请先连接一路 STRING 输入");
        const output = input.toUpperCase();
        await workbench.updateData({ outputs: { ...(readNodeData(document, id).outputs as object ?? {}), output: { dataType: "STRING", value: output } } }, args.expectedRevision, signal);
        await document.save();
        return { output, revision: document.getRevision() };
      },
    });
  },
};
export default plugin;
`,
  "src/reactView.tsx": `import { useState } from "react";
import { errorText, type NodeViewProps } from "@toonflow/node-shared/reactNode";
import "@toonflow/node-shared/nodeControls";

export default function NodeView({ node, controller, readOnly }: NodeViewProps) {
  const [error, setError] = useState("");
  const outputs = node.data?.outputs as { output?: { value?: unknown } } | undefined;
  const value = typeof outputs?.output?.value === "string" ? outputs.output.value : "";
  return <div className="nodeControls nodrag nopan nowheel">
    <div className="nodeActions"><button type="button" className="nodePrimary" disabled={readOnly} onClick={() => void controller.callNodeTool(node.id, "run", {}).then(() => setError("")).catch(reason => setError(errorText(reason)))}>运行</button></div>
    {value && <pre className="nodeReport">{value}</pre>}
    {error && <p className="nodeError" role="alert">{error}</p>}
  </div>;
}
`,
  "readme.md": `# ${displayName}

${description}

## 使用

1. 在画布中添加节点并连接输入。
2. 点击“运行”或让 Agent 调用 \`run\`。

## 边界

说明这个节点不做什么、依赖什么、输出保存在哪里。
`,
  "agent.md": `# ${displayName} · Agent 指南

- 先 \`getState\` 读取输入/输出与 revision，再决定是否 \`run\`。
- \`run\` 写入输出端口并保存，返回新的 revision；失败不会留下半成品。
- 本节点不调用模型、不访问网络。
`,
};
await mkdir(resolve(target, "src"), { recursive: true });
for (const [name, content] of Object.entries(files)) await writeFile(resolve(target, name), content, { flag: "wx" });
console.log(`已创建 ${relative(process.cwd(), target) || "."}\n下一步：\n  bun install\n  cd ${relative(process.cwd(), target) || "."} && bun run typecheck && bun run build\n产物 install.json 可从 设置 → 插件 → 安装插件包 安装，或发布到插件市场。`);
