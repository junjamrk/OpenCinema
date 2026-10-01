export type BrowserAsrState = "idle" | "starting" | "listening" | "stopping" | "destroyed";

export interface BrowserAsrResult {
  text: string;
  finalText: string;
  interimText: string;
}

export interface BrowserAsrError {
  code: string;
  message: string;
}

export interface BrowserAsrOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  onStateChange?: (state: BrowserAsrState) => void;
  onResult?: (result: BrowserAsrResult) => void;
  onError?: (error: BrowserAsrError) => void;
}

export type BrowserAudioAsrOptions = {
  lang?: string;
  signal?: AbortSignal;
};

interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  start(audioTrack?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

function getRecognitionConstructor() {
  if (typeof window === "undefined") return;
  const browserWindow = window as Window & {
    SpeechRecognition?: new () => BrowserRecognition;
    webkitSpeechRecognition?: new () => BrowserRecognition;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
}

export function isBrowserAsrSupported() {
  return typeof getRecognitionConstructor() === "function";
}

export function isBrowserAudioAsrSupported() {
  if (!isBrowserAsrSupported() || typeof window.AudioContext !== "function") return false;
  const userAgent = window.navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return false;
  const version = userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1];
  // ACT: Chromium 135 门槛仅防止旧实现忽略轨道后录麦克风，不保证宿主识别服务可用；后续有原生能力检测时替换 UA 判断。
  return !!version && Number(version) >= 135;
}

export function createBrowserAsr(options: BrowserAsrOptions = {}) {
  const recognitionConstructor = getRecognitionConstructor();
  if (!recognitionConstructor) throw new DOMException("当前浏览器或 WebView 不支持原生语音识别", "NotSupportedError");

  const recognition = new recognitionConstructor();
  let state: BrowserAsrState = "idle";
  let cancelled = false;

  recognition.lang = options.lang ?? "zh-CN";
  recognition.continuous = options.continuous ?? false;
  recognition.interimResults = options.interimResults ?? true;
  recognition.maxAlternatives = 1;

  function setState(value: BrowserAsrState) {
    state = value;
    options.onStateChange?.(state);
  }

  recognition.onstart = () => {
    if (state === "starting") setState("listening");
  };
  recognition.onend = () => setState("idle");
  recognition.onerror = (event) => {
    if (!cancelled) options.onError?.({ code: event.error, message: event.message || event.error });
  };
  recognition.onresult = (event) => {
    if (cancelled) return;
    let finalText = "";
    let interimText = "";
    // ACT: 每次重建本轮完整结果，避免临时结果修订时重复追加文字。
    for (let index = 0; index < event.results.length; index++) {
      const result = event.results[index];
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    options.onResult?.({ text: finalText + interimText, finalText, interimText });
  };

  return {
    get state() {
      return state;
    },
    start(audioTrack?: MediaStreamTrack) {
      if (state !== "idle") throw new DOMException("语音识别尚未结束或实例已销毁", "InvalidStateError");
      if (audioTrack && !isBrowserAudioAsrSupported()) throw new DOMException("当前浏览器或 WebView 不支持音频轨道识别", "NotSupportedError");
      if (audioTrack && (audioTrack.kind !== "audio" || audioTrack.readyState !== "live")) {
        throw new DOMException("识别需要有效的音频轨道", "InvalidStateError");
      }
      cancelled = false;
      if (audioTrack) recognition.start(audioTrack);
      else recognition.start();
      setState("starting");
    },
    stop() {
      if (state !== "starting" && state !== "listening") return;
      recognition.stop();
      setState("stopping");
    },
    cancel() {
      if (state === "idle" || state === "destroyed" || cancelled) return;
      cancelled = true;
      recognition.abort();
      setState("stopping");
    },
    destroy() {
      if (state === "destroyed") return;
      const active = state !== "idle";
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      state = "destroyed";
      if (active) recognition.abort();
      options.onStateChange?.(state);
    },
  };
}

export function transcribeBrowserAudio(src: string, options: BrowserAudioAsrOptions = {}): Promise<string> {
  if (typeof src !== "string" || !src.trim()) return Promise.reject(new TypeError("请提供有效的音频地址"));
  if (options.signal?.aborted) return Promise.reject(new DOMException("音频转文字已取消", "AbortError"));
  if (!isBrowserAudioAsrSupported()) {
    return Promise.reject(new DOMException("当前浏览器暂不支持音频转文本，可以换个浏览器再试。", "NotSupportedError"));
  }

  return new Promise((resolve, reject) => {
    let audio: HTMLAudioElement | undefined;
    let context: AudioContext | undefined;
    let source: MediaElementAudioSourceNode | undefined;
    let destination: MediaStreamAudioDestinationNode | undefined;
    let asr: ReturnType<typeof createBrowserAsr> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let playbackEnded = false;
    let lastCurrentTime = -1;
    let finalText = "";

    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      window.removeEventListener("pagehide", cancel);
      try {
        asr?.destroy();
      } catch {
        // 原生 abort 失败时仍需释放音频和轨道。
      }
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        audio.ontimeupdate = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      source?.disconnect();
      destination?.disconnect();
      destination?.stream.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => {});
      if (error) reject(error);
      else resolve(finalText.trim());
    }

    function cancel() {
      finish(new DOMException("音频转文字已取消", "AbortError"));
    }

    function setTimeoutError(message: string, duration = 30000) {
      clearTimeout(timeout);
      timeout = setTimeout(() => finish(new Error(message)), duration);
    }

    try {
      audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.preload = "auto";
      context = new AudioContext();
      source = context.createMediaElementSource(audio);
      destination = context.createMediaStreamDestination();
      // 音频只送入识别轨道，不连接扬声器，也不请求麦克风。
      source.connect(destination);
      const track = destination.stream.getAudioTracks()[0];
      if (!track) throw new Error("无法创建音频识别轨道");
      asr = createBrowserAsr({
        lang: options.lang,
        continuous: true,
        interimResults: false,
        onResult: (result) => { finalText = result.finalText; },
        onError: (error) => {
          const messages: Record<string, string> = {
            network: "语音识别服务暂时连接不上，请稍后再试。原音频不受影响。",
            "not-allowed": "浏览器暂未允许本次语音识别，可以检查站点权限后再试。",
            "service-not-allowed": "当前浏览器暂时无法使用语音识别服务，可以稍后再试或换个浏览器。",
            "audio-capture": "暂时无法读取音频，请重新选择音频后再试。",
            "no-speech": "这段音频中没有识别到清晰的人声，可以换一段试试。",
            "language-not-supported": "当前浏览器的识别服务暂不支持所选语言，可以换个浏览器再试。",
            aborted: "本次识别已中断，可以重新试一次。",
          };
          finish(new Error(messages[error.code] ?? "这次没能完成识别，请稍后再试。原音频不受影响。", { cause: error }));
        },
        onStateChange: (state) => {
          if (settled) return;
          if (state === "listening") void audio!.play().catch(error => finish(new Error("音频暂时无法播放，请再点击一次“转文本”试试。", { cause: error })));
          if (state !== "idle") return;
          if (!playbackEnded) finish(new Error("这次识别提前结束了，可以重新试一次。原音频不受影响。"));
          else if (!finalText.trim()) finish(new Error("这段音频中没有识别到文字，可以换一段人声清晰的音频试试。"));
          else finish();
        },
      });
      audio.onended = () => {
        if (settled) return;
        playbackEnded = true;
        setTimeoutError("识别结果等得有点久，请稍后再试。原音频不受影响。", 15000);
        try {
          asr!.stop();
        } catch (error) {
          finish(error);
        }
      };
      audio.onerror = () => finish(new Error("暂时无法读取这段音频，请检查文件是否能正常播放，或换一段音频再试。", { cause: audio?.error }));
      audio.onplaying = audio.ontimeupdate = () => {
        if (settled || playbackEnded || audio!.currentTime <= lastCurrentTime) return;
        lastCurrentTime = audio!.currentTime;
        setTimeoutError("音频读取等得有点久，请稍后再试。原音频不受影响。");
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      window.addEventListener("pagehide", cancel, { once: true });
      audio.src = src;
      setTimeoutError("语音识别暂时没有响应，请稍后再试。原音频不受影响。");
      void context.resume().then(() => {
        if (!settled) asr!.start(track);
      }).catch(finish);
    } catch (error) {
      finish(error);
    }
  });
}
