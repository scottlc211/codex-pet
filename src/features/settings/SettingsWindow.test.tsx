import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsWindow } from "./SettingsWindow";

function renderSettingsWindow(maximized = false) {
  return renderToStaticMarkup(
    <SettingsWindow
      nativeWindow
      section="general"
      statusLabel="空闲"
      latestMessage="准备就绪"
      onSectionChange={vi.fn()}
      onHide={vi.fn()}
      onMinimize={vi.fn()}
      onMaximize={vi.fn()}
      maximized={maximized}
      onQuit={vi.fn()}
      onPointerDown={vi.fn()}
      onPointerMove={vi.fn()}
      onPointerEnd={vi.fn()}
    >
      <div>设置内容</div>
    </SettingsWindow>,
  );
}

describe("SettingsWindow", () => {
  it("groups every window action in the top-right header", () => {
    const markup = renderSettingsWindow();

    expect(markup).toContain('class="window-controls"');
    expect(markup).toContain('aria-label="窗口控制"');
    expect(markup).toContain('aria-label="隐藏窗口"');
    expect(markup).toContain('aria-label="最小化窗口"');
    expect(markup).toContain('aria-label="最大化窗口"');
    expect(markup).toContain('aria-label="退出应用"');
    expect(markup).not.toContain("sidebar-actions");
  });

  it("shows the restore action while the window is maximized", () => {
    expect(renderSettingsWindow(true)).toContain('aria-label="还原窗口"');
  });
});
