import { describe, expect, it } from "vitest";
import { normalizeEventState, resolveVisual, type PetCandidate } from "./model";

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
});
