import { z } from "zod";
import { disposeModel, loadModel, maximumModelBytes } from "./model";
import { readStagePreset, type StagePresetPayload } from "./stagePresets";

const libraryPath = "blockoutPresets";
const maximumAssetBytes = 100 * 1024 * 1024;
const presetId = z.string().regex(/^[0-9a-f]{32}$/);
const modelFile = z.string().regex(/^model[0-9a-f]{32}\.glb$/);
const modelRecord = z.strictObject({
  file: modelFile,
  path: z.string(),
  bytes: z.int().positive().max(maximumModelBytes),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const recordSchema = z.strictObject({
  id: presetId,
  name: z.string().min(1),
  savedAt: z.iso.datetime(),
  entityCount: z.int().nonnegative().max(200),
  takeCount: z.int().min(1).max(100),
  payload: z.unknown(),
  models: z.array(modelRecord).max(200),
});
type StagePresetRecord = Omit<z.infer<typeof recordSchema>, "payload"> & {
  payload: StagePresetPayload;
};
type LibraryError = Error & {
  status?: number;
  code?: string | number;
  responseCode?: number;
  unpublishedModelFiles?: string[];
};

export interface StagePresetSummary {
  id: string;
  name: string;
  savedAt: string;
  entityCount: number;
  takeCount: number;
  modelCount: number;
}

function recordPath(id: string) {
  return `${libraryPath}/preset${presetId.parse(id)}.json`;
}
function sharedModelPath(sha256: string) {
  return `${libraryPath}/models/model${sha256}.glb`;
}
function summary(record: StagePresetRecord): StagePresetSummary {
  const { id, name, savedAt, entityCount, takeCount, models } = record;
  return { id, name, savedAt, entityCount, takeCount, modelCount: models.length };
}
function asError(failure: unknown): LibraryError {
  return failure instanceof Error ? failure : new Error(String(failure));
}
function contextualError(failure: unknown, context: string, details: Record<string, unknown>) {
  const error = asError(failure);
  return Object.assign(new Error(`${error.message}\n${context}`, { cause: failure }), error, {
    name: error.name,
    message: `${error.message}\n${context}`,
    status: error.status,
    code: error.code,
    responseCode: error.responseCode,
    ...details,
  });
}

/** Bound actual streamed bytes as well as declared Content-Length. */
async function readBytes(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  let finished = false;
  try {
    signal?.throwIfAborted();
    if (Number(response.headers.get("content-length")) > maximumBytes)
      throw new Error(`素材超过 ${maximumBytes} 字节读取上限`);
    if (!reader) return new ArrayBuffer(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) {
        finished = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new Error(`素材超过 ${maximumBytes} 字节读取上限`);
      chunks.push(chunk.value);
    }
    const content = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return content.buffer;
  } catch (failure) {
    if (reader && !finished) {
      try {
        await reader.cancel(failure);
      } catch (cleanup) {
        Object.assign(asError(failure), { streamCleanupError: cleanup });
      }
    }
    throw failure;
  } finally {
    reader?.releaseLock();
  }
}

async function jsonResponse(response: Response, signal?: AbortSignal) {
  const bytes = await readBytes(response, maximumAssetBytes, signal);
  signal?.throwIfAborted();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let result: { code?: number; message?: string; data?: unknown };
  try {
    result = JSON.parse(text);
  } catch (failure) {
    if (!response.ok)
      throw Object.assign(new Error(text || response.statusText), { status: response.status });
    throw failure;
  }
  if (!response.ok || !result || result.code !== 200) {
    const data = result?.data as { code?: unknown } | undefined;
    throw Object.assign(
      new Error(
        typeof result?.message === "string"
          ? result.message
          : response.statusText || "全局素材请求失败",
      ),
      {
        status: response.status,
        responseCode: result?.code,
        ...(typeof data?.code === "string" ? { code: data.code } : {}),
      },
    );
  }
  return result.data;
}

async function request(path: string, init: RequestInit, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch(path, {
    ...init,
    signal,
    headers: { "x-toonflow-workspace": "1", ...init.headers },
  });
  signal?.throwIfAborted();
  return jsonResponse(response, signal);
}

async function readAsset(path: string, maximumBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch(`/api/assets/read?path=${encodeURIComponent(path)}`, {
    signal,
    headers: { "x-toonflow-workspace": "1" },
  });
  signal?.throwIfAborted();
  if (!response.ok) await jsonResponse(response, signal);
  const content = await readBytes(response, maximumBytes, signal);
  signal?.throwIfAborted();
  return content;
}

async function writeAsset(path: string, content: ArrayBuffer, signal?: AbortSignal) {
  if (content.byteLength > maximumAssetBytes) throw new Error("全局素材不能超过 100 MiB");
  await request(
    `/api/assets/save?path=${encodeURIComponent(path)}`,
    { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: content },
    signal,
  );
}

async function ensureDirectory(path: string, signal?: AbortSignal) {
  try {
    await request(
      "/api/assets/mkdir",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      },
      signal,
    );
  } catch (failure) {
    if (asError(failure).code !== "EEXIST") throw failure;
  }
  signal?.throwIfAborted();
}

async function sha256(content: ArrayBuffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", content);
  signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function validateModel(content: ArrayBuffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!content.byteLength || content.byteLength > maximumModelBytes)
    throw new Error("预设模型须为不超过 64 MiB 的闭包 GLB");
  // GLTFLoader cannot abort parsing: await settlement before releasing its own
  // resources, then honor cancellation before any following write/publication.
  const model = await loadModel(content);
  try {
    signal?.throwIfAborted();
  } finally {
    disposeModel(model.group);
  }
}

function parseRecord(value: unknown, id: string): StagePresetRecord {
  const record = recordSchema.parse(value),
    payload = readStagePreset(record.payload);
  if (
    record.id !== id ||
    record.name !== payload.name ||
    record.entityCount !== payload.entities.length ||
    record.takeCount !== payload.blocking.length
  )
    throw new Error("预设记录身份、名称或数量与内容不一致");
  const references = new Set(
    payload.entities.flatMap((entity) => (entity.sourceFile ? [entity.sourceFile] : [])),
  );
  const files = new Set<string>();
  for (const model of record.models) {
    if (
      files.has(model.file) ||
      !references.has(model.file) ||
      model.path !== sharedModelPath(model.sha256)
    )
      throw new Error("预设模型清单包含重复、未引用或越界资源");
    files.add(model.file);
  }
  if (files.size !== references.size) throw new Error("预设模型引用没有完整的大小与 SHA-256 清单");
  return { ...record, payload };
}

async function readRecord(id: string, signal?: AbortSignal) {
  const content = await readAsset(recordPath(id), maximumAssetBytes, signal);
  signal?.throwIfAborted();
  return parseRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)), id);
}

export async function listStagePresets(signal?: AbortSignal) {
  const presets: StagePresetSummary[] = [];
  const errors: { path: string; message: string }[] = [];
  let value: unknown;
  try {
    value = await request(
      `/api/assets/list?path=${libraryPath}&recursive=false`,
      { method: "GET" },
      signal,
    );
  } catch (failure) {
    if (asError(failure).code === "ENOENT") return { presets, errors };
    throw failure;
  }
  signal?.throwIfAborted();
  const { entries } = z
    .object({
      entries: z.array(
        z.object({ name: z.string(), path: z.string(), type: z.enum(["file", "directory"]) }),
      ),
    })
    .parse(value);
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.type !== "file") continue;
    const match = /^preset([0-9a-f]{32})\.json$/.exec(entry.name);
    if (!match || entry.path !== `${libraryPath}/${entry.name}`) {
      errors.push({ path: entry.path, message: "预设记录文件名或目录无效" });
      continue;
    }
    // ACT: sequential reads retain only summaries, not every potentially large
    // payload or model. A corrupt record is visible; network/permission errors fail.
    const content = await readAsset(entry.path, maximumAssetBytes, signal);
    signal?.throwIfAborted();
    try {
      presets.push(
        summary(
          parseRecord(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)),
            match[1],
          ),
        ),
      );
    } catch (failure) {
      errors.push({ path: entry.path, message: asError(failure).message });
    }
  }
  return {
    presets: presets.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id)),
    errors,
  };
}

export async function saveStagePreset(
  value: StagePresetPayload,
  readModel: (sourceFile: string) => Promise<ArrayBuffer>,
  signal?: AbortSignal,
  check: () => void = () => {},
): Promise<StagePresetSummary> {
  signal?.throwIfAborted();
  const payload = readStagePreset(value);
  const id = crypto.randomUUID().replaceAll("-", ""),
    path = recordPath(id);
  const models: z.infer<typeof modelRecord>[] = [];
  let publicationAttempted = false;
  try {
    check();
    await ensureDirectory(libraryPath, signal);
    signal?.throwIfAborted();
    const references = new Set(
      payload.entities.flatMap((entity) => (entity.sourceFile ? [entity.sourceFile] : [])),
    );
    if (references.size) {
      check();
      await ensureDirectory(`${libraryPath}/models`, signal);
      signal?.throwIfAborted();
    }
    for (const file of references) {
      modelFile.parse(file);
      signal?.throwIfAborted();
      const content = await readModel(file);
      signal?.throwIfAborted();
      await validateModel(content, signal);
      signal?.throwIfAborted();
      const digest = await sha256(content, signal);
      signal?.throwIfAborted();
      const modelPath = sharedModelPath(digest);
      try {
        check();
        await writeAsset(modelPath, content, signal);
        signal?.throwIfAborted();
      } catch (failure) {
        if (asError(failure).code !== "EEXIST") throw failure;
        const existing = await readAsset(modelPath, maximumModelBytes, signal);
        signal?.throwIfAborted();
        if (
          existing.byteLength !== content.byteLength ||
          (await sha256(existing, signal)) !== digest
        )
          throw Object.assign(
            new Error(`${asError(failure).message} 已有共享模型的大小或 SHA-256 不匹配，未覆盖。`, {
              cause: failure,
            }),
            { status: asError(failure).status, code: asError(failure).code },
          );
        signal?.throwIfAborted();
      }
      models.push({ file, path: modelPath, bytes: content.byteLength, sha256: digest });
    }
    const record: StagePresetRecord = {
      id,
      name: payload.name,
      savedAt: new Date().toISOString(),
      entityCount: payload.entities.length,
      takeCount: payload.blocking.length,
      payload,
      models,
    };
    const content = new TextEncoder().encode(JSON.stringify(record)).buffer;
    if (content.byteLength > maximumAssetBytes) throw new Error("预设记录超过 100 MiB，未发布记录");
    signal?.throwIfAborted();
    check();
    publicationAttempted = true;
    await writeAsset(path, content, signal);
    // A confirmed final acknowledgement is publication, even if cancellation
    // arrives just afterward. Never retry or delete shared blobs on an unknown result.
    return summary(record);
  } catch (failure) {
    throw contextualError(
      failure,
      `${publicationAttempted ? "预设记录发布结果未确认，请只读复核，不要自动重发" : "预设记录尚未发布"}：presetId=${id}，recordPath=${path}。共享模型已保留。`,
      { presetId: id, recordPath: path, publicationUncertain: publicationAttempted },
    );
  }
}

export async function loadStagePreset(
  id: string,
  writeModel: (content: ArrayBuffer) => Promise<string>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const record = await readRecord(presetId.parse(id), signal);
  signal?.throwIfAborted();
  const modelFiles: string[] = [];
  try {
    const remapped = new Map<string, string>();
    for (const model of record.models) {
      const content = await readAsset(model.path, maximumModelBytes, signal);
      signal?.throwIfAborted();
      if (content.byteLength !== model.bytes || (await sha256(content, signal)) !== model.sha256)
        throw new Error(`预设模型大小或 SHA-256 不匹配：${model.path}`);
      signal?.throwIfAborted();
      await validateModel(content, signal);
      signal?.throwIfAborted();
      const file = await writeModel(content);
      // Register the returned real file before cancellation/validation can fail.
      modelFiles.push(file);
      signal?.throwIfAborted();
      modelFile.parse(file);
      if (modelFiles.slice(0, -1).includes(file))
        throw new Error("节点模型回调返回了重复文件名，未发布预设");
      remapped.set(model.file, file);
    }
    const payload = readStagePreset({
      ...record.payload,
      entities: record.payload.entities.map((entity) =>
        entity.sourceFile ? { ...entity, sourceFile: remapped.get(entity.sourceFile)! } : entity,
      ),
    });
    signal?.throwIfAborted();
    return { preset: payload, record: summary(record), modelFiles };
  } catch (failure) {
    const error = asError(failure);
    const unpublishedModelFiles = [
      ...new Set([...(error.unpublishedModelFiles ?? []), ...modelFiles]),
    ];
    throw contextualError(
      failure,
      `预设未应用：presetId=${record.id}，recordPath=${recordPath(record.id)}。${unpublishedModelFiles.length ? `未发布的节点模型文件已保留：${unpublishedModelFiles.join("、")}` : "没有已确认复制成功的节点模型文件。"}`,
      { presetId: record.id, recordPath: recordPath(record.id), unpublishedModelFiles },
    );
  }
}

export async function removeStagePreset(
  id: string,
  signal?: AbortSignal,
  check: () => void = () => {},
): Promise<void> {
  const path = recordPath(id);
  signal?.throwIfAborted();
  try {
    check();
    await request(
      "/api/assets/remove",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      },
      signal,
    );
  } catch (failure) {
    throw contextualError(
      failure,
      `预设记录删除未确认，请只读刷新复核：presetId=${id}，recordPath=${path}。共享模型未删除。`,
      { presetId: id, recordPath: path, removalUncertain: true },
    );
  }
  // Shared content-addressed models deliberately remain: other records and
  // previously applied nodes may still depend on them. This API does not run GC.
}
