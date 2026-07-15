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
- 桌宠与设置窗口独立拖动，支持多显示器位置和设置窗口尺寸恢复
- 右键桌宠或系统托盘可打开设置、显示/隐藏桌宠、切换鼠标穿透或退出应用
- 设置支持容器尺寸、显示偏移、主题、每周或指定日期提醒、诊断恢复和工作任务
- 工作任务支持排队、取消、超时重试、历史记录和打开系统终端

## 目录

```text
pet-assets/               本地宠物资源目录
src/                      React 桌宠界面
src-tauri/                Tauri / Rust 后端
.github/workflows/        Windows/Linux 构建、测试、依赖审计与发布
```

## 开发环境

通用工具版本：

- Node.js 22.13+
- pnpm 11.13.0
- Rust 1.97.0，项目通过 `rust-toolchain.toml` 固定

Windows 还需要安装：

- Microsoft C++ Build Tools，勾选“使用 C++ 的桌面开发”
- WebView2 Runtime，Windows 10/11 通常已经包含

Ubuntu 22.04、Ubuntu 24.04 或 WSL Ubuntu 安装 Tauri 依赖：

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  file \
  libappindicator3-dev \
  libgtk-3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  patchelf \
  pkg-config \
  xdg-utils
```

运行 AppImage 时，Ubuntu 22.04 还需要 `libfuse2`；Ubuntu 24.04 对应包名为 `libfuse2t64`。

WSL 中可以编译 Linux 安装包，但不能直接产出本机 Windows MSI/NSIS 安装包。运行图形界面需要 Windows 11 WSLg，并且 WSLg 下的托盘行为可能与原生桌面不同；Windows 安装包应在 Windows 或 GitHub Actions 中构建。

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

只启动浏览器前端调试：

```bash
pnpm dev
```

浏览器模式不提供系统托盘、原生窗口、通知和终端调用。完整功能必须通过 `pnpm tauri dev` 验证。

执行前端类型检查和生产构建：

```bash
pnpm build
```

运行前端配置与提醒逻辑测试：

```bash
pnpm test
```

运行前端测试、构建和 Rust 测试：

```bash
pnpm check
```

`src-tauri/Cargo.lock` 和 `rust-toolchain.toml` 已纳入版本控制，保证 Rust 依赖和工具链可复现。

## 本地打包

Windows PowerShell：

```powershell
pnpm install --frozen-lockfile
pnpm bundle:windows
```

输出目录：

```text
src-tauri/target/release/codex-pet.exe
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

Ubuntu、WSL 或其他兼容 Debian 系统：

```bash
pnpm install --frozen-lockfile
pnpm bundle:linux
```

输出目录：

```text
src-tauri/target/release/codex-pet
src-tauri/target/release/bundle/deb/
src-tauri/target/release/bundle/appimage/
```

## CI 与发布

`.github/workflows/desktop-ci.yml` 会在真实的 `windows-latest` 和 `ubuntu-22.04` runner 上执行依赖审计、测试、Rustfmt、Clippy 和 Tauri 安装包构建。每个平台的产物都包含独立的 `SHA256SUMS-*.txt`，Actions 构建记录保留 14 天。

推送与应用版本一致的标签会自动创建或更新 GitHub Release：

```bash
git tag v0.1.0
git push origin v0.1.0
```

标签允许小写 `v` 或大写 `V`，但标签中的版本必须同时匹配 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json`。当前流水线未配置 Windows 代码签名，下载的安装包可能触发 SmartScreen 提示；正式分发前应配置可信代码签名证书。

## 桌宠操作

```text
左键按住人物拖动    移动桌宠位置，拖动方向会切换左右奔跑动作
右键人物            打开桌宠菜单
菜单 > 设置         首次居中打开独立设置窗口，之后恢复上次位置
菜单 > 隐藏桌宠     隐藏桌宠，之后可从系统托盘或设置中恢复
菜单 > 鼠标穿透    切换桌宠是否接收鼠标事件，可从托盘恢复
菜单 > 退出         关闭桌宠、设置窗口和后台任务
托盘左键            显示并聚焦桌宠
托盘 > 显示/隐藏   切换桌宠显示状态
关闭设置窗口        只隐藏设置窗口，不退出应用或改变桌宠显示状态
设置 > 通用         调整桌宠显示、人物、容器、偏移、渲染与鼠标穿透
设置 > 主题         以卡片形式切换已扫描到的本地宠物主题
设置 > 提醒         添加、编辑、删除每周或指定日期的一次性提醒
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
