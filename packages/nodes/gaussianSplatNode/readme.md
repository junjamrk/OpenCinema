# Gaussian Splat

在画布中查看 3D Gaussian Splatting 扫描，设定机位，渲染静帧与环绕视频，作为构图与空间参考连接到下游节点。本插件不是内置节点：它通过 [插件市场](https://opencinema.site/market/) 或“安装插件包”安装，同时也是 OpenCinema 插件链路能承载完整 3D 能力的验证。

## 使用

1. 添加节点后选择 `.ply`、`.splat`、`.ksplat` 或 `.spz` 文件，或连接一个 FILE 输入后点击“使用上游文件”。文件保存在工程的 `assets/<节点 ID>/` 下，节点记录格式、字节数、SHA-256 与 Gaussian 数量。
2. 在节点内拖动旋转、滚轮缩放、右键平移。“保存机位”把当前视角写入节点并纳入画布历史；“自动取景”按扫描包围球重新取景。
3. “渲染静帧”把 1280×720 PNG 写入 `image` 端口；“环绕视频”在后台逐帧渲染并用本机 FFmpeg 编码 4 秒 24 fps 的 H.264 MP4 写入 `video` 端口。`file` 端口原样输出扫描文件。

渲染发生在本机浏览器的 WebGL 中，不上传文件、不调用生成模型。上限：100 MiB、2,000,000 个 Gaussian、环绕视频 600 帧。

## Agent 操作

通过 `getNodeTools` 发现函数：`getSplatInfo` 读状态，`setSplatSource` 选文件，`getCamera` / `setCamera` / `frameCamera` 管机位，`renderStill` 同步出图，`renderTurntable` 排队出视频并用 `getRenderStatus` / `cancelRender` 跟踪。随包发行的 `agent.md` 给出推荐顺序与边界。

## 边界

- 静帧与环绕视频是扫描的可视化参考，不是测量数据；`frameCamera` 的包围盒按 2%–98% 分位计算，会忽略远处漂浮点。
- 更换扫描文件会清除旧机位与旧渲染输出；已写入的文件保留在工程里。
- 需要宿主能力 `workspaceFiles`、`workspaceReadRange`、`nodeHistory`、`ffmpeg`、`worker`；环绕视频还需要在设置中就绪的 FFmpeg。

## 第三方来源与许可

- [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) 0.4.7，MIT，Mark Kellogg。完整许可见 `licenses/gaussianSplats3dLicense.txt`。
- [three.js](https://threejs.org) 0.184.0，MIT。完整许可见 `licenses/threeLicense.txt`。
