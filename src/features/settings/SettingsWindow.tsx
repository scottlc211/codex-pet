import type { CSSProperties, PointerEventHandler, ReactNode } from "react";
import {
  Bell,
  EyeOff,
  Maximize2,
  Minus,
  Minimize2,
  Palette,
  Power,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";

export type SettingsSection = "general" | "theme" | "reminder" | "work";

type SettingsWindowProps = {
  nativeWindow: boolean;
  modalStyle?: CSSProperties;
  section: SettingsSection;
  statusLabel: string;
  latestMessage: string;
  children: ReactNode;
  overlay?: ReactNode;
  onSectionChange: (section: SettingsSection) => void;
  onHide: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  maximized: boolean;
  onQuit: () => void;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerEnd: PointerEventHandler<HTMLElement>;
};

const sections = [
  { id: "general", label: "通用", icon: SlidersHorizontal },
  { id: "theme", label: "主题", icon: Palette },
  { id: "reminder", label: "提醒", icon: Bell },
  { id: "work", label: "工作任务", icon: Terminal },
] satisfies Array<{ id: SettingsSection; label: string; icon: typeof SlidersHorizontal }>;

export function SettingsWindow({
  nativeWindow,
  modalStyle,
  section,
  statusLabel,
  latestMessage,
  children,
  overlay,
  onSectionChange,
  onHide,
  onMinimize,
  onMaximize,
  maximized,
  onQuit,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
}: SettingsWindowProps) {
  return (
    <section
      className="settings-modal"
      style={nativeWindow ? undefined : modalStyle}
      role="dialog"
      aria-modal={!nativeWindow}
      aria-label="桌宠设置"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={(event) => event.preventDefault()}
    >
      <aside className="settings-sidebar">
        <header className="settings-drag-handle">
          <span className="eyebrow">Codex Pet</span>
          <h1>设置</h1>
        </header>
        <nav className="settings-menu" aria-label="设置菜单">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              className={section === id ? "active" : ""}
              key={id}
              type="button"
              onClick={() => onSectionChange(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="settings-content">
        <header className="settings-content-header settings-drag-handle">
          <div className="settings-status-summary">
            <span className="status-chip">{statusLabel}</span>
            <p>{latestMessage}</p>
          </div>
          <div className="window-controls" role="group" aria-label="窗口控制">
            <button
              className="window-control-button"
              type="button"
              title="隐藏窗口"
              aria-label="隐藏窗口"
              onClick={onHide}
            >
              <EyeOff size={15} aria-hidden="true" />
            </button>
            <button
              className="window-control-button"
              type="button"
              title="最小化窗口"
              aria-label="最小化窗口"
              onClick={onMinimize}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
            <button
              className="window-control-button"
              type="button"
              title={maximized ? "还原窗口" : "最大化窗口"}
              aria-label={maximized ? "还原窗口" : "最大化窗口"}
              onClick={onMaximize}
            >
              {maximized ? (
                <Minimize2 size={14} aria-hidden="true" />
              ) : (
                <Maximize2 size={14} aria-hidden="true" />
              )}
            </button>
            <button
              className="window-control-button danger"
              type="button"
              title="退出应用"
              aria-label="退出应用"
              onClick={onQuit}
            >
              <Power size={15} aria-hidden="true" />
            </button>
          </div>
        </header>
        {children}
      </section>

      {overlay}
    </section>
  );
}
