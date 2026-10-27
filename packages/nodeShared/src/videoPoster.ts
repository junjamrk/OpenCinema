import { observeMediaError } from "./mediaError";

type VideoPoster = { url: string; width: number; height: number };
type PosterRequest = { controller: AbortController; users: number; settled: boolean; promise: Promise<VideoPoster> };
const posters = new Map<string, VideoPoster>();
const requests = new Map<string, PosterRequest>();
const pending: { begin(): void; cancel(): void }[] = [];
let decoding = 0;

function nextPoster() {
  while (decoding < 2 && pending.length) pending.shift()!.begin();
}

function waitForPosterSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const entry = {
      begin() {
        signal.removeEventListener("abort", entry.cancel); decoding++;
        resolve(() => { decoding--; nextPoster(); });
      },
      cancel() {
        const index = pending.indexOf(entry);
        if (index < 0) return;
        pending.splice(index, 1); signal.removeEventListener("abort", entry.cancel); reject(signal.reason);
      },
    };
    pending.push(entry); signal.addEventListener("abort", entry.cancel, { once: true }); nextPoster();
  });
}

function decodePoster(url: string, signal: AbortSignal): Promise<VideoPoster> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const video = document.createElement("video");
    const failure = observeMediaError(video);
    let settled = false;
    let candidates = [0], index = 0;
    let best: { poster: VideoPoster; brightness: number } | undefined;
    const timer = window.setTimeout(() => best ? finish(undefined, best.poster) : finish(new Error("视频封面读取超时，仍可点击播放")), 15000);
    function finish(error?: Error, poster?: VideoPoster) {
      if (settled) return;
      settled = true; clearTimeout(timer); failure.dispose(); signal.removeEventListener("abort", cancel);
      video.onloadedmetadata = null; video.onloadeddata = null; video.onseeked = null; video.onerror = null;
      video.pause(); video.removeAttribute("src"); video.load();
      if (error) reject(error); else resolve(poster!);
    }
    function cancel() { finish(signal.reason); }
    function capture() {
      if (settled || video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      try {
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前客户端无法创建视频封面");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let total = 0, bright = 0, count = 0;
        for (let offset = 0; offset < pixels.length; offset += 64) {
          const brightness = .2126 * pixels[offset]! + .7152 * pixels[offset + 1]! + .0722 * pixels[offset + 2]!;
          total += brightness; bright += Number(brightness > 24); count++;
        }
        const brightness = total / count;
        const poster = { url: canvas.toDataURL("image/jpeg", .82), width: video.videoWidth, height: video.videoHeight };
        if (!best || brightness > best.brightness) best = { poster, brightness };
        // ACT: 只为封面避开开头黑场，最多试3帧；亮度不用于判断视频或深度内容是否合格。
        if (brightness >= 8 || bright / count >= .01 || index >= candidates.length - 1) finish(undefined, best.poster);
        else { index++; video.currentTime = candidates[index]!; }
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        candidates = [...new Set([Math.min(.1, video.duration * .05), Math.min(1, video.duration * .2), Math.min(3, video.duration * .45)])];
        video.currentTime = candidates[0]!;
      }
      else capture();
    };
    video.onloadeddata = capture; video.onseeked = capture;
    video.onerror = () => finish(new Error(failure.describe("视频封面无法读取")));
    signal.addEventListener("abort", cancel, { once: true });
    video.src = url; video.load();
  });
}

export function readVideoPoster(url: string, signal: AbortSignal): Promise<VideoPoster> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const cached = posters.get(url);
  if (cached) { posters.delete(url); posters.set(url, cached); return Promise.resolve(cached); }
  let request = requests.get(url);
  if (!request || request.controller.signal.aborted) {
    const controller = new AbortController();
    const current: PosterRequest = { controller, users: 0, settled: false, promise: (async () => {
      const release = await waitForPosterSlot(controller.signal);
      try {
        const poster = await decodePoster(url, controller.signal);
        posters.set(url, poster);
        // ACT: 最多缓存32张640px封面、同时解码2个；缓存仅在内存，不修改素材或工程。
        if (posters.size > 32) posters.delete(posters.keys().next().value!);
        return poster;
      } finally { release(); }
    })().finally(() => { current.settled = true; if (requests.get(url) === current) requests.delete(url); }) };
    request = current; requests.set(url, current);
  }
  const current = request;
  current.users++;
  return new Promise((resolve, reject) => {
    let active = true;
    function release() {
      if (!active) return false;
      active = false; signal.removeEventListener("abort", cancel);
      if (!--current.users && !current.settled) current.controller.abort();
      return true;
    }
    function cancel() { if (release()) reject(signal.reason); }
    signal.addEventListener("abort", cancel, { once: true });
    void current.promise.then(poster => { if (release()) resolve(poster); }, error => { if (release()) reject(error); });
  });
}
