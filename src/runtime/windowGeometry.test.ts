import { describe, expect, it } from "vitest";
import {
  clampWindowPosition,
  clampWindowPositionToBounds,
  type DragBounds,
} from "./windowGeometry";

const bounds: DragBounds = {
  minX: 10,
  minY: 20,
  maxX: 300,
  maxY: 400,
};

describe("clampWindowPosition", () => {
  it("保留边界内的位置", () => {
    expect(clampWindowPosition(120, 240, bounds)).toEqual({ x: 120, y: 240 });
  });

  it("将窗口位置限制在可见区域", () => {
    expect(clampWindowPosition(-20, 500, bounds)).toEqual({ x: 10, y: 400 });
  });

  it("没有边界信息时保留原坐标", () => {
    expect(clampWindowPosition(-20, 500, null)).toEqual({ x: -20, y: 500 });
  });

  it("跨屏拖动时选择距离目标最近的显示器边界", () => {
    const second = { minX: 400, minY: 0, maxX: 700, maxY: 400 };
    expect(clampWindowPositionToBounds(450, 100, [bounds, second])).toEqual({ x: 450, y: 100 });
    expect(clampWindowPositionToBounds(360, 100, [bounds, second])).toEqual({ x: 400, y: 100 });
  });
});
