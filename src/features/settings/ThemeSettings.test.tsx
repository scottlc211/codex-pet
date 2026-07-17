import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PetCandidate } from "../pet/model";
import { ThemeDeleteConfirmation, ThemeSettings } from "./ThemeSettings";

const deletableTheme: PetCandidate = {
  name: "可删除主题",
  path: "/pets/managed/theme",
  kind: "state-package",
  canDelete: true,
  states: { idle: { kind: "image", path: "/pets/managed/theme/idle.png" } },
};

const protectedTheme: PetCandidate = {
  ...deletableTheme,
  name: "受保护主题",
  path: "/pets/protected/theme",
  canDelete: false,
};

describe("ThemeSettings", () => {
  it("only offers uninstall for themes managed by Codex Pet", () => {
    const markup = renderToStaticMarkup(
      <ThemeSettings
        candidates={[deletableTheme, protectedTheme]}
        activePet={deletableTheme}
        packagePath=""
        importing={false}
        renderMode="smooth"
        stateActionOverrides={{}}
        onRefresh={vi.fn()}
        onSelectDefault={vi.fn()}
        onSelect={vi.fn()}
        onRequestDelete={vi.fn()}
        onPackagePathChange={vi.fn()}
        onImport={vi.fn()}
        onStateActionChange={vi.fn()}
        onResetStateActions={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="卸载主题：可删除主题"');
    expect(markup).not.toContain('aria-label="卸载主题：受保护主题"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("renders a preview and an independently configurable selector for every pet state", () => {
    const markup = renderToStaticMarkup(
      <ThemeSettings
        candidates={[deletableTheme]}
        activePet={deletableTheme}
        packagePath=""
        importing={false}
        renderMode="smooth"
        stateActionOverrides={{ waiting_input: "idle" }}
        onRefresh={vi.fn()}
        onSelectDefault={vi.fn()}
        onSelect={vi.fn()}
        onRequestDelete={vi.fn()}
        onPackagePathChange={vi.fn()}
        onImport={vi.fn()}
        onStateActionChange={vi.fn()}
        onResetStateActions={vi.fn()}
      />,
    );

    expect(markup).toContain("状态动作");
    expect(markup).toContain("图集固定为 8 列 × 9 行");
    expect(markup).toContain('aria-label="预览：等待状态"');
    expect(markup).toContain('id="state-action-select-carrying"');
    expect(markup).toContain('data-customized="true"');
    expect(markup.match(/class="state-action-card /g)).toHaveLength(13);
  });

  it("announces the irreversible deletion and busy state", () => {
    const markup = renderToStaticMarkup(
      <ThemeDeleteConfirmation
        theme={deletableTheme}
        deleting
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("此操作无法撤销");
    expect(markup).toContain("卸载中");
    expect(markup).toContain("disabled");
  });
});
