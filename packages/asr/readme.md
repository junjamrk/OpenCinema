# @toonflow/asr

浏览器原生语音识别，兼容 `SpeechRecognition` 和 `webkitSpeechRecognition`，不依赖 Vue，不额外请求 `getUserMedia`。消费方先添加依赖 `"@toonflow/asr": "workspace:*"`。

## 使用

```ts
import { createBrowserAsr, isBrowserAsrSupported } from "@toonflow/asr";

if (!isBrowserAsrSupported()) throw new Error("当前浏览器或 WebView 未提供语音识别 API");

const asr = createBrowserAsr({
  lang: "zh-CN",
  onStateChange: (state) => console.log("语音识别状态", state),
  onResult: ({ text, finalText, interimText }) => console.log({ text, finalText, interimText }),
  onError: ({ code, message }) => console.error(code, message),
});

// 在用户点击事件中调用，每次 start 都是独立的一轮识别。
asr.start();
// 停止收音并等待最后结果和 idle 状态。
// asr.stop();
// 取消当前轮，不再回调后续识别结果；等待 idle 后才能重新开始。
// asr.cancel();
// 组件卸载或不用时解绑回调并中止识别，销毁后不可复用。
// asr.destroy();
```

默认 `lang: "zh-CN"`、`continuous: false`、`interimResults: true`。`onResult` 返回当前轮完整快照，回填时替换本轮语音文字，不要把每次 `text` 追加到输入框。`finalText` 是已确认文字，`interimText` 仍可能修订。

`state` 为 `idle → starting → listening → stopping → idle`；浏览器也可能自然结束，直接回到 `idle`。只有 `idle` 可以重新开始。`start()` 的同步异常直接抛出；识别过程错误通过 `onError` 保留浏览器错误码和原始消息。取消时不回调预期的 `aborted` 错误。

`start(audioTrack?: MediaStreamTrack)` 也可传入有效的音频轨道，调用方负责释放传入轨道；该用法须先通过 `isBrowserAudioAsrSupported()`。

## 音频文件转文字

```ts
import { isBrowserAudioAsrSupported, transcribeBrowserAudio } from "@toonflow/asr";

if (!isBrowserAudioAsrSupported()) throw new Error("当前浏览器或 WebView 不支持音频文件识别");
const controller = new AbortController();
const text = await transcribeBrowserAudio(audioUrl, { lang: "zh-CN", signal: controller.signal });
// 组件卸载或主动取消时调用 controller.abort()。
```

`transcribeBrowserAudio(src, options?)` 返回 `Promise<string>`；`BrowserAudioAsrOptions` 为 `{ lang?: string; signal?: AbortSignal }`，默认中文。音频通过 Web Audio 送入识别轨道，不连接扬声器、不采集麦克风，按音频实际时长识别。只在完整音频播放结束且浏览器返回最终文字后成功；无文字、识别提前结束、加载/服务错误、取消和超时均拒绝，不会将部分文字作为完整转写。30 秒内未开始或播放无进展、结束后 15 秒仍未返回结果时超时。

识别完成、失败、取消或页面退出都会释放识别实例、音频元素、Web Audio 连接及轨道。调用方传入的 `src` 不会被撤销；对象 URL 由创建方负责释放。

音频转写的常见失败返回中文说明；浏览器原始错误码、消息或媒体错误保留在 `Error.cause` 中，供开发者排查，不直接展示给用户。

## 运行边界

音频文件识别保守限定为具有识别 API、AudioContext 的桌面 Chromium 135+；Android、iOS、Safari 不支持该入口。版本门槛仅用于防止旧浏览器忽略轨道参数而转录麦克风，不能证明 WebView 或浏览器的识别服务可用。长音频或静音可能导致浏览器提前结束，本包明确报错，不自动重启或拼接部分结果。音频须能被浏览器解码，远程地址须允许跨域读取。

浏览器原生识别可能将音频发送给浏览器供应商的在线服务，并非离线模型。推荐 localhost 或 HTTPS。在目标安装包或 WebView 中验证服务、权限和真实音频；API 检测与编译通过不能代替运行验证。

参考：[SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)、[音频轨道兼容性](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)、[Edge 语音识别服务说明](https://github.com/MicrosoftDocs/edge-developer/blob/main/microsoft-edge/web-platform/speech-recognition-api.md)。
