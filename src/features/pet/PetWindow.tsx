import type { MouseEventHandler, PointerEventHandler } from "react";
import { EyeOff, MousePointer2, MousePointer2Off, Power, Settings, X } from "lucide-react";
import type { RenderMode } from "../../config/preferences";
import { PetVisualView } from "./PetVisualView";
import type { PetState, PetVisual } from "./model";

export type PetBubble = {
  tone: "working" | "success" | "error" | "reminder";
  label: string;
  message: string;
  dismissible?: boolean;
  source?: "status" | "reminder";
};

type PetWindowProps = {
  state: PetState;
  renderMode: RenderMode;
  visual: PetVisual | null;
  visualIdentity: string;
  petSize: number;
  bubble: PetBubble | null;
  contextMenuOpen: boolean;
  clickThrough: boolean;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerEnd: PointerEventHandler<HTMLElement>;
  onContextMenu: MouseEventHandler<HTMLElement>;
  onCloseBubble: () => void;
  onOpenSettings: () => void;
  onHidePet: () => void;
  onToggleClickThrough: () => void;
  onQuit: () => void;
};

export function PetWindow({
  state,
  renderMode,
  visual,
  visualIdentity,
  petSize,
  bubble,
  contextMenuOpen,
  clickThrough,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onContextMenu,
  onCloseBubble,
  onOpenSettings,
  onHidePet,
  onToggleClickThrough,
  onQuit,
}: PetWindowProps) {
  return (
    <>
      <section
        className={`pet-stage state-${state} render-${renderMode} ${bubble ? "has-bubble" : ""}`}
        aria-label="桌宠"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onContextMenu={onContextMenu}
      >
        {bubble && (
          <div
            className={`pet-bubble tone-${bubble.tone} ${bubble.dismissible ? "is-dismissible" : ""}`}
            role="status"
            aria-live="polite"
          >
            <div className="pet-bubble-header">
              <strong>{bubble.label}</strong>
              {bubble.dismissible && (
                <button
                  className="pet-bubble-close"
                  type="button"
                  aria-label="关闭状态提示"
                  title="关闭状态提示"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseBubble();
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <span>{bubble.message}</span>
          </div>
        )}
        <PetVisualView
          key={visualIdentity}
          visual={visual}
          state={state}
          renderMode={renderMode}
          petSize={petSize}
        />
      </section>

      {contextMenuOpen && (
        <div
          className="context-tablist"
          role="menu"
          aria-label="桌宠菜单"
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={onOpenSettings}>
            <Settings size={16} />
            <span>设置</span>
          </button>
          <button type="button" role="menuitem" onClick={onHidePet}>
            <EyeOff size={16} />
            <span>隐藏桌宠</span>
          </button>
          <button type="button" role="menuitem" onClick={onToggleClickThrough}>
            {clickThrough ? <MousePointer2 size={16} /> : <MousePointer2Off size={16} />}
            <span>{clickThrough ? "关闭鼠标穿透" : "鼠标穿透"}</span>
          </button>
          <button className="danger" type="button" role="menuitem" onClick={onQuit}>
            <Power size={16} />
            <span>退出</span>
          </button>
        </div>
      )}
    </>
  );
}
