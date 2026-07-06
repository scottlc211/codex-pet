# Codex Pet

一个轻量 Tauri 桌宠壳，用本地图片资源展示宠物，并在需要时调用 `codex exec --json`。

## 功能

- 透明、无边框、置顶桌面窗口
- 支持本地 `.png`、`.webp`、`.gif`、`.svg`、`.apng` 宠物资源
- 自动扫描 `~/.codex/pets`、`~/.codex`、当前项目 `pet-assets`
- 点击发送任务后，由 Rust 后端受控启动 `codex exec --json`
- 将 Codex JSONL 事件映射成桌宠状态日志

## 目录

```text
pet-assets/               本地宠物资源目录
src/                      React 桌宠界面
src-tauri/                Tauri / Rust 后端
```

## 运行

```bash
pnpm install
pnpm tauri dev
```

当前环境需要先安装 Tauri 桌面编译依赖：

- Rust / Cargo
- Windows 运行：Microsoft C++ Build Tools
- Linux/WSL 运行：WebKitGTK 与 librsvg 相关依赖

只检查前端：

```bash
pnpm build
```

## 使用本地宠物

推荐把资源放到：

```text
D:\A_STUDY\pets\pet-assets\
```

在 WSL/Linux 环境中，对应路径通常是：

```text
/mnt/d/A_STUDY/pets/pet-assets/
```

桌宠也允许直接输入宠物文件路径。若路径不在允许范围内，需要更新 `src-tauri/tauri.conf.json` 的 `assetProtocol.scope`。

## Codex CLI

桌宠调用的是本机 `codex` 命令：

```bash
codex exec --json "你的任务"
```

如果任务目录不是 Git 仓库，后端会自动附加 `--skip-git-repo-check`。
