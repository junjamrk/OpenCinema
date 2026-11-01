import axios from "axios";
import { z } from "zod";
import { ToolExecutionError, toolErrorDetailsSchema } from "@toonflow/nodes-scaffold/toolErrors";
import { explainRequestError } from "./workspaceFileClient";

export type AssetLibraryEntry = { name: string; path: string; type: "file" | "directory"; children?: AssetLibraryEntry[] };
const assetEntrySchema: z.ZodType<AssetLibraryEntry> = z.lazy(() => z.object({ name: z.string(), path: z.string(), type: z.enum(["file", "directory"]), children: z.array(assetEntrySchema).optional() }));
const assetInfoSchema = z.object({ path: z.string(), type: z.enum(["file", "directory"]), size: z.number().int().nonnegative(), fileRevision: z.string().regex(/^[a-f0-9]{64}$/) });
const client = axios.create({ baseURL: "/api/assets", headers: { "x-toonflow-workspace": "1" } });
client.interceptors.response.use(undefined, explainRequestError);
export const assetDragType = "application/toonflow-asset";

async function resourceRequest<T>(request: Promise<T>): Promise<T> {
  try { return await request; }
  catch (error) {
    if (axios.isAxiosError(error)) {
      let response = error.response?.data;
      if (response instanceof Blob) try { response = JSON.parse(await response.text()); } catch { /* 非JSON失败保留原HTTP错误。 */ }
      const details = toolErrorDetailsSchema.safeParse(response?.data?.errorDetails);
      if (details.success) throw new ToolExecutionError(details.data);
      if (response?.data?.code === "ESTALE") throw new ToolExecutionError({ code: "revisionConflict", message: "素材已变化，请重新读取素材版本", phase: "target", executionState: "notDispatched", recovery: { action: "readState", message: "重新读取素材fileRevision并确认操作", tool: "getAssetInfo" } });
    }
    throw error;
  }
}

export const assetLibraryClient = {
  async list(signal?: AbortSignal) {
    const { data } = await resourceRequest(client.get("/list", { params: { path: "." }, signal }));
    return z.array(assetEntrySchema).parse(data.data?.entries);
  },
  async stat(path: string, signal?: AbortSignal) {
    const { data } = await resourceRequest(client.get("/stat", { params: { path }, signal }));
    return assetInfoSchema.parse(data.data);
  },
  async read(path: string, signal?: AbortSignal, revision?: string) {
    const response = await resourceRequest(client.get<Blob>("/read", { params: { path, revision }, responseType: "blob", signal }));
    if (revision && response.headers["x-toonflow-file-revision"] !== revision) throw new Error("素材读取未返回所需fileRevision，请更新服务端");
    return response.data;
  },
  async readFile(path: string, signal?: AbortSignal, revision?: string) {
    const content = await assetLibraryClient.read(path, signal, revision);
    return new File([content], path.split("/").at(-1)!, { type: content.type });
  },
  async save(path: string, content: Blob | ArrayBuffer, signal?: AbortSignal) {
    if ((content instanceof ArrayBuffer ? content.byteLength : content.size) > 100 * 1024 ** 2) throw new Error("素材库写入上限为100MiB");
    await resourceRequest(client.put("/save", content, { params: { path, exclusive: true }, signal, headers: { "Content-Type": "application/octet-stream" } }));
  },
  async mkdir(path: string) { await resourceRequest(client.post("/mkdir", { path })); },
  async rename(path: string, target: string, expectedRevision: string) { await resourceRequest(client.post("/rename", { path, target, expectedRevision })); },
  async remove(path: string, expectedRevision: string) { await resourceRequest(client.delete("/remove", { data: { path, expectedRevision } })); },
};

export function assetMediaKind(name: string) {
  if (/\.(avif|apng|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(name)) return "image";
  if (/\.(mp3|wav|ogg|opus|flac|m4a|aac)$/i.test(name)) return "audio";
  if (/\.(mp4|m4v|webm|mov|mkv|avi|ogv)$/i.test(name)) return "video";
}
