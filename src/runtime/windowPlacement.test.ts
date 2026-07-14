import { describe, expect, it } from "vitest";
import type { Monitor } from "@tauri-apps/api/window";
import { resolveWindowPlacement, type StoredWindowPlacement } from "./windowPlacement";

function monitor(
  name: string,
  x: number,
  width: number,
  height: number,
  scaleFactor: number,
) {
  return {
    name,
    scaleFactor,
    position: { x, y: 0 },
    size: { width, height },
    workArea: { position: { x, y: 0 }, size: { width, height } },
  } as unknown as Monitor;
}

const placement: StoredWindowPlacement = {
  schemaVersion: 1,
  monitorName: "secondary",
  absoluteX: 2100,
  absoluteY: 100,
  relativeX: 100,
  relativeY: 50,
  width: 760,
  height: 520,
};

describe("window placement", () => {
  it("按目标显示器 DPI 恢复相对位置和窗口尺寸", () => {
    const resolved = resolveWindowPlacement(
      placement,
      [monitor("primary", 0, 1920, 1080, 1), monitor("secondary", 1920, 3000, 1800, 1.5)],
      { width: 760, height: 520 },
      true,
    );

    expect(resolved).toEqual({
      position: { x: 2070, y: 75 },
      size: { width: 1140, height: 780 },
    });
  });

  it("显示器名称失效时选择离原坐标最近的屏幕", () => {
    const resolved = resolveWindowPlacement(
      { ...placement, monitorName: "removed" },
      [monitor("primary", 0, 1920, 1080, 1), monitor("replacement", 1920, 2560, 1440, 1)],
      { width: 260, height: 260 },
    );

    expect(resolved?.position).toEqual({ x: 2020, y: 50 });
  });
});
