import { describe, expect, it } from "vitest";
import {
  applyPetStateOverrides,
  getPetActionOptions,
  normalizeEventState,
  petStates,
  resolveVisual,
  validatePetVisual,
  type PetCandidate,
} from "./model";

const pet: PetCandidate = {
  name: "test",
  path: "/pets/test",
  kind: "package",
  canDelete: false,
  states: {
    idle: { kind: "image", path: "/pets/test/idle.webp" },
    working: { kind: "image", path: "/pets/test/working.webp" },
  },
};

describe("pet model", () => {
  it("falls back to a compatible visual state", () => {
    expect(resolveVisual(pet, "running_command")?.path).toBe("/pets/test/working.webp");
    expect(resolveVisual(pet, "success")?.path).toBe("/pets/test/idle.webp");
  });

  it("maps Codex lifecycle events to pet states", () => {
    expect(normalizeEventState({ kind: "turn.started", message: "start" })).toBe("thinking");
    expect(normalizeEventState({ kind: "turn.completed", message: "done" })).toBe("success");
    expect(normalizeEventState({ kind: "unknown", message: "noop" })).toBeNull();
  });

  it("prefers an explicit backend state", () => {
    expect(normalizeEventState({ kind: "unknown", message: "wait", state: "waiting_input" })).toBe(
      "waiting_input",
    );
  });

  it("applies a valid theme action to one state without mutating the source theme", () => {
    const configured = applyPetStateOverrides(pet, { error: "working" });

    expect(resolveVisual(configured, "error")?.path).toBe("/pets/test/working.webp");
    expect(pet.states.error).toBeUndefined();
  });

  it("ignores missing or invalid state action overrides", () => {
    const malformedPet: PetCandidate = {
      ...pet,
      states: {
        ...pet.states,
        broken: { kind: "image", path: "/pets/test/broken.txt" },
      },
    };

    expect(resolveVisual(applyPetStateOverrides(malformedPet, { error: "missing" }), "error")?.path)
      .toBe("/pets/test/idle.webp");
    expect(resolveVisual(applyPetStateOverrides(malformedPet, { error: "broken" }), "error")?.path)
      .toBe("/pets/test/idle.webp");
  });

  it("validates supported image and fixed atlas formats", () => {
    expect(validatePetVisual({ kind: "image", path: "C:\\pets\\idle.JPEG" })).toBeNull();
    expect(validatePetVisual({ kind: "image", path: "/pets/idle.txt" })).toContain("仅支持");
    expect(
      validatePetVisual({
        kind: "atlas",
        path: "/pets/sheet.png",
        row: 8,
        frames: 8,
        totalMs: 960,
        frameWidth: 192,
        frameHeight: 208,
      }),
    ).toBeNull();
    expect(
      validatePetVisual({
        kind: "atlas",
        path: "/pets/sheet.png",
        row: 9,
        frames: 8,
        totalMs: 960,
        frameWidth: 192,
        frameHeight: 208,
      }),
    ).toContain("0–8");
  });

  it("lists every configurable state and deduplicates identical actions", () => {
    const sharedVisual = { kind: "image" as const, path: "/pets/test/shared.png" };
    const options = getPetActionOptions({
      ...pet,
      states: {
        idle: sharedVisual,
        thinking: sharedVisual,
        working: { kind: "image", path: "/pets/test/working.png" },
        broken: { kind: "image", path: "/pets/test/broken.exe" },
      },
    });

    expect(petStates).toHaveLength(13);
    expect(options.map((option) => option.key)).toEqual(["idle", "working"]);
  });
});
