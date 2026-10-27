export const fileMimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", apng: "image/apng", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", ogv: "video/ogg", mpeg: "video/mpeg", mpg: "video/mpeg",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", aif: "audio/aiff", aiff: "audio/aiff", au: "audio/basic", caf: "audio/x-caf",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", log: "text/plain", json: "application/json", xml: "application/xml", html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", ndjson: "application/x-ndjson",
  ts: "text/plain", jsx: "text/plain", tsx: "text/plain", cjs: "text/javascript", mjs: "text/javascript", cts: "text/plain", mts: "text/plain", yaml: "text/yaml", yml: "text/yaml", srt: "text/plain", vtt: "text/vtt",
};

export function inferMediaFileType(file: { name: string; type: string }) {
  const declared = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const mimeType = !declared || declared === "application/octet-stream" ? fileMimeTypes[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? declared : declared;
  const kind = /^(image|video|audio)\//.exec(mimeType)?.[1] ?? (/^text\//.test(mimeType) || /^application\/(json|xml|javascript|x-ndjson)$/.test(mimeType) ? "text" : "");
  return { mimeType, kind };
}
