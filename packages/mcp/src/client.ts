import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

const textSchema = z.string().max(8192).refine(value => !value.includes("\0"), "不能包含空字符");
const valuesSchema = z.record(z.string().min(1).max(256), textSchema);
const serverFields = {
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
};
const urlSchema = z.url().max(8192).refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "MCP 地址必须是 HTTP 或 HTTPS，账号和密码请填写到请求头");

export const mcpServerSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...serverFields, transport: z.literal("stdio"),
    command: textSchema.refine(value => !!value.trim(), "请填写启动命令"),
    args: z.array(textSchema).max(256).optional(),
    env: valuesSchema.refine(values => Object.keys(values).every(key => !/[=\0]/.test(key)), "环境变量名称无效").optional(),
    cwd: textSchema.optional(),
  }),
  z.strictObject({
    ...serverFields, transport: z.enum(["http", "sse"]),
    url: urlSchema,
    headers: valuesSchema.refine(values => {
      try { new Headers(values); return true; } catch { return false; }
    }, "请求头名称或内容无效").optional(),
  }),
]);

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type SavedMcpServer = McpServerConfig & { id: string };

export function getMcpError(error: unknown, server: McpServerConfig) {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = Object.values(server.transport === "stdio" ? server.env ?? {} : server.headers ?? {});
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
    const token = secret.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1];
    if (token) message = message.replaceAll(token, "[REDACTED]");
  }
  return message.replace(/https?:\/\/[^\s"'<>]+/g, value => {
    try { const url = new URL(value); url.search = ""; url.hash = ""; return url.href; } catch { return value; }
  }).slice(0, 2000);
}

export async function connectMcpServer(server: McpServerConfig) {
  const transport = server.transport === "stdio"
    ? new StdioClientTransport({ command: server.command, args: server.args, env: server.env, cwd: server.cwd || undefined, stderr: "pipe" })
    : server.transport === "sse"
      ? new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
      : new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  let stderr = "";
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-2000); });
  }
  const client = new Client({ name: "OpenCinema Studio", version: "0.4.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = async () => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (transport instanceof StreamableHTTPClientTransport) {
        await Promise.race([
          transport.terminateSession().catch(() => {}),
          new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 1000); }),
        ]);
      }
    } finally {
      clearTimeout(closeTimer);
      await client.close();
    }
  };
  try {
    await Promise.race([
      client.connect(transport, { timeout: 15_000 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MCP 连接超时（15 秒），请检查启动命令或服务地址")), 15_000);
      }),
    ]);
    return { client, close };
  } catch (error) {
    await client.close().catch(() => {});
    const message = getMcpError(error, server);
    throw new Error(`${message}${stderr.trim() ? `\n${getMcpError(stderr.trim(), server)}` : ""}`);
  } finally {
    clearTimeout(timer);
  }
}
