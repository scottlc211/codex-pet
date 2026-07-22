import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
} from "@tauri-apps/api/window";
import { useEffect } from "react";
import { isTauriRuntime, releaseTauriListener } from "./tauri";
import { clampWindowPosition, monitorDragBounds } from "./windowGeometry";

type WindowLabel = "main" | "settings";

export type StoredWindowPlacement = {
  schemaVersion: 1;
  monitorName: string | null;
  absoluteX: number;
  absoluteY: number;
  relativeX: number;
  relativeY: number;
  width: number;
  height: number;
};

export type ResolvedWindowPlacement = {
  position: { x: number; y: number };
  size: { width: number; height: number };
};

type WindowSize = { width: number; height: number };

const placementKeyPrefix = "codex-pet:window-placement:";

export function useWindowPlacement(label: WindowLabel, restoreSize: boolean) {
  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    const appWindow = getCurrentWindow();
    let saveTimer: number | null = null;
    const scheduleSave = () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
      }
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void saveCurrentWindowPlacement(label).catch(() => undefined);
      }, 250);
    };

    void restoreCurrentWindowPlacement(label, restoreSize).catch(() => undefined);
    const unlistenMoved = appWindow.onMoved(scheduleSave).catch(() => () => undefined);
    const unlistenResized = appWindow.onResized(scheduleSave).catch(() => () => undefined);
    return () => {
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
      }
      releaseTauriListener(unlistenMoved);
      releaseTauriListener(unlistenResized);
    };
  }, [label, restoreSize]);
}

export function resolveWindowPlacement(
  placement: StoredWindowPlacement,
  monitors: readonly Monitor[],
  currentSize: WindowSize,
  restoreSize = false,
): ResolvedWindowPlacement | null {
  const monitor = selectPlacementMonitor(placement, monitors);
  if (!monitor) {
    return null;
  }

  const width = Math.max(1, Math.round(placement.width * monitor.scaleFactor));
  const height = Math.max(1, Math.round(placement.height * monitor.scaleFactor));
  const targetSize = {
    width: restoreSize ? width : currentSize.width,
    height: restoreSize ? height : currentSize.height,
  };
  const bounds = monitorDragBounds(monitor, targetSize);
  const position = clampWindowPosition(
    Math.round(monitor.workArea.position.x + placement.relativeX * monitor.scaleFactor),
    Math.round(monitor.workArea.position.y + placement.relativeY * monitor.scaleFactor),
    bounds,
  );
  return { position, size: { width, height } };
}

async function restoreCurrentWindowPlacement(label: WindowLabel, restoreSize: boolean) {
  const placement = readWindowPlacement(label);
  if (!placement) {
    return;
  }

  const appWindow = getCurrentWindow();
  const [monitors, currentSize] = await Promise.all([availableMonitors(), appWindow.outerSize()]);
  const resolved = resolveWindowPlacement(placement, monitors, currentSize, restoreSize);
  if (!resolved) {
    return;
  }
  if (restoreSize) {
    await appWindow.setSize(new PhysicalSize(resolved.size.width, resolved.size.height));
  }
  await appWindow.setPosition(
    new PhysicalPosition(resolved.position.x, resolved.position.y),
  );
}

async function saveCurrentWindowPlacement(label: WindowLabel) {
  const appWindow = getCurrentWindow();
  const maximized = await appWindow.isMaximized().catch(() => false);
  if (maximized) {
    return;
  }
  const [position, size, monitor] = await Promise.all([
    appWindow.outerPosition(),
    appWindow.outerSize(),
    currentMonitor().then((value) => value ?? primaryMonitor()),
  ]);
  if (!monitor || !Number.isFinite(monitor.scaleFactor) || monitor.scaleFactor <= 0) {
    return;
  }

  const placement: StoredWindowPlacement = {
    schemaVersion: 1,
    monitorName: monitor.name,
    absoluteX: position.x,
    absoluteY: position.y,
    relativeX: (position.x - monitor.workArea.position.x) / monitor.scaleFactor,
    relativeY: (position.y - monitor.workArea.position.y) / monitor.scaleFactor,
    width: size.width / monitor.scaleFactor,
    height: size.height / monitor.scaleFactor,
  };
  try {
    window.localStorage.setItem(`${placementKeyPrefix}${label}`, JSON.stringify(placement));
  } catch {
    // Window placement is optional and must never block dragging or shutdown.
  }
}

function readWindowPlacement(label: WindowLabel): StoredWindowPlacement | null {
  try {
    const stored = window.localStorage.getItem(`${placementKeyPrefix}${label}`);
    if (!stored) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      return null;
    }
    const placement: StoredWindowPlacement = {
      schemaVersion: 1,
      monitorName: typeof parsed.monitorName === "string" ? parsed.monitorName : null,
      absoluteX: finiteNumber(parsed.absoluteX),
      absoluteY: finiteNumber(parsed.absoluteY),
      relativeX: finiteNumber(parsed.relativeX),
      relativeY: finiteNumber(parsed.relativeY),
      width: positiveNumber(parsed.width),
      height: positiveNumber(parsed.height),
    };
    return placement;
  } catch {
    return null;
  }
}

function selectPlacementMonitor(
  placement: StoredWindowPlacement,
  monitors: readonly Monitor[],
) {
  const named = placement.monitorName
    ? monitors.find((monitor) => monitor.name === placement.monitorName)
    : undefined;
  if (named) {
    return named;
  }
  const containing = monitors.find((monitor) => {
    const { position, size } = monitor.workArea;
    return (
      placement.absoluteX >= position.x &&
      placement.absoluteX < position.x + size.width &&
      placement.absoluteY >= position.y &&
      placement.absoluteY < position.y + size.height
    );
  });
  if (containing) {
    return containing;
  }
  return monitors.reduce<Monitor | null>((nearest, monitor) => {
    if (!nearest) {
      return monitor;
    }
    return monitorDistance(placement, monitor) < monitorDistance(placement, nearest)
      ? monitor
      : nearest;
  }, null);
}

function monitorDistance(placement: StoredWindowPlacement, monitor: Monitor) {
  const { position, size } = monitor.workArea;
  const nearestX = Math.max(position.x, Math.min(placement.absoluteX, position.x + size.width));
  const nearestY = Math.max(position.y, Math.min(placement.absoluteY, position.y + size.height));
  return Math.hypot(placement.absoluteX - nearestX, placement.absoluteY - nearestY);
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
