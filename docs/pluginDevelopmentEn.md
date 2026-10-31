# Plugin development guide

Every OpenCinema node is a plugin: one package that exports a plugin definition, registers Zod-typed tools and ships a React view. Built-in nodes, third-party nodes and nodes from the plugin market all go through the same path; there is no privileged API. This guide covers the conventions, the contract and how to publish. 中文版见 [pluginDevelopment.md](pluginDevelopment.md)。

## Design principles

The Unix philosophy, applied to a canvas:

| Principle | What it means for a node |
| --- | --- |
| Do one thing well | One node, one job. Viewing a scan is one node; generating video is another. Compose with edges, not with mode switches. |
| Compose through streams (here: typed ports) | Nodes only exchange port values: `STRING`, `INT`, `FLOAT`, `BOOLEAN`, `IMAGE`, `VIDEO`, `AUDIO`, `FILE`, `MASK`. Media values are `{ url, mimeType }` with a workspace-relative path, never a Blob. |
| Make everything scriptable | Every capability is a tool: Zod input, Zod output, side-effect annotations. The button in the UI calls the same function the agent calls. |
| Silence is golden | Read tools change nothing; write tools return the new revision; failures throw errors with a code and a recovery action, and never leave half-finished state. |
| Reliability over cleverness | No silent retries, no silent downgrades, no model swaps. Long work returns a `taskId` first; a status tool reports the real terminal state. |

Agent-friendly specifics:

- **Small verb tools**: `get*` reads, `set*` changes, `run*` / a verb does the work, `get*Status` reports progress, `cancel*` stops. Lower camel case, 1 to 64 characters.
- **Descriptions written for the caller**: one sentence on what it does, its preconditions, what it returns and what it does not do. Parameter and result names in the text must match the schema.
- **Honest `annotations`**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` decide whether the agent needs an outer `operationId` and a confirmation.
- **Typed output**: `outputSchema` lets the host validate the result and the agent parse it.
- **Revision guards**: write tools accept an optional `expectedRevision` (the canvas `documentRevision`) and check it with `workbench.assertWritable(expectedRevision)`; long tasks write with the revision current at completion.
- **An `agent.md`**: the operating order and the limits, written for agents and shipped in the manifest. Agents read it as `agentGuide` from `getPluginConfiguration({ pluginId })`.

## Start from scratch

```bash
bun packages/nodeScaffold/scripts/createNode.ts depthSliceNode "Depth slice" --description "Split a depth map into near, mid and far masks."
bun install
cd packages/nodes/depthSliceNode && bun run typecheck && bun run build
```

The scaffold produces:

```
packages/nodes/depthSliceNode/
├── package.json        depends on @toonflow/nodes-scaffold, @toonflow/node-shared, zod
├── tsconfig.json
├── viteConfig.ts       createNodeConfig(...): id, display name, description, license, tags, capabilities, output directory
├── readme.md           for people; becomes manifest.readme
├── agent.md            for agents; becomes manifest.agentGuide (≤ 16 KiB)
└── src/
    ├── reactPlugin.ts  NodePluginDefinition: createData, activate, registerTool
    └── reactView.tsx   the React view rendered inside the node
```

`--out <dir>` places the plugin outside the repository; dependencies then point at this repository's `packages/nodeScaffold` and `packages/nodeShared` with `file:` paths and the build goes to `./dist`.

## The plugin definition

```ts
const plugin: NodePluginDefinition<typeof View> = {
  apiVersion: 1, id: "depthSliceNode", name: "Depth slice", version: "0.1.0", renderer: "react", icon: "image", view: View,
  createData: () => ({ label: "Depth slice", handles: [
    { id: "depth", type: "target", dataType: "IMAGE", label: "Depth map" },
    { id: "near", type: "source", dataType: "MASK", label: "Near mask" },
  ], outputs: {} }),
  activate(context) {
    const { id, document, workbench } = pluginServices(context);
    context.registerTool({ name: "getState", /* … */ });
    context.registerTool({ name: "slice", /* … */ });
    context.onDispose(() => { /* release workers, WebGL, object URLs */ });
  },
};
export default plugin;
```

`activate` runs once per node instance. Its `context` provides:

| Member | Purpose |
| --- | --- |
| `getService("document")` | read a node, read the revision, `updateData` (enters history), `updateRuntimeData` (runtime state, no history), `save` |
| `getService("workbench")` | `files` (workspace files), `getInputs(handle)`, `updateData`, `createNodes`, `ffmpeg()`, `hostRequest()`, `assertWritable()` |
| `registerTool(definition)` | publish a tool; returns an unregister function |
| `onBeforeChange(prepare)` | abort work before the node enters a history operation or is deleted |
| `onDispose(dispose)` | release resources when the node unloads or the plugin is disabled |
| `signal` | the plugin lifetime signal |
| `config` / `capabilities` | user configuration (per `configRules`) and host capability versions |

Data model conventions:

- State that belongs in history (sources, parameters, a camera) lives at the top level of `data` and is written with `workbench.updateData`.
- Runtime state (progress, `taskId`, errors) is written with `workbench.updateRuntimeData`; after a reload the status tool decides whether a task was interrupted.
- Outputs go to `assets/<nodeId>/` (`uploadNodeFile` handles the directory and a random file name); ports are `outputs.<handle> = { dataType, value }`.
- Write `null` to clear a key; drop running task state in `cloneData` so a duplicated node never pretends to be busy.

## Long-running work

Synchronous tools time out after 120 seconds by default. Anything longer follows this pattern:

1. `run*` validates its input, acquires dependencies up front (for example `await workbench.ffmpeg()` before queuing, so a missing FFmpeg fails immediately), creates a `taskId` and returns `{ status: "queued", taskId, executionSettled: false }` at once.
2. The task progresses in the background and writes `status: "running"`, `phase` and `progress` with `updateRuntimeData`.
3. `get*Status` returns the real state; `running` without a live task after a reload is reported as `interrupted`.
4. `cancel*` aborts an `AbortController`; the task cleans up its temporary directory itself. While an encoder has not confirmed exit, temporary files are kept rather than deleted under a process that may still read them.

`renderTurntable` / `getRenderStatus` / `cancelRender` in the [Gaussian Splat node](../packages/nodes/gaussianSplatNode/src/reactPlugin.ts) are a complete example.

## The view

The view is a plain React component with `NodeViewProps`: `node` (`id`, `data`), `controller`, `readOnly`. `controller.callNodeTool(node.id, name, args)` calls this node's tools, `controller.getNodeService(node.id)` returns the workbench service, `controller.acquireMedia(path)` exchanges a path for a temporary URL. The class names from `@toonflow/node-shared/nodeControls` (`nodeControls`, `nodeActions`, `nodePrimary`, `nodeStatus`, `nodeError`, `nodeUploadArea`) give you the workbench look; interactive canvas areas get `nodrag nopan nowheel`.

React, react-dom and zod come from the host through `/pluginSdk.js` and are not bundled; specialised dependencies such as three.js or WASM are bundled into the ESM or shipped as package assets.

## Manifest and install package

`createNodeConfig` accepts:

| Field | Meaning |
| --- | --- |
| `name` | plugin id, lower camel case; also the node type |
| `displayName`, `author`, `github` | basic information |
| `description` | one sentence; shown in the node menu, the market and the agent's `availableNodeTypes` |
| `license`, `homepage`, `tags` | SPDX license, homepage, lowercase tags (`3d`, `analysis`, `generation` also drive the node menu category) |
| `requires` | host capability versions, e.g. `{ workspaceFiles: 1, ffmpeg: 1, worker: 1 }` |
| `configRules` | user settings; agents read and write non-secret fields through `getPluginConfiguration` / `setPluginConfiguration` |
| `resources` | large files shipped with the package (models, WASM) with SHA-256 |
| `outDir` | output directory; in-repo default is `build/nodes/<id>`, third-party plugins set their own |

The build writes `index.js`, `manifest.json` and `install.json`. `install.json` is the install package, `{ manifest, source, assets[] }` with a SHA-256 per asset; the JSON Schema is [installPackage.schema.json](../packages/nodeScaffold/schema/installPackage.schema.json). Install paths:

- Settings → Plugins → Install plugin package (a local file);
- Settings → Plugins → Plugin market (a static catalog, downloaded and verified by SHA-256);
- agents: `reviewPluginPackage` / `installPluginPackage` (a file inside the project) or `getPluginMarket` / `installMarketplacePlugin` (the market).

Installed plugins are served by the local Go server from a versioned directory; the web app loads them through an import map and shares its React and zod instances.

## Publishing to the plugin market

The market is a static catalog under [opencinema.site/market](https://opencinema.site/market/). It is install-only for now; there is no upload. To publish a version:

1. Build the plugin and confirm `install.json` is in the `outDir` you declared.
2. Add an entry to `site/src/marketCatalog.json`: `id`, `source` (path of the install.json relative to the repository root), English and Chinese `description`, `homepage`, `repository`, `publishedAt`.
3. Run `node site/build.mjs`. It copies the package to `site/market/plugins/<id>/<version>/install.json`, computes SHA-256 and size, and rewrites `site/market/index.json` and the market pages. A version is never overwritten with different bytes: bump the version instead.
4. Open a pull request. The index format is [marketIndex.schema.json](../packages/nodeScaffold/schema/marketIndex.schema.json).

## Checklist

- [ ] One node, one job; accurate port types; `canConnect` only where types cannot express the rule.
- [ ] Every tool: a small verb name, an accurate description, Zod input and output, honest `annotations`.
- [ ] Write tools honor `expectedRevision`; long tasks use the queued pattern and can be cancelled.
- [ ] Failures leave nothing half-done; temporary files are cleaned up; `onDispose` releases everything.
- [ ] `readme.md` for people, `agent.md` for agents; third-party licenses ship in `licenses/`.
- [ ] `bun run typecheck` and `bun run build` pass; you installed and operated the node in the workbench once.
