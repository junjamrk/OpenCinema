import { z } from "zod";

export const nodeResourceSchema = z.strictObject({
  version: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(128),
  license: z.string().min(1).max(128),
  source: z.url().max(4096),
  size: z.number().int().positive().max(32 * 1024 ** 2),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const nodeResourceManifestSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), nodeResourceSchema)
  .refine(value => Object.keys(value).length <= 16 && Object.values(value).reduce((size, item) => size + item.size, 0) <= 64 * 1024 ** 2, "插件资源最多16份、解压合计64MiB");
export type NodeResource = z.infer<typeof nodeResourceSchema>;
export type NodeResourceBundle = { manifest: Record<string, NodeResource>; content: Record<string, string> };

export function createNodeResources(bundle: NodeResourceBundle | undefined, lifetime: AbortSignal) {
  const manifest = nodeResourceManifestSchema.parse(bundle?.manifest ?? {});
  // ACT: 不缓存解压后的模型；调用方将缓冲转交Worker，退出即可释放，不跨插件/版本共享。
  return {
    manifest: Object.freeze(Object.fromEntries(Object.entries(manifest).map(([name, item]) => [name, Object.freeze(item)]))),
    async read(name: string, signal?: AbortSignal): Promise<ArrayBuffer> {
      const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      if (!Object.hasOwn(manifest, name)) throw new Error(`插件资源不存在：${name}`);
      const entry = manifest[name]!;
      const encoded = bundle?.content[name];
      if (typeof encoded !== "string" || encoded.length > 20 * 1024 ** 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`插件资源损坏：${name}`);
      const packed = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
      const content = new Uint8Array(entry.size);
      let position = 0;
      const cancel = () => { void reader.cancel(combined.reason).catch(() => {}); };
      combined.addEventListener("abort", cancel, { once: true });
      try {
        while (true) {
          combined.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          if (position + value.length > content.length) throw new Error(`插件资源超过声明大小：${name}`);
          content.set(value, position); position += value.length;
        }
        combined.throwIfAborted();
        if (position !== entry.size) throw new Error(`插件资源不完整：${name}`);
        const digest = await crypto.subtle.digest("SHA-256", content);
        combined.throwIfAborted();
        if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== entry.sha256) throw new Error(`插件资源校验失败：${name}`);
        return content.buffer;
      } finally { combined.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); }
    },
  };
}
