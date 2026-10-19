# Changelog

所有重要变更记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-19

### 新增

- 手机通过 **DSH 同端口**（`<局域网IP>:<DSH端口>`）访问：文件浏览 + AI 对话
- 电脑端右下角「📱 手机扫码」浮层（手机 UA 自动隐藏，可收起）
- 文件浏览：缩略图（Pillow）、图片预览缩放、文本编码识别（GBK/UTF-16）、视频 Range、下载
- 手机端 DSH UI 优化：覆盖式会话抽屉、全宽聊天区、16px 输入框、安全区适配
- 文件页 ↔ AI 页双向切换（「AI 助手」卡片 / 「📁 文件」按钮）
- 认证自动处理（进程内 launchToken → cookie，浏览器历史兜底）
- 内置便携 Python 支持（Python 3.11 embeddable + Pillow + qrcode），目标机免装环境
- 一键安装/卸载脚本（PowerShell）

### 修复

- Cordis 单文件插件必须 `export default` 才能被加载（宿主插件同时导出 default 与 named）
- `process.env.PORT` 与 DSH 自身端口冲突（改用独立变量）
- 主插件与扫码插件重复注册同一路由导致 fiber 启动失败（拆分为独立插件）
- 缩略图被占位层遮挡（z-index 修正）

### 技术说明

- 本插件绑定 `<局域网IP>:<DSH端口>`，与 DSH 的 `127.0.0.1:<端口>` 共存，不冲突
- 文件服务（Python）只监听 `127.0.0.1:8789`，由插件反代
