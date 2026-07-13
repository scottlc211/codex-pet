# Codex Pet

一个轻量 Tauri 桌宠壳，用本地动画包展示宠物，并在需要时调用或监听 Codex CLI。

## 功能

- 透明、无边框、置顶桌面窗口
- 支持本地 `.png`、`.webp`、`.gif`、`.svg`、`.apng` 宠物资源
- 支持 `pet.json` / `theme.json` 状态动画包
- 支持 Codex Pet atlas 包目录或 `.zip` 导入
- 自动扫描 `~/.codex/pets` 和 `~/.codex-pet/pets`
- 点击发送任务后，由 Rust 后端受控启动 `codex exec --json`
- 轮询 `~/.codex/sessions`，把 Codex JSONL session 状态映射成桌宠动画
- 左键拖动桌宠，右键打开菜单，点击设置后显示居中设置弹窗
- 设置弹窗支持通用、主题、工作任务三类配置
- 工作任务支持输入目录并打开系统终端

## 目录

```text
pet-assets/               本地宠物资源目录
src/                      React 桌宠界面
src-tauri/                Tauri / Rust 后端
.github/workflows/        Windows 构建、测试与依赖审计
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

运行前端构建和 Rust 测试：

```bash
pnpm check
```

`src-tauri/Cargo.lock` 和 `rust-toolchain.toml` 已纳入版本控制，保证 Rust 依赖和工具链可复现。

## 桌宠操作

```text
左键按住人物拖动    移动桌宠位置，拖动方向会切换左右奔跑动作
右键人物            打开桌宠菜单
菜单 > 设置         在屏幕中央打开设置弹窗
设置 > 通用         调整人物大小和平滑 / 像素渲染
设置 > 主题         以卡片形式切换已扫描到的本地宠物主题
设置 > 工作任务     输入目录、打开终端或发送 Codex 任务
```

## 使用本地宠物和动画包

推荐把长期使用的资源放到：

```text
~/.codex-pet/pets/
```

也可以在设置中直接输入任意本地目录、zip 或图片路径。导入后，应用只复制受支持的清单和图片到受控目录，不会直接暴露原始目录。

自动扫描还兼容 Codex 自带宠物目录：

```text
~/.codex/pets/
```

桌宠允许直接输入以下路径：

```text
单个图片 / GIF / WebP / APNG
动画包目录
Codex Pet zip 包
```

导入限制：

- zip 压缩包最大 80 MiB
- 单个资源最大 30 MiB，清单最大 256 KiB
- 单次导入最多 512 个文件、总计 120 MiB、最多 16 层目录
- 拒绝路径穿越和目录内符号链接

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
dragging_left
dragging_right
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
dragging_left     -> running-left row
dragging_right    -> running-right row
```

## Codex CLI

桌宠调用的是本机 `codex` 命令：

```bash
printf '%s' "你的任务" | codex exec --json -
```

如果任务目录不是 Git 仓库，后端会自动附加 `--skip-git-repo-check`。
任务正文通过标准输入传递，不参与 shell 命令拼接；同一时间只允许一个由桌宠启动的 Codex 任务。

桌宠启动后也会监听：

```text
~/.codex/sessions/**/rollout-*.jsonl
```

因此你在外部终端运行 Codex CLI 时，近期活动也会驱动桌宠状态。这个监听是 JSONL fallback，不会接管 Codex 的审批或终端输入。

## 安全

安全边界、依赖审计和已知上游风险见 [SECURITY.md](SECURITY.md)。
