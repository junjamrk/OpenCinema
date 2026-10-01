# 多人协作扩展

同一 Toonflow 服务、同一工作区的多人画布协作。工作区只激活一个连接，支持多个画布、限时编辑/只读邀请、本人撤销重做、断线后显式继续及冲突草稿保留。

通过权威服务、命令 ID、限时会话和按本人隔离的历史同步画布；差异计算与条件补丁使用 MIT 的 fast-json-patch 3.1.1 (RFC 6902)。不会启动公网服务、自动传输素材、同步账号设置或自动执行节点任务。

共享同一服务磁盘上的素材引用，支持画布节点/连线及节点内声明的数据。独立文本文件仍沿用宿主的修订冲突保护，不提供字符级共同编辑。移动/删除共享中的画布需先结束协作。临时 Blob/file 地址不可发布；不同节点可合并，同节点冲突保守暂停。

邀请仅可兑换一次，兑换为独立的8小时编辑/只读会话；撤销原邀请同时撤销其已兑换会话。所有者在本机可恢复工作区协作。停用插件停止同步，在同一工作区重新启用后点击继续；未确认命令沿用原ID，不自动换ID重发。刷新或退出工作区不持久化浏览器令牌；使用新邀请或由本机所有者恢复。

冲突时可另存草稿并重新同步；会话过期、被撤销或远端结束后，可离开协作并保全未同步草稿，恢复磁盘画布。本人的撤销重做不会覆盖其他人随后修改的节点。保存失败不显示成功。

React ESM 导出仅分享前端插件代码，不含工作区素材、邀请、会话或服务器数据。接收端须有兼容的 `collaboration: 1` 服务能力；安装插件不会热安装服务器模块。当前使用单进程权威存储和每秒轮询，不提供公网部署、跨服务同步或分布式事务。

## 第三方许可

fast-json-patch 3.1.1

```text
(The MIT License)

Copyright (c) 2013, 2014, 2020 Joachim Wester

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
