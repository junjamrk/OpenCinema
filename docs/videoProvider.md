# 统一媒体 Provider

视频节点和 Agent 共用 `generateVideo`，图片和音频节点同样走这里的协议。Provider 处理协议、认证、素材传输与远端作业；OpenCinema 保留任务、资产、节点、保存和历史。

## 调用

先从节点 `getConfig` 发现模型和能力，再调用实时发现的 `node:generateVideo`：

```json
{
  "providerId": "fal",
  "modelId": "fal-ai/kling-video/v3/pro/text-to-video",
  "prompt": "雨夜码头追车，低机位跟拍",
  "duration": 5,
  "ratio": "16:9",
  "generateAudio": true
}
```

也可先 `setConfig`，再从底部输入框生成。手工和 Agent 使用同一节点函数。MCP 外层仍提供目标、作品修订、目录版本与稳定 `operationId`；返回的专业 `taskId` 用于继续观察，工具完成不表示视频已生成。

`getGenerationStatus` 返回状态及已知的远端任务 ID、阶段、进度、取消方式和成本（见下文「成本记录」）。视频状态查询可能恢复原任务观察及产物回收，明确声明为可能写入和访问外部服务，不会重发生成 POST。`resultReady` 表示断线期间视频已落盘，手工“采用已完成视频”或 Agent `applyGenerationResult` 会校验原模型、参考和当前输出，再通过共享历史和保存入口采用。

底层 HTTP 复用 `POST /api/ai/media/generate`，另带 `mediaType:"video"`、工程绝对 `directory`、工程相对 `outputDirectory` 和 UUID `operationId`（与 `taskId` 是同一凭据，两者同时提供时必须相同）。同 ID、同请求回读原任务，不同参数拒绝；模型参数也算在内，字段顺序不影响判定。未知状态保留原 ID，不换 ID 重派。

## 执行协议

| `videoProtocol` | 位置与契约 |
| --- | --- |
| `openaiVideo` | 仅视频。本机、局域网或公网模型服务；multipart 提交、按 ID 查询、认证下载视频。只连接提供此合同的服务，不自动安装运行库和权重。 |
| `fal` | 图片、视频、音频。模型队列；保存实际返回、绑定本次 request ID 的状态／产物／取消地址。 |
| `replicate` | 图片、视频、音频。`owner/name` 模型 predictions；保存 prediction ID，查询并回收实际输出。 |
| `ark` | 仅视频。火山方舟官方 `contents/generations/tasks`；保存任务 ID，查询 `content.video_url` 并下载可解码产物。 |
| `comfyui` | 图片、视频、音频。本机或局域网 ComfyUI；按保存的映射替换工作流输入，提交后查询并回收产物，见下文。 |
| `httpTask` | 图片、视频、音频。把任意任务式 HTTP 服务声明在清单里，公网或本地都可以，见下文。 |
| `adapter` | 图片、视频、音频。数据目录里用户手动放置的可执行文件，接声明式写不了的流程，例如请求签名，见下文。 |
| 未声明 | 保留既有 TF-router、APIMart、秘塔、优云智算适配，以及 `protocol:"openai"` 图片和 `endpoints.*` 同步 JSON。 |

内置供应商的基础地址、地区地址、生成适配、估价和余额能力写在目录的 `apiUrl`、`regionUrls`、`generator`、`supportsPrice`、`supportsBalance` 字段里。后四个只由内置目录决定，清单里声明会被忽略；旧版保存的内置供应商副本读取时自动补齐。

内置增加本地视频服务、fal Kling 3.0 Pro 文生视频、Replicate Veo 3.1 八秒／首尾帧和火山方舟 Seedance 2.0 配置。目录存在不表示权重已加载、鉴权成功或生成已验收。本地模板模型 ID 须与实际服务公开名称一致；H3 模板只声明文生和首帧，不把尚未适配的多模态参考算作可用。

火山方舟使用 `providerId:"ark"`、`modelId:"doubao-seedance-2-0-260128"`。当前声明 4–15 秒、480p／720p／1080p、文生、单图、首尾帧，以及 `mode:["imageReference:9","videoReference:3"]` 的图片／视频全模态参考；未声明音频参考。`singleImage` 把图片作为 `first_frame`，首尾帧分别使用对应角色，图片参考模式使用 `reference_image`。图片／视频参考与 `firstFrame`／`lastFrame` 互斥；如需兼顾外观和白模动作，应以参考图片加参考视频输入，并在提示词明确各素材用途。[官方创建任务契约](https://console.volcengine.com/ark/region:cn-beijing/docs/create-video-generation-task-api)

本地图片由已有工作区读取入口转换为 data URI；单张须小于 30 MiB，请求须小于 64 MiB。本地视频先使用 FFprobe 校验 MP4／MOV、H.264／HEVC、2–15 秒、24–60fps、边长 300–6000px、宽高比 0.4–2.5、像素 407696–8295044 和参考视频总时长不超过 15 秒；继续沿用工程参考文件单个 100 MiB 的平台上限。低采样率深度结果应先转为符合条件的参考视频，不能直接以 6fps 提交。校验通过后用 [Files API](https://console.volcengine.com/ark/region:cn-beijing/docs/upload-files-api) 上传本地文件，等待 [文件详情](https://console.volcengine.com/ark/region:cn-beijing/docs/search-files-api) 为 `active`；仅在实际返回有效 `download_url` 时，才在内存中将其传入 `video_url`／`reference_video`。临时 URL 不持久化、不出现在 Agent 回执或日志中。上传文件保留约一天，File ID 和 SHA256 记录于同一个媒体任务以便观察和恢复。

部分账号的 Files API 不返回 `download_url`，此时参考准备会明确失败，不提交生成。File ID 不可代替 `asset://` 或视频 URL；需要配置可读的素材链接。TOS 使用 AK/SK 或 STS，不接受 Ark API Key。[官方凭据边界](https://console.volcengine.com/ark/region:cn-beijing/docs/iam-api-key-best-practices)

API Key 仅发给固定官方 HTTPS 来源，不接受改写 Base URL；供应商原始错误正文不进入回执，仅保留有界错误码。生成结果下载不附带 Ark API Key。白模在该模型中属于运动、布局、镜头节奏的普通视频参考，不能宣称为逐像素深度约束或 ControlNet；生成后仍须核对主体运动、构图与连贯性。[官方查询任务](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh)

## ComfyUI 工作流

`videoProtocol:"comfyui"` 把 ComfyUI 的 API 格式工作流当成模型，图片、视频、音频都走同一条任务链路。内置供应商 `comfyui` 没有预置模型，地址和启用状态来自本地连接（`getLocalVideoConnection`），不在供应商配置里。

```json
{
  "id": "wan22Flf2v",
  "label": "Wan 2.2 首尾帧",
  "type": "video",
  "mode": ["startEndRequired"],
  "imageRatios": ["16:9"],
  "durationResolutionMap": [{ "duration": [5], "resolution": ["720p"] }],
  "comfy": {
    "workflow": { "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "...", "clip": ["38", 0] } } },
    "inputs": {
      "prompt": [{ "node": "6", "field": "text" }],
      "firstFrame": [{ "node": "52", "field": "image" }],
      "lastFrame": [{ "node": "71", "field": "image" }],
      "width": [{ "node": "83", "field": "width" }],
      "height": [{ "node": "83", "field": "height" }],
      "frames": [{ "node": "83", "field": "length" }]
    },
    "fps": 16,
    "frameStep": 4
  }
}
```

| `comfy.inputs` 键 | 含义 |
| --- | --- |
| `prompt` | 必填。提示词写入所有目标，一个节点有多个文本字段时全部映射 |
| `firstFrame`、`lastFrame` | 帧图片，写入所有目标 |
| `images`、`videos`、`audios` | 参考素材，按顺序一一对应，数量必须与请求一致 |
| `width`、`height` | 须同时映射。由画幅和分辨率算出，分辨率写成短边像素，如 `720p` |
| `frames` | 由时长和 `fps` 算出，按 `frameStep` 对齐到 `n × frameStep + 1`，须同时声明 `fps` |
| `parameters` | 模型参数到工作流字段的映射，形如 `{ "cfg": [{ "node": "3", "field": "cfg" }] }`，见下文「模型参数」 |

映射目标必须是节点上的固定值，不能是连线。未映射的素材或时长直接拒绝，不静默丢弃；未映射尺寸时节点不显示画幅选项。模型目录不向节点下发 `comfy` 字段，生成请求只选模型，不能携带工作流。含非空凭据字段的工作流拒绝保存。工作流只能由用户在设置页导入：Agent 工具 `setProviderModels` 和 `manageMediaProviders` 不能新增或修改图。这一限制在工具层，能直接访问本机 HTTP 接口的进程不受它约束。

内置 `comfyui` 供应商使用设置页的本地连接。要接第二台 ComfyUI，用 **其他 ComfyUI 服务模板** 添加一个 `videoProtocol:"comfyui"` 的供应商，它用自己的 `apiUrl`，同样只允许本机或局域网地址。

- 素材按内容命名上传到 `input` 根目录，同一素材不重复上传。子目录会让部分自定义加载节点的校验失败。
- `seed`、`noise_seed` 的固定值每次提交都随机替换，否则 ComfyUI 直接返回缓存。用户通过模型参数填了种子时以用户为准，此时完全相同的图可能直接命中 ComfyUI 缓存。
- 任务 ID 在提交前落盘并作为 `prompt_id` 发送。响应丢失时按同一 ID 查询，不重新提交；旧版 ComfyUI 忽略客户端 ID 时以响应为准。
- 状态先查 `/queue` 再查 `/history/{id}`，两边都没有时报告未确认，不判定为失败。
- 进度来自 `/ws?clientId={id}` 的 `progress` 消息，只用于展示，是当前节点的进度，不是整个工作流。连不上时不影响任务。
- 取消时排队中用 `POST /queue` 删除，运行中用 `POST /interrupt` 带 `prompt_id` 中断。
- 产物只回收 `type:"output"` 且扩展名匹配媒体类型的文件，经 `/view` 下载，视频再用 FFprobe 校验。

## 模型参数

厂商特有参数（负向提示词、引导强度、种子等）由模型清单的 `parameters` 声明，节点按它生成表单，Agent 从 `getConfig` 的 `models[].parameters` 读取同一份声明。没声明 `parameters` 的模型行为不变。

```json
{
  "id": "deployedModelName",
  "label": "已部署的视频模型",
  "type": "video",
  "mode": ["text"],
  "parameters": {
    "type": "object",
    "properties": {
      "negative_prompt": { "type": "string", "title": "负向提示词" },
      "guidance": { "type": "number", "title": "引导强度", "default": 7.5, "minimum": 1, "maximum": 20 },
      "seed": { "type": "integer", "title": "种子", "minimum": 0 },
      "hd": { "type": "boolean", "title": "高清", "default": false },
      "scheduler": { "type": "string", "title": "调度器", "enum": ["euler", "dpm"], "default": "euler" }
    }
  }
}
```

这是 JSON Schema 的子集。顶层只有 `type: "object"` 和 `properties`，最多 64 个字段；字段只支持 `type`（`string`、`number`、`integer`、`boolean`）、`title`、`default`、`minimum`、`maximum`、`enum`。有 `enum` 时可省略 `type`。其他关键字（含 `required`）保存时直接拒绝，字段全部可选。字段名须匹配 `^[a-zA-Z][a-zA-Z0-9_]{0,95}$`，不能是凭据类名称，也不能占用协议字段：`videoBody` 已写入的输入字段、`inputMap` 的目标，以及 `model`、`size`（`openaiVideo`）或 `model`、`content`、`ratio`、`execution_expires_after`（`ark`）。

- **节点：** 用户填的值存在节点数据的 `parameters`。换模型时未声明的字段丢弃，不合法的值退回 `default`，所以旧模型的值不会带到新模型。
- **Agent：** `setConfig` 或 `generateVideo` 传 `parameters`，整体替换已保存的值；未声明、类型或范围不符的字段拒绝，配置和生成都不执行。`getConfig` 返回填入默认值后的实际值，`getGenerationPlan` 预览实际发送的值。
- **HTTP：** `POST /api/ai/media/generate` 增加 `parameters` 对象。服务端按模型声明严格校验：未声明字段、类型不符、超出范围、不在 `enum` 内一律 400。整数不能超过 2^53，文本不超过 10000 字节且不能以 `data:` 开头。模型没声明 `parameters` 时带此字段同样拒绝。
- **协议：** `openaiVideo`、`fal`、`replicate`、`ark` 把值合入请求体顶层（Replicate 在 `input` 内），覆盖 `video.defaults` 的同名字段。`comfyui` 只写入保存时已映射的字段，`parameters` 声明与 `comfy.inputs.parameters` 的映射必须一一对应，目标须是节点上的固定值且类型相符。未填写的参数保持工作流原值。
- **未声明 `videoProtocol` 的供应商**（TF-router、APIMart、秘塔、优云智算和同步 HTTP 适配）不支持 `parameters`，保存时拒绝。这些适配的请求体是逐字段写死的，声明了也送不出去。

在设置里导入 ComfyUI 工作流时，确认页会列出负向提示词和采样器的固定字段（`seed`、`noise_seed`、`steps`、`cfg`、`guidance`、`denoise`、`sampler_name`、`scheduler`），勾选的字段才生成 `parameters` 和映射。种子不设默认值，留空时每次随机。

## 成本记录

任务记录分开保存提交前的预估和结束后的实际扣费，`/api/ai/media/tasks/status`、`tasks/cancel` 的每个任务都返回 `cost`，节点状态行显示「预估 … · 实际 …」，`getGenerationStatus` 返回同一字段。

```json
{
  "estimate": { "price": "1.25 元", "tips": "以实际扣费为准" },
  "actual": { "amount": 0.9, "unit": "元", "source": "balanceDelta" }
}
```

- `estimate` 是提交前调用报价接口的结果。报价失败或供应商不支持时为 `null`，不影响生成。
- `actual` 是实际扣费，拿不到就是 `null`，界面显示「未知」，绝不用预估代替。`source` 为 `vendor` 表示厂商在任务结果里返回了带单位的金额（读取 `cost` 或 `amount` 与 `unit`），优先采用；`balanceDelta` 表示任务前后的余额差。
- 余额差只能归属到窗口内唯一的任务。同账户任务重叠、期间充值、单位变化、余额没减少或任务未确认成功时都记 `null`。本进程看不到同账户在其他设备上的消费和延迟入账，所以 `balanceDelta` 是推算值，账单以厂商为准。
- 只有 TF-router 有报价和余额接口，其他供应商两项都是 `null`，不编造金额。

## 自定义供应商

沿用 JSON manifest 导入，例如提供同一合同的远程 GPU 服务：

```json
{
  "id": "remoteVideo",
  "label": "自建视频服务",
  "apiUrl": "https://video.example.com/v1",
  "videoProtocol": "openaiVideo",
  "transport": "public",
  "cancelMode": "none",
  "endpoints": { "video": "videos" },
  "rules": [{ "field": "apiKey", "title": "API Key", "type": "input", "value": "", "props": { "type": "password" } }],
  "models": [{
    "id": "deployedModelName",
    "label": "已部署的视频模型",
    "type": "video",
    "mode": ["text", "endFrameOptional"],
    "imageRatios": ["16:9", "9:16"],
    "audio": false,
    "durationResolutionMap": [{ "duration": [4, 8], "resolution": ["720p"] }],
    "video": { "inputMap": { "firstFrame": "input_reference" } }
  }]
}
```

`video.inputMap` 映射模型实际字段，`defaults` 声明额外标量参数，`stringFields` 处理厂商的字符串数值。未声明映射的参考素材明确拒绝，不静默丢弃。平台使用工作区读取的 data URI，本地／远程 OpenAI 风格服务用 multipart 传文件；不向远端传本机路径，不要求用户配置对象存储。模型若不接受该传输方式，需要相应适配，不能仅改名称就宣称兼容。

### 本地服务

`transport:"local"` 可用于 `openaiVideo`、`comfyui`、`httpTask`、`protocol:"openai"` 图片和 `endpoints.*` 同步 JSON；`fal`、`replicate`、`ark` 保留公网边界。API Key 可选，配置了才发送。

```json
{
  "id": "localImage",
  "label": "本机图片服务",
  "apiUrl": "http://127.0.0.1:7860/v1",
  "protocol": "openai",
  "transport": "local",
  "rules": [{ "field": "apiKey", "title": "服务认证（可选）", "type": "input", "value": "", "optional": true, "props": { "type": "password" } }],
  "models": [{ "id": "localModel", "label": "本机模型", "type": "image" }]
}
```

地址仅允许明确环回／私网 IP 和端口，localhost 会规范化；连接固定目标且拒绝重定向。本地服务返回的产物地址与连接同 IP、同端口时走同一个固定连接下载，其他地址一律按公网规则下载。公网供应商及外部产物下载继续禁止私网访问。密钥只保存在服务端，不写 manifest、任务记录或 Agent 回执。

### fal 与 Replicate 的图片和音频

这两个协议可以声明 `image`、`audio` 模型，沿用同一条任务提交、查询、取消和恢复链路。在设置里给内置 `fal`、`replicate` 添加模型即可，字段映射同样写在 `video` 对象里。

```json
{
  "id": "fal-ai/flux/dev",
  "label": "FLUX dev",
  "type": "image",
  "imageRatios": ["16:9", "1:1"],
  "video": { "inputMap": { "images": "image_urls" }, "defaults": { "num_images": 1 } }
}
```

| 模型类型 | 可映射字段 |
| --- | --- |
| `image` | `prompt`、`ratio`、`size`、`images` |
| `audio` | `prompt`、`voice`、`speed`、`volume`、`pitch`、`language`、`format`、`sampleRate`、`images`、`audios` |

`prompt` 默认发 `prompt`，声明了 `imageRatios` 时 `ratio` 默认发 `aspect_ratio`。节点总会带上 `size`、`language` 等默认值，模型没声明对应能力也没写映射时不发送；声明了 `imageSizes` 或 `voices` 却没有映射、或参考素材没有映射时明确拒绝，未提交生成。

产物解析：fal 读 `images[].url`、`image`、`audio.url`、`audios`、`video`、`videos`；Replicate 读 `output`，字符串、数组或带 `url` 的对象都可以。

## 声明式任务协议 httpTask

`videoProtocol:"httpTask"` 把提交、查询、取消写进清单，不写代码。每种媒体类型各写一份 `task.<类型>`，清单里出现的模型类型都必须有对应声明。

```json
{
  "id": "acmeVideo",
  "label": "Acme 视频",
  "apiUrl": "https://api.acme.example/v1beta",
  "videoProtocol": "httpTask",
  "auth": { "header": "x-goog-api-key", "prefix": "" },
  "headers": { "x-client-name": "openCinema" },
  "rules": [{ "field": "apiKey", "title": "API Key", "type": "input", "value": "", "props": { "type": "password" } }],
  "task": {
    "video": {
      "submit": {
        "method": "POST",
        "path": "models/{model}:generate",
        "body": {
          "instances": [{ "prompt": "{prompt}", "image": "{firstFrame}" }],
          "parameters": { "aspectRatio": "{ratio}", "durationSeconds": "{duration}" }
        }
      },
      "idPath": "name",
      "status": {
        "path": "{id}",
        "statePath": "state",
        "states": { "QUEUED": "queued", "RUNNING": "running", "SUCCEEDED": "completed", "FAILED": "failed", "CANCELLED": "cancelled" },
        "progressPath": "metadata.progress"
      },
      "outputPath": "response.files",
      "cancel": { "method": "POST", "path": "{id}:cancel" }
    }
  },
  "models": [{
    "id": "acme-video-1",
    "label": "Acme Video 1",
    "type": "video",
    "mode": ["text", "endFrameOptional"],
    "imageRatios": ["16:9", "9:16"],
    "audio": false,
    "durationResolutionMap": [{ "duration": [4, 8], "resolution": [] }]
  }]
}
```

| 字段 | 含义 |
| --- | --- |
| `auth.header`、`auth.prefix` | API Key 放在哪个请求头、前面加什么。默认 `Authorization: Bearer <key>`。前缀只能是字母加一个空格 |
| `headers` | 额外的固定请求头。名字含 auth、key、token、secret、cookie、signature、session 的一律拒绝 |
| `submit.method` | `POST`（默认）、`PUT` 或 `PATCH` |
| `submit.path` | 相对 `apiUrl` 的路径，可用 `{model}` |
| `submit.body` | JSON 模板，必须用到 `{prompt}` |
| `idPath` | 提交响应里任务 ID 的路径。字符串或安全范围内的整数，可以含斜杠，例如 `models/x/operations/1` |
| `status.path` | 查询路径，必须含 `{id}`，可带查询串，例如 `tasks?task_id={id}`。固定 GET |
| `status.statePath` | 状态字段路径 |
| `status.states` | 状态值映射，目标只能是 `queued`、`running`、`completed`、`failed`、`cancelled`，至少一项是 `completed`。比较时忽略大小写；键写空串表示字段缺失，布尔和数字按文本比较，例如 `{ "true": "completed", "": "running" }`。未列出的值视为未知，继续查询 |
| `status.progressPath` | 可选。0 到 100 的数字 |
| `outputPath` | 完成响应里产物的路径。值可以是地址、地址数组，或带 `url` 字段的对象及其数组 |
| `outputAuth` | 可选。为 `true` 时带鉴权头下载产物，地址必须和 `apiUrl` 同源且在其路径之下，例如 Gemini Veo 的下载地址 |
| `cancel` | 可选。`method` 为 `POST`（默认）、`PUT` 或 `DELETE`，`path` 必须含 `{id}`。未声明时不会向远端发取消 |

路径用点号，数组用数字下标，例如 `data.videos.0.url`。键名含点的字段取不到。这不是表达式语言，没有通配符和条件。

`submit.body` 的占位符：`{model}`、`{prompt}`、`{image}`（恰好一张参考图时取这一张），以及该媒体类型的可映射字段，视频另有 `{duration}`、`{ratio}`、`{resolution}`、`{generateAudio}`、`{images}`、`{videos}`、`{audios}`、`{firstFrame}`、`{lastFrame}`。

- 字符串整串就是一个占位符时保留原类型，数字还是数字，数组还是数组；夹在文字里时按文本替换。
- 没有值的占位符连同它的键一起去掉，对象或数组被清空时也一起去掉。
- 参考素材以 data URI 发送。请求带了参考素材但模板没用到时明确拒绝，未提交生成；其余参数没用到就不发送。
- 用户提示词里的 `{model}` 这类文本不会被展开。

安全边界：

- 清单不能含凭据。路径只能是相对路径，不能写完整地址或跨目录，查询串不能放凭据。
- 响应里只取任务 ID，且校验字符集和跨目录；后续请求一律由 `apiUrl` 加路径模板拼出，响应不能改变请求目标。
- 自定义鉴权头不跟随跨来源重定向。
- 任务记录在发出提交请求前落盘。响应丢失时没有任务 ID，保持未确认，不重新提交。
- 状态响应上限 2MiB，错误正文不读取。产物默认走安全下载，不带凭据；声明 `outputAuth` 时只向同源地址发送凭据。

需要请求签名、multipart、按值换算，或响应里内嵌裸 base64 的服务，用 `adapter`。

## 子进程适配器 adapter

`videoProtocol:"adapter"` 接声明式写不了的流程。清单只选协议，不能声明命令、参数或路径，否则导入一份 JSON 就等于执行任意程序；含 `command`、`args`、`executable`、`script`、`path`、`env`、`cwd`、`shell`、`program`、`adapter` 字段的清单直接拒绝。

```json
{
  "id": "signedVideo",
  "label": "需要签名的视频服务",
  "videoProtocol": "adapter",
  "cancelMode": "request",
  "rules": [{ "field": "apiKey", "title": "API Key", "type": "input", "value": "", "props": { "type": "password" } }],
  "models": [{ "id": "vendorModel", "label": "厂商模型", "type": "video", "mode": ["text"], "audio": false, "durationResolutionMap": [{ "duration": [5], "resolution": ["720p"] }] }]
}
```

可执行文件固定放在数据目录的 `providerAdapters/<供应商 ID>/adapter`（Windows 为 `adapter.exe`），由用户手动放置：

- 解析真实路径后必须仍在这个目录内，符号链接不能指向外面。
- 须是普通文件，有可执行位，不能所有用户可写。Windows 没有可执行位，只看文件名。
- 工作目录是适配器所在目录。

每个动作起一个进程，stdin 收一行 JSON，stdout 回一行 JSON。

| `action` | 收到 | 回复 |
| --- | --- | --- |
| `submit` | `taskId`、`mediaType`、`modelId`、`input`、`config` | `{"id":"任务ID"}`；确认没有提交时回 `{"error":"原因"}` |
| `status` | `id`、`mediaType`、`modelId`、`config` | `{"status":"running","progress":40}`；完成时 `{"status":"completed","outputs":["https://...","data:image/png;base64,..."]}` |
| `cancel` | `id`、`mediaType`、`modelId`、`config` | `{}`。清单声明 `cancelMode:"request"` 时才会调用 |

`input` 是提示词和生成参数，参考素材是 data URI，字段名同 `httpTask` 的占位符。`config` 是这个供应商的连接配置，包括 API Key。`status` 取值 `queued`、`running`、`completed`、`failed`、`cancelled`。

- 拿不准是否已提交时不要回 `error`，非零退出即可。任务会停在未确认，不重新提交。
- 进程超时 2 分钟后结束，stdout 上限 140MiB，超限按异常退出处理。
- 凭据只走 stdin，不进命令行参数或环境变量。stderr 直接丢弃，`error` 文本里的密钥会被替换后才写入任务结果。
- `outputs` 里的地址走安全下载，不能指向本机或内部网络；要回传本机文件，用 data URI。
- 超时只结束适配器本身，它自己派生的进程不受管理。

## 生命周期

- 新协议提交前原子记录请求和配置摘要，收到远端 ID 后持久化。恢复绑定原 Provider、配置摘要和 job ID；配置变化后拒绝改投其他连接。图片和音频走这些协议时同样如此。
- 远端已确认完成但结果无效（fal 返回错误、没有产物）直接落成失败。产物下载失败时最多再试 3 次。
- Ark 参考视频上传在生成提交之前单独记录 `preparingReferences` 阶段和 File ID。重启恢复先读原文件状态，生成提交前持久切换阶段；生成提交结果未知时仍禁止自动重发。参考文件上传不等于视频模型任务已受理。
- 视频下载入工程，经 FFprobe 核对可解码、尺寸／时长有效，产生 SHA256 和 assetId 后才发布成功。视频不会因页面断线两分钟而自动取消。
- OpenAI 风格服务默认 `cancelMode:"none"`；只有核实 DELETE 确实请求中止时才能设为 `request`。SGLang 的删除记录接口不等于停止 GPU。
- fal／Replicate／httpTask／adapter 取消后在 10 秒内核对远端状态；未确认终止仍为 unknown／sideEffectMayContinue；取消输给完成时保留产物，下次状态查询取回。提交超时且没有 job ID 时禁止自动重发。服务重启后取消，由恢复的任务向远端发出取消。
- 火山方舟 `expired` 视为远端确认失败。其 DELETE 可删除已完成记录，因此当前 `cancelMode:"none"`，停止本地观察保留原任务凭据，不把删除记录当作停止生成。[官方取消／删除语义](https://docs.volcengine.com/docs/ark/cancel-or-delete-video-generation-tasks-api)
- 新协议可在 Go 重启后恢复已知远端作业。旧适配若没有持久作业句柄，继续按既有 unknown 契约阻止重复提交，不宣称已具备远端恢复。

协议实现和配置模板不等于供应商真实生成验收；验证结果及所缺环境单独记录。

## 已托管视频的临时链接绑定

已在私有存储上传、但没有应用签名服务的新视频，可在视频生成节点的高级内容展开「临时视频参考链接」。节点必须已选择方舟并实际连接 VIDEO 输入。选择当前输入，粘贴已授权的 HTTPS 直接读取链接，核对签名到期时间，点击「核对并登记」。界面通过密码输入框临时持有链接，点击后立即清空，不调用节点工具、写入节点数据或保存链接。TOS 控制台的分享页面不等于原始视频下载地址；登记会真实 GET 原始字节核对，因此 HTML 分享页会被拒绝。

公开业务接口为 `POST /api/ai/media/referenceBindings`；与现有工作台接口一样要求同源、`x-toonflow-workspace: 1`、本机工作台和授权工程路径。接收 `directory`、`canvasId`、消费视频生成节点 `nodeId`、工程内 `path`、`sha256`、`operationId`、`readUrl`、ISO UTC `readExpiresAt` 和 `credentialExpiresAt`。先读取已保存画布确认此消费节点使用 Ark，再核对本地文件、远端原始字节的 SHA256 与大小，并重新核对本地文件未变化。只接受100MiB以内的文件，禁止私网访问及重定向，不向存储地址发送方舟 API Key。带秘密链接的登记请求应从受信业务界面或调用方内存发送，不能把完整链接粘入 MCP 参数、命令行、日志或聊天。

`GET` 同一接口使用 `directory`、`canvasId`、`nodeId`、`path`、`sha256` 查询非秘密状态。返回 `missing`、`ready`、`expired` 或 `needsRebind`，不返回链接。保存的绑定只包含作用域、文件摘要、大小、绑定ID和期限；独立 operationId 摘要记录阻止相同ID改参数或换作用域。临时 URL 仅保留于当前服务进程内存；重启后不会从磁盘恢复 URL，存在绑定但内存凭证缺失或期限不足时明确失败，不静默回退到 Files。

已有 `node:generateVideo` 自动按真实任务的工程目录、`assets/<消费节点UUID>` 输出位置，以及当前 VIDEO 输入路径和 SHA 找到绑定；不增加一套生成工具或复制画布状态。Ark 原请求只在内存中使用读取地址，媒体 job 只保存非秘密 `referenceBindings`。已有远端任务仍仅查询原ID，不重新派发生成。

此临时路线在登记及真正提交前要求链接名义有效期至少剩10分钟，并将本次真实 `execution_expires_after` 设为官方允许的最小3600秒，记录在 job。官方范围为3600–259200秒，不能用1800秒。10分钟是本地提交余量，不是对供应商排队或提前缓存的保证；短期链接不一定覆盖整段排队。含 STS 的链接若无法获知底层凭据实际到期，可将 `credentialExpiresAt` 显式设为 `null`，绑定记录 `credentialExpiryKnown:false` 和 `queueExpiryCovered:false`，只表示当前远端 GET 成功，不能当作长期凭据。已知期限必须如实填写，不能把 URL 名义期限当作 STS 期限；排队后读取过期可能导致供应商失败，保留原 job 并显示失败，不自动续签或重新收费生成。[方舟实际任务期限契约](https://console.volcengine.com/ark/region%3Acn-beijing/docs/create-video-generation-task-api)

签名服务配置使用 `storageType`、`storageSignerUrl`、独立秘密 `storageAccessToken`、`storageObjectOrigin`、`storagePrefix` 和 `storageProjectId`。当前视频生成链路尚未自动调用上传函数；仅填写这些字段不会自动托管素材，应使用已上传对象的临时绑定入口。
