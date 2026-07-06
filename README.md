# Codex Pet

一个轻量 Tauri 桌宠壳，用本地动画包展示宠物，并在需要时调用或监听 Codex CLI。

## 功能

- 透明、无边框、置顶桌面窗口
- 支持本地 `.png`、`.webp`、`.gif`、`.svg`、`.apng` 宠物资源
- 支持 `pet.json` / `theme.json` 状态动画包
- 支持 Codex Pet atlas 包目录或 `.zip` 导入
- 自动扫描 `~/.codex/pets`、`~/.codex`、当前项目 `pet-assets`
- 点击发送任务后，由 Rust 后端受控启动 `codex exec --json`
- 轮询 `~/.codex/sessions`，把 Codex JSONL session 状态映射成桌宠动画
- 桌宠窗口支持拖动、缩小/展开、最小化、关闭

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

## 使用本地宠物和动画包

推荐把资源放到：

```text
D:\A_STUDY\codex-pet\pet-assets\
```

在 WSL/Linux 环境中，对应路径通常是：

```text
/mnt/d/A_STUDY/codex-pet/pet-assets/
```

桌宠允许直接输入以下路径：

```text
单个图片 / GIF / WebP / APNG
动画包目录
Codex Pet zip 包
```

若路径不在允许范围内，需要更新 `src-tauri/tauri.conf.json` 的 `assetProtocol.scope`。

### 状态动画包格式

最小包结构：

```text
my-pet/
  pet.json
  idle.webp
  thinking.webp
  working.webp
  success.webp
  error.webp
```

`pet.json`：

```json
{
  "name": "My Pet",
  "states": {
    "idle": "idle.webp",
    "thinking": "thinking.webp",
    "working": "working.webp",
    "running_command": "working.webp",
    "editing_file": "working.webp",
    "waiting_input": "thinking.webp",
    "success": "success.webp",
    "error": "error.webp",
    "dragging": "working.webp"
  }
}
```

当前支持的状态名：

```text
idle
thinking
working
running_command
editing_file
waiting_input
success
error
dragging
sweeping
carrying
```

### Codex Pet atlas 包

如果包内 `pet.json` 包含 `spritesheetPath`，桌宠会按 Codex Pet atlas 的行列切动画：

```text
idle              -> idle row
thinking          -> review row
running_command   -> running row
editing_file      -> running row
waiting_input     -> waiting row
success           -> jumping row
error             -> failed row
dragging          -> running row
```

## Codex CLI

桌宠调用的是本机 `codex` 命令：

```bash
codex exec --json "你的任务"
```

如果任务目录不是 Git 仓库，后端会自动附加 `--skip-git-repo-check`。

桌宠启动后也会监听：

```text
~/.codex/sessions/**/rollout-*.jsonl
```

因此你在外部终端运行 Codex CLI 时，近期活动也会驱动桌宠状态。这个监听是 JSONL fallback，不会接管 Codex 的审批或终端输入。
