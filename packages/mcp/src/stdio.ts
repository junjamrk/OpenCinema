#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { constants, open } from "@toonflow/file";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { readRuntimeInfo } from "./runtimeInfo";

async function readWidgetCatalog(path: string) {
  if (!isAbsolute(path)) throw new Error("Widget 资源目录必须使用绝对路径");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let catalog: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 ** 2) throw new Error("Widget 资源目录须为64MiB以内的文件");
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("Widget 资源目录在读取期间变化");
    try { catalog = JSON.parse(bytes.subarray(0, offset).toString("utf8")); }
    catch { throw new Error("Widget 资源目录格式无效"); }
  } finally { await handle.close(); }
  const result = z.object({
    contents: z.array(z.object({ uri: z.string().startsWith("ui://"), mimeType: z.string().startsWith("text/html"), text: z.string().min(1), _meta: z.record(z.string(), z.unknown()).optional() }).passthrough()).min(1).max(16),
    tools: z.array(z.object({ name: z.string().min(1).max(128), description: z.string().min(1), inputSchema: z.object({ type: z.literal("object") }).passthrough() }).passthrough()).max(300).default([]),
    renderToolMeta: z.object({ ui: z.object({ resourceUri: z.string() }).passthrough(), "ui/resourceUri": z.string(), "openai/outputTemplate": z.string() }).passthrough(),
  }).safeParse(catalog);
  if (!result.success) throw new Error("Widget 资源或工具目录无效");
  const value = result.data, uri = value.contents[0]!.uri;
  if (new Set(value.contents.map(item => item.uri)).size !== value.contents.length || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length
    || value.renderToolMeta.ui.resourceUri !== uri || value.renderToolMeta["ui/resourceUri"] !== uri || value.renderToolMeta["openai/outputTemplate"] !== uri) {
    throw new Error("Widget 资源声明不一致或目录重复");
  }
  return value;
}

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: "string" },
    "token-env": { type: "string", default: "TOONFLOW_MCP_TOKEN" },
    runtime: { type: "string" },
    "widget-resource": { type: "string" },
    help: { type: "boolean" },
  } });
  if (values.help) {
    process.stderr.write("opencinema-mcp --url <MCP URL> --token-env <环境变量名>\nopencinema-mcp --runtime <运行信息文件> [--widget-resource <Widget资源目录文件>]\n");
    return;
  }
  if (Boolean(values.url) === Boolean(values.runtime)) throw new Error("请指定 --url 或 --runtime，二者只能选择一个");
  if (values["widget-resource"] && !values.runtime) throw new Error("--widget-resource 必须与 --runtime 一起使用");
  const widget = values["widget-resource"] ? await readWidgetCatalog(values["widget-resource"]) : undefined;
  let widgetRuntimeRevision: string | undefined;
  async function readSettings() {
    let endpoint = values.url;
    let token = process.env[values["token-env"]];
    let pid: number | undefined;
    if (values.runtime) {
      const runtime = await readRuntimeInfo(values.runtime);
      if (widget) {
        if (!runtime.revision) throw new Error("Widget 后端缺少构建标识，请通过插件启动器重新连接");
        if (widgetRuntimeRevision !== undefined && runtime.revision !== widgetRuntimeRevision) throw new Error("Widget 后端版本已变化，请重新连接插件，由启动器核验兼容版本");
        widgetRuntimeRevision = runtime.revision;
      }
      endpoint = runtime.url;
      token = runtime.token;
      pid = runtime.pid;
    }
    if (!token) throw new Error(`未找到 MCP 访问凭证，请设置 ${values["token-env"]}`);
    let url: URL;
    try { url = new URL(endpoint!); }
    catch { throw new Error("MCP URL 无效"); }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!(["http:", "https:"].includes(url.protocol)) || url.protocol === "http:" && !local) {
      throw new Error("远程 MCP 必须使用 HTTPS；本机连接允许 HTTP");
    }
    if (url.username || url.password) throw new Error("MCP URL 不允许包含账号或密码");
    return { url, token, pid };
  }

  type Connection = { settings: Awaited<ReturnType<typeof readSettings>>; client: Client; transport: StreamableHTTPClientTransport };
  let connection: Connection | undefined;
  let reconnectQueue = Promise.resolve();
  let closing = false;
  const servers = new Set<McpServer>();

  async function getClient(signal?: AbortSignal) {
    const operation = reconnectQueue.then(async () => {
      signal?.throwIfAborted();
      if (closing) throw new Error("OpenCinema MCP 连接正在关闭");
      const settings = await readSettings();
      if (connection && connection.settings.url.href === settings.url.href && connection.settings.token === settings.token && connection.settings.pid === settings.pid) return connection.client;
      const previous = connection;
      connection = undefined;
      await previous?.client.close().catch(() => {});
      const transport = new StreamableHTTPClientTransport(settings.url, {
        requestInit: { headers: { Authorization: "Bearer " + settings.token } },
      });
      const client = new Client({ name: "OpenCinema Studio stdio", version: "0.4.0" });
      try {
        await client.connect(transport);
        if (!client.getServerCapabilities()?.tools) throw new Error("目标服务未提供 MCP 工具");
        if (closing) throw new Error("OpenCinema MCP 连接正在关闭");
        connection = { settings, client, transport };
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
      await Promise.allSettled([...servers].map(async server => {
        if (!server.isConnected()) { servers.delete(server); return; }
        await server.server.sendToolListChanged();
        if (widget || client.getServerCapabilities()?.resources) await server.server.sendResourceListChanged();
      }));
      return client;
    });
    reconnectQueue = operation.then(() => {}, () => {});
    const client = await operation;
    signal?.throwIfAborted();
    return client;
  }

  // ACT: 只串行核对运行信息与重连；业务请求仍可并发，已发出请求失败时不重试。
  async function forward<T>(signal: AbortSignal, operation: (client: Client) => Promise<T>) {
    return operation(await getClient(signal));
  }

  const initialClient = await getClient();
  const resources = widget || initialClient.getServerCapabilities()?.resources;
  const bridge = serveStdio(() => {
    const server = new McpServer({ name: "OpenCinema Studio", version: "0.4.0" }, {
      capabilities: { tools: { listChanged: true }, ...(resources ? { resources: { subscribe: false, listChanged: true } } : {}) },
      instructions: initialClient.getInstructions(),
    });
    servers.add(server);
    server.server.setRequestHandler("tools/list", async (request, context) => {
      const result = await forward(context.mcpReq.signal, client => client.listTools(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
      if (!widget) return result;
      return { ...result, tools: result.tools.map(tool => {
        if (tool.name !== "renderOpenCinema") return tool;
        const ui = tool._meta?.ui;
        return { ...tool, _meta: { ...tool._meta, ui: { ...(ui && typeof ui === "object" && !Array.isArray(ui) ? ui : {}), resourceUri: widget.renderToolMeta.ui.resourceUri }, "ui/resourceUri": widget.renderToolMeta["ui/resourceUri"], "openai/outputTemplate": widget.renderToolMeta["openai/outputTemplate"] } };
      }) };
    });
    server.server.setRequestHandler("tools/call", (request, context) => forward(context.mcpReq.signal,
      client => client.callTool(request.params, { signal: context.mcpReq.signal, timeout: 30 * 60_000 })));
    if (resources) {
      server.server.setRequestHandler("resources/list", async (request, context) => {
        context.mcpReq.signal.throwIfAborted();
        if (widget) return { resources: widget.contents.map(item => ({ uri: item.uri, name: "OpenCinema", title: "OpenCinema 原生创作工作台", mimeType: item.mimeType, ...(item._meta ? { _meta: item._meta } : {}) })) };
        return forward(context.mcpReq.signal, client => client.listResources(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
      });
      server.server.setRequestHandler("resources/read", async (request, context) => {
        context.mcpReq.signal.throwIfAborted();
        const content = widget?.contents.find(item => item.uri === request.params.uri);
        if (content) return { contents: [content] };
        return forward(context.mcpReq.signal, client => client.readResource(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
      });
      server.server.setRequestHandler("resources/templates/list", (request, context) => forward(context.mcpReq.signal,
        client => client.listResourceTemplates(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" })));
    }
    return server;
  }, { onerror: error => console.error(error.message) });
  const close = async () => {
    if (closing) return;
    closing = true;
    await bridge.close();
    await reconnectQueue;
    const active = connection;
    connection = undefined;
    await active?.transport.terminateSession().catch(() => console.error("OpenCinema MCP 会话结束失败"));
    await active?.client.close();
    servers.clear();
  };
  process.stdin.once("end", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
