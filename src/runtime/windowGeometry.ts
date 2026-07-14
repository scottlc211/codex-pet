import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import { isTauriRuntime } from "./tauri";

export type DragBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type WindowSize = {
  width: number;
  height: number;
};

export async function resizePetWindow(
  containerWidth: number,
  containerHeight: number,
  bubbleReserve: number,
  previousBubbleReserve: number,
) {
  if (!isTauriRuntime) {
    return;
  }

  const appWindow = getCurrentWindow();
  await appWindow.setSize(new LogicalSize(containerWidth, containerHeight + bubbleReserve));
  if (bubbleReserve !== previousBubbleReserve) {
    const position = await appWindow.outerPosition();
    await appWindow.setPosition(
      new PhysicalPosition(position.x, position.y - (bubbleReserve - previousBubbleReserve)),
    );
  }
}

export function monitorDragBounds(monitor: Monitor, windowSize: WindowSize): DragBounds {
  const minX = monitor.workArea.position.x;
  const minY = monitor.workArea.position.y;
  return {
    minX,
    minY,
    maxX: Math.max(minX, minX + monitor.workArea.size.width - windowSize.width),
    maxY: Math.max(minY, minY + monitor.workArea.size.height - windowSize.height),
  };
}

export function modalViewportBounds(width: number, height: number): DragBounds {
  const minX = 8;
  const minY = 8;
  return {
    minX,
    minY,
    maxX: Math.max(minX, window.innerWidth - width - minX),
    maxY: Math.max(minY, window.innerHeight - height - minY),
  };
}

export async function modalMonitorBounds(width: number, height: number): Promise<DragBounds> {
  if (!isTauriRuntime) {
    return modalViewportBounds(width, height);
  }

  const appWindow = getCurrentWindow();
  const [position, scaleFactor, monitor] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.scaleFactor(),
    currentMonitor().then((value) => value ?? primaryMonitor()),
  ]);
  const viewportBounds = modalViewportBounds(width, height);
  if (!monitor) {
    return viewportBounds;
  }

  const margin = 8;
  const minX = (monitor.position.x - position.x) / scaleFactor + margin;
  const minY = (monitor.position.y - position.y) / scaleFactor + margin;
  const maxX =
    (monitor.position.x + monitor.size.width - position.x) / scaleFactor - width - margin;
  const maxY =
    (monitor.position.y + monitor.size.height - position.y) / scaleFactor - height - margin;

  return intersectDragBounds(viewportBounds, {
    minX,
    minY,
    maxX: Math.max(minX, maxX),
    maxY: Math.max(minY, maxY),
  });
}

export function clampWindowPosition(x: number, y: number, bounds: DragBounds | null) {
  if (!bounds) {
    return { x, y };
  }

  return {
    x: clamp(x, bounds.minX, bounds.maxX),
    y: clamp(y, bounds.minY, bounds.maxY),
  };
}

export function clampWindowPositionToBounds(
  x: number,
  y: number,
  boundsList: readonly DragBounds[],
) {
  if (boundsList.length === 0) {
    return { x, y };
  }

  const nearest = boundsList.reduce<{ x: number; y: number; distance: number } | null>(
    (nearest, bounds) => {
      const position = clampWindowPosition(x, y, bounds);
      const distance = Math.hypot(position.x - x, position.y - y);
      return !nearest || distance < nearest.distance ? { ...position, distance } : nearest;
    },
    null,
  );
  return nearest ? { x: nearest.x, y: nearest.y } : { x, y };
}

function intersectDragBounds(base: DragBounds, next: DragBounds): DragBounds {
  const minX = Math.max(base.minX, next.minX);
  const minY = Math.max(base.minY, next.minY);
  return {
    minX,
    minY,
    maxX: Math.max(minX, Math.min(base.maxX, next.maxX)),
    maxY: Math.max(minY, Math.min(base.maxY, next.maxY)),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
