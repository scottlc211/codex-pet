# Security

## 安全边界

Codex Pet 是本地桌面应用。WebView 输入、宠物包清单、zip 条目和 Tauri command 参数均按不可信输入处理；应用不会加载远程脚本，也不会把整个 `~/.codex` 暴露给 asset protocol。

本应用会按用户操作启动本机 Codex CLI、打开终端并读取近期 Codex session 状态。这些是产品能力，不应被宠物包或未校验的命令参数间接触发。

## 主要限制

- Codex 命令名不经过 shell 查找，任务正文只通过 stdin 传递。
- 终端类型由后端固定白名单校验。
- 导入资源统一复制到 `~/.codex-pet/pets/`，并限制路径、符号链接、文件数、层级和解压大小。
- Tauri asset protocol 仅允许 `~/.codex/pets/` 与 `~/.codex-pet/pets/`。
- CI 固定第三方 Action 提交，并执行前端依赖审计、RustSec、测试和 Clippy。

## 已知上游风险

RustSec 会报告 Tauri Linux 依赖链中的 GTK3、UNIC 和 `proc-macro-error` 组件已停止维护，以及 `glib 0.18.5` 的 `VariantStrIter` 未定义行为（RUSTSEC-2024-0429）。当前 Windows 发布链不使用这些 GTK3 组件；Linux 构建仍需跟随 Tauri 上游迁移后消除这些警告。CI 只对 `RUSTSEC-2024-0429` 做显式忽略，其他 RustSec 漏洞仍会阻断构建。

## 报告问题

请优先使用仓库的 GitHub Private Vulnerability Reporting，说明受影响版本、复现步骤、影响范围和建议修复方式。不要在公开 issue 中披露可利用细节。
