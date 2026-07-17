import { describe, expect, it } from "vitest";
import {
  appPreferencesBackupKey,
  appPreferencesKey,
  loadAppPreferences,
  loadAppPreferencesWithStatus,
  normalizePetPreferences,
  saveAppPreferences,
} from "./preferences";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("app preferences", () => {
  it("migrates and normalizes legacy preference keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("codex-pet:pet-size", "999");
    storage.setItem("codex-pet:pet-container-width", "80");
    storage.setItem("codex-pet:render-mode", "pixelated");
    storage.setItem("codex-pet:workdir", "D:\\work");

    const preferences = loadAppPreferences(storage);

    expect(preferences).toMatchObject({
      schemaVersion: 1,
      pet: {
        petSize: 330,
        petContainerWidth: 120,
        clickThrough: false,
        renderMode: "pixelated",
      },
      work: { workdir: "D:\\work", terminalId: "auto" },
    });
  });

  it("persists one versioned value and removes legacy keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("codex-pet:pet-size", "200");
    const preferences = loadAppPreferences(storage);

    expect(saveAppPreferences(preferences, storage)).toBeNull();
    expect(storage.getItem("codex-pet:pet-size")).toBeNull();
    expect(JSON.parse(storage.getItem(appPreferencesKey) ?? "{}")).toEqual(preferences);
  });

  it("falls back safely when the versioned value is corrupt", () => {
    const storage = new MemoryStorage();
    storage.setItem(appPreferencesKey, "{broken");
    storage.setItem("codex-pet:package-path", "C:\\pets\\cat.webp");

    expect(loadAppPreferences(storage).pet.packagePath).toBe("C:\\pets\\cat.webp");
  });

  it("recovers a corrupt current value from the versioned backup", () => {
    const storage = new MemoryStorage();
    const defaults = loadAppPreferences(storage);
    const first = { ...defaults, pet: { ...defaults.pet, petSize: 200 } };
    const second = { ...defaults, pet: { ...defaults.pet, petSize: 240 } };
    expect(saveAppPreferences(first, storage)).toBeNull();
    expect(saveAppPreferences(second, storage)).toBeNull();
    storage.setItem(appPreferencesKey, "{broken");

    const recovered = loadAppPreferencesWithStatus(storage);

    expect(recovered.status).toBe("recoveredFromBackup");
    expect(recovered.preferences.pet.petSize).toBe(200);
    expect(JSON.parse(storage.getItem(appPreferencesKey) ?? "{}").pet.petSize).toBe(200);
  });

  it("does not overwrite a valid backup when the current value is corrupt", () => {
    const storage = new MemoryStorage();
    const defaults = loadAppPreferences(storage);
    storage.setItem(appPreferencesBackupKey, JSON.stringify(defaults));
    storage.setItem(appPreferencesKey, "{broken");

    expect(
      saveAppPreferences(
        { ...defaults, pet: { ...defaults.pet, petSize: 260 } },
        storage,
      ),
    ).toBeNull();
    expect(JSON.parse(storage.getItem(appPreferencesBackupKey) ?? "{}").pet.petSize).toBe(
      defaults.pet.petSize,
    );
  });

  it("reports invalid values when no usable recovery source exists", () => {
    const storage = new MemoryStorage();
    storage.setItem(appPreferencesKey, "{broken");
    storage.setItem(appPreferencesBackupKey, "[]");

    expect(loadAppPreferencesWithStatus(storage).status).toBe("defaultsAfterInvalid");
  });

  it("normalizes task timeout and retry policy", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      appPreferencesKey,
      JSON.stringify({
        schemaVersion: 1,
        pet: {},
        work: { taskTimeoutMinutes: 999, taskMaxRetries: -5 },
      }),
    );

    expect(loadAppPreferences(storage).work).toMatchObject({
      taskTimeoutMinutes: 240,
      taskMaxRetries: 0,
    });
  });

  it("only enables click-through for an explicit boolean true", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      appPreferencesKey,
      JSON.stringify({
        schemaVersion: 1,
        pet: { clickThrough: "true" },
        work: {},
      }),
    );
    expect(loadAppPreferences(storage).pet.clickThrough).toBe(false);

    storage.setItem(
      appPreferencesKey,
      JSON.stringify({
        schemaVersion: 1,
        pet: { clickThrough: true },
        work: {},
      }),
    );
    expect(loadAppPreferences(storage).pet.clickThrough).toBe(true);
  });

  it("normalizes per-theme state action overrides", () => {
    expect(
      normalizePetPreferences({
        stateActionOverrides: {
          "/pets/cat": {
            idle: "working",
            waiting_input: "waiting",
            unknown: "idle",
            error: 42,
          },
          "": { idle: "working" },
          "/pets/broken": "idle",
        },
      }).stateActionOverrides,
    ).toEqual({
      "/pets/cat": {
        idle: "working",
        waiting_input: "waiting",
      },
    });
  });

  it("adds empty state action overrides to older schema v1 preferences", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      appPreferencesKey,
      JSON.stringify({ schemaVersion: 1, pet: {}, work: {} }),
    );

    expect(loadAppPreferences(storage).pet.stateActionOverrides).toEqual({});
  });

  it("returns storage errors instead of throwing", () => {
    const storage = new MemoryStorage();
    const preferences = loadAppPreferences(storage);
    const failingStorage = {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    expect(saveAppPreferences(preferences, failingStorage)).toBe("quota exceeded");
  });

  it("reports unavailable storage without throwing during startup", () => {
    const storage = new MemoryStorage();
    const failingStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: storage.setItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
    };

    expect(loadAppPreferencesWithStatus(failingStorage).status).toBe("storageUnavailable");
  });
});
