# 媒体信息检查

复用 [MediaInfo.js](https://github.com/buzz/mediainfo.js) 0.3.8（BSD-2-Clause），在浏览器本地检查连接的 VIDEO、AUDIO、IMAGE 或 FILE，输出技术信息 JSON 与文字摘要。读取编码、时长、帧率、分辨率与音轨，不评价电影感或生成质量。已有结果不会因新检查失败或取消而被清空。

WASM 约2.6MB，通过 `?url` 作为发行包资产构建，与 React ESM、样式及清单一起保存到 `build/nodes/mediaInfoNode/`。`install.json` 包含模块与资产的 SHA-256，Go 从版本化插件目录提供相对资源；不从CDN获取解析器，不向外部发送素材。

需要宿主能力 `workspaceFiles v1`、`workspaceReadRange v1`、`nodeHistory v1`、`webAssembly v1`。每个画布独立激活，按需初始化一个解析器，同一画布同时检查一份素材；停用/切换工作区后取消并释放。每次操作固定工作区与文件修订，单段最多8MiB、单次最多读取64MiB/256段、素材上限32GiB、60秒超时。修订由文件身份和时间生成，不是文件内容SHA，也不是审计级文件快照。

报告为不可变工作区文件，画布保存引用；声明历史字段使结果支持撤销/重做。复制保留已有结果引用。跨工作区复制仍服从宿主素材规则，不把单个插件包导出当成项目素材打包。

仅保留白名单技术字段，不保存标题、作者、位置、封面等任意内嵌标签。原文件不改写。不自动检查或重试，不运行付费生成。

MediaInfo.js / MediaInfoLib 的版权与许可如下，随插件元数据一起分发：

Copyright (c) 2002-2016 MediaArea.net SARL, All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
