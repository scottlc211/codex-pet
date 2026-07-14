import type { CSSProperties, PointerEventHandler, ReactNode } from "react";
import { Bell, Minus, Palette, Power, SlidersHorizontal, Terminal, X } from "lucide-react";

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
  onClose: () => void;
  onMinimize: () => void;
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
  onClose,
  onMinimize,
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
        <div className="sidebar-actions">
          <button className="icon-button" type="button" title="最小化" onClick={onMinimize}>
            <Minus size={16} />
          </button>
          <button className="icon-button danger" type="button" title="退出应用" onClick={onQuit}>
            <Power size={16} />
          </button>
        </div>
      </aside>

      <section className="settings-content">
        <header className="settings-content-header settings-drag-handle">
          <div>
            <span className="status-chip">{statusLabel}</span>
            <p>{latestMessage}</p>
          </div>
          <button className="icon-button" type="button" title="关闭设置" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {children}
      </section>

      {overlay}
    </section>
  );
}
