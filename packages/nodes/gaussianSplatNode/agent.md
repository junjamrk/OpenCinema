# Gaussian Splat · Agent 指南

这个节点只做一件事：把一份 Gaussian Splatting 扫描变成可控机位的参考画面。

## 推荐顺序

1. `getSplatInfo`：读取来源、机位、渲染状态与输出端口。`source` 为 null 时先准备文件。
2. `setSplatSource`：传入工作区内的 `.ply` / `.splat` / `.ksplat` / `.spz` 路径，或在已连接 FILE 输入时省略 `path`。返回 `splatCount`、`sha256` 与新的 `revision`。
3. `frameCamera`：按包围球取景并保存机位；用 `azimuthDeg` / `elevationDeg` / `distanceScale` 调整构图。想要精确机位时直接 `setCamera`。
4. `renderStill`：同步得到 PNG 路径并写入 `image` 端口。省略 `camera` 时使用已保存机位。
5. `renderTurntable`：立即返回 `taskId`，用 `getRenderStatus` 轮询直到 `completed` 或 `failed`；`cancelRender` 可取消。完成后 `video` 端口才有产物。

## 边界

- 所有渲染在用户浏览器的 WebGL 中完成，不上传文件、不调用模型、不计费。
- `running` 期间其他渲染与取景调用会以 `renderBusy` 拒绝；页面重载后旧任务显示为 `interrupted`，需要重新发起。
- `expectedRevision` 是画布 documentRevision。环绕视频完成时按当时修订写入，长任务期间请避免并行改动该节点。
- 输出是构图与空间参考，不是测量数据；更换来源会清除旧机位与旧输出。
