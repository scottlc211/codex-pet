import {
  isPetState,
  type PetStateActionOverrides,
} from "../features/pet/model";

export type RenderMode = "smooth" | "pixelated";

export type PetPreferences = {
  petSize: number;
  petContainerWidth: number;
  petContainerHeight: number;
  petOffsetX: number;
  petOffsetY: number;
  clickThrough: boolean;
  renderMode: RenderMode;
  packagePath: string;
  stateActionOverrides: PetStateActionOverrides;
};

export type WorkPreferences = {
  workdir: string;
  codexPath: string;
  terminalId: string;
  taskTimeoutMinutes: number;
  taskMaxRetries: number;
};

export type AppPreferences = {
  schemaVersion: 1;
  pet: PetPreferences;
  work: WorkPreferences;
};

export type PreferencesLoadStatus =
  | "healthy"
  | "recoveredFromBackup"
  | "migratedLegacy"
  | "defaultsAfterInvalid"
  | "defaultsAfterMissing"
  | "storageUnavailable";

export type PreferencesLoadResult = {
  preferences: AppPreferences;
  status: PreferencesLoadStatus;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const appPreferencesKey = "codex-pet:preferences";
export const appPreferencesBackupKey = "codex-pet:preferences:backup";
export const defaultPetSize = 236;
export const defaultPetContainerWidth = 260;
export const defaultPetContainerHeight = 260;
export const minPetContainerDimension = 120;
export const maxPetContainerDimension = 420;
export const petVisualOffsetLimit = 36;
export const autoTerminalId = "auto";
export const defaultTaskTimeoutMinutes = 30;
export const minTaskTimeoutMinutes = 1;
export const maxTaskTimeoutMinutes = 240;
export const maxTaskRetries = 3;

const legacyKeys = {
  packagePath: "codex-pet:package-path",
  workdir: "codex-pet:workdir",
  codexPath: "codex-pet:codex-path",
  petSize: "codex-pet:pet-size",
  petContainerWidth: "codex-pet:pet-container-width",
  petContainerHeight: "codex-pet:pet-container-height",
  petOffsetX: "codex-pet:pet-offset-x",
  petOffsetY: "codex-pet:pet-offset-y",
  renderMode: "codex-pet:render-mode",
  terminalId: "codex-pet:terminal",
} as const;

const defaultPetPreferences: PetPreferences = {
  petSize: defaultPetSize,
  petContainerWidth: defaultPetContainerWidth,
  petContainerHeight: defaultPetContainerHeight,
  petOffsetX: 0,
  petOffsetY: 0,
  clickThrough: false,
  renderMode: "smooth",
  packagePath: "",
  stateActionOverrides: {},
};

const defaultWorkPreferences: WorkPreferences = {
  workdir: "",
  codexPath: "",
  terminalId: autoTerminalId,
  taskTimeoutMinutes: defaultTaskTimeoutMinutes,
  taskMaxRetries: 0,
};

export function loadAppPreferences(storage: PreferenceStorage = window.localStorage): AppPreferences {
  return loadAppPreferencesWithStatus(storage).preferences;
}

export function loadAppPreferencesWithStatus(
  storage: PreferenceStorage = window.localStorage,
): PreferencesLoadResult {
  const current = tryReadStorageValue(storage, appPreferencesKey);
  if (current.error) {
    return { preferences: defaultAppPreferences(), status: "storageUnavailable" };
  }

  const currentPreferences = parseAppPreferences(current.value);
  if (currentPreferences) {
    return { preferences: currentPreferences, status: "healthy" };
  }

  const backup = tryReadStorageValue(storage, appPreferencesBackupKey);
  if (backup.error) {
    return { preferences: defaultAppPreferences(), status: "storageUnavailable" };
  }
  const backupPreferences = parseAppPreferences(backup.value);
  if (backupPreferences) {
    try {
      storage.setItem(appPreferencesKey, JSON.stringify(backupPreferences));
    } catch {
      // Recovery can still continue in memory when localStorage is read-only.
    }
    return { preferences: backupPreferences, status: "recoveredFromBackup" };
  }

  const legacyPreferences = normalizeAppPreferences({
    schemaVersion: 1,
    pet: {
      petSize: readStorageValue(storage, legacyKeys.petSize),
      petContainerWidth: readStorageValue(storage, legacyKeys.petContainerWidth),
      petContainerHeight: readStorageValue(storage, legacyKeys.petContainerHeight),
      petOffsetX: readStorageValue(storage, legacyKeys.petOffsetX),
      petOffsetY: readStorageValue(storage, legacyKeys.petOffsetY),
      renderMode: readStorageValue(storage, legacyKeys.renderMode),
      packagePath: readStorageValue(storage, legacyKeys.packagePath),
    },
    work: {
      workdir: readStorageValue(storage, legacyKeys.workdir),
      codexPath: readStorageValue(storage, legacyKeys.codexPath),
      terminalId: readStorageValue(storage, legacyKeys.terminalId),
      taskTimeoutMinutes: defaultTaskTimeoutMinutes,
      taskMaxRetries: 0,
    },
  });
  const hasLegacyValue = Object.values(legacyKeys).some(
    (key) => readStorageValue(storage, key) !== null,
  );
  if (hasLegacyValue) {
    return { preferences: legacyPreferences, status: "migratedLegacy" };
  }

  return {
    preferences: defaultAppPreferences(),
    status:
      current.value !== null || backup.value !== null
        ? "defaultsAfterInvalid"
        : "defaultsAfterMissing",
  };
}

export function saveAppPreferences(
  preferences: AppPreferences,
  storage: PreferenceStorage = window.localStorage,
): string | null {
  const normalized = normalizeAppPreferences(preferences);
  try {
    const current = storage.getItem(appPreferencesKey);
    if (parseAppPreferences(current)) {
      storage.setItem(appPreferencesBackupKey, current as string);
    }
    storage.setItem(appPreferencesKey, JSON.stringify(normalized));
  } catch (error) {
    return storageErrorMessage(error);
  }

  for (const key of Object.values(legacyKeys)) {
    try {
      storage.removeItem(key);
    } catch {
      // The versioned value is already durable; legacy cleanup is best effort.
    }
  }
  return null;
}

export function defaultAppPreferences(): AppPreferences {
  return {
    schemaVersion: 1,
    pet: { ...defaultPetPreferences, stateActionOverrides: {} },
    work: { ...defaultWorkPreferences },
  };
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  const root = isRecord(value) ? value : {};
  const pet = isRecord(root.pet) ? root.pet : {};
  const work = isRecord(root.work) ? root.work : {};

  return {
    schemaVersion: 1,
    pet: normalizePetPreferences(pet),
    work: {
      workdir: stringValue(work.workdir, defaultWorkPreferences.workdir),
      codexPath: stringValue(work.codexPath, defaultWorkPreferences.codexPath),
      terminalId: stringValue(work.terminalId, defaultWorkPreferences.terminalId) || autoTerminalId,
      taskTimeoutMinutes: clampTaskTimeoutMinutes(Number(work.taskTimeoutMinutes)),
      taskMaxRetries: clampTaskRetries(Number(work.taskMaxRetries)),
    },
  };
}

export function normalizePetPreferences(value: unknown): PetPreferences {
  const preferences = isRecord(value) ? value : {};
  return {
    petSize: clampPetSize(Number(preferences.petSize)),
    petContainerWidth: clampPetContainerDimension(Number(preferences.petContainerWidth)),
    petContainerHeight: clampPetContainerDimension(Number(preferences.petContainerHeight)),
    petOffsetX: clampPetOffset(Number(preferences.petOffsetX)),
    petOffsetY: clampPetOffset(Number(preferences.petOffsetY)),
    clickThrough: preferences.clickThrough === true,
    renderMode: preferences.renderMode === "pixelated" ? "pixelated" : "smooth",
    packagePath: stringValue(preferences.packagePath, defaultPetPreferences.packagePath),
    stateActionOverrides: normalizeStateActionOverrides(preferences.stateActionOverrides),
  };
}

export function clampPetSize(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPetSize;
  }
  return clamp(Math.round(value), 150, 330);
}

export function clampPetContainerDimension(value: number) {
  if (!Number.isFinite(value)) {
    return defaultPetContainerWidth;
  }
  return clamp(Math.round(value), minPetContainerDimension, maxPetContainerDimension);
}

export function clampPetOffset(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(Math.round(value), -petVisualOffsetLimit, petVisualOffsetLimit);
}

export function clampTaskTimeoutMinutes(value: number) {
  if (!Number.isFinite(value)) {
    return defaultTaskTimeoutMinutes;
  }
  return clamp(Math.round(value), minTaskTimeoutMinutes, maxTaskTimeoutMinutes);
}

export function clampTaskRetries(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clamp(Math.round(value), 0, maxTaskRetries);
}

function readStorageValue(storage: PreferenceStorage, key: string) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function tryReadStorageValue(storage: PreferenceStorage, key: string) {
  try {
    return { value: storage.getItem(key), error: false };
  } catch {
    return { value: null, error: true };
  }
}

function parseAppPreferences(value: string | null): AppPreferences | null {
  if (!value) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed.schemaVersion === 1
      ? normalizeAppPreferences(parsed)
      : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStateActionOverrides(value: unknown): PetStateActionOverrides {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([themePath, rawOverrides]) => {
      if (!themePath.trim() || !isRecord(rawOverrides)) {
        return [];
      }
      const stateOverrides = Object.fromEntries(
        Object.entries(rawOverrides).filter(
          (entry): entry is [string, string] =>
            isPetState(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1].trim()),
        ),
      );
      return Object.keys(stateOverrides).length > 0 ? [[themePath, stateOverrides]] : [];
    }),
  ) as PetStateActionOverrides;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function storageErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
