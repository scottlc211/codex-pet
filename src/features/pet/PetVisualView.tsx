import type { CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { RenderMode } from "../../config/preferences";
import { isTauriRuntime } from "../../runtime/tauri";
import defaultPet from "../../assets/default-pet.svg";
import type { PetState, PetVisual } from "./model";

type PetVisualViewProps = {
  visual: PetVisual | null;
  state: PetState;
  renderMode: RenderMode;
  petSize: number;
};

export function PetVisualView({
  visual,
  state,
  renderMode,
  petSize,
}: PetVisualViewProps) {
  if (!visual) {
    return (
      <div className="pet-visual-frame">
        <img className="pet-image" src={defaultPet} alt="Codex Pet" draggable={false} />
      </div>
    );
  }

  if (visual.kind === "atlas") {
    const frameWidth = visual.frameWidth ?? 192;
    const frameHeight = visual.frameHeight ?? 208;
    const frames = Math.max(1, visual.frames ?? 1);
    const row = visual.row ?? 0;
    const totalMs = Math.max(1, visual.totalMs ?? 1000);
    const atlasScale = petSize / Math.max(frameWidth, frameHeight);
    const style = {
      "--atlas-url": `url("${convertFileSrc(visual.path)}")`,
      "--frame-width": `${frameWidth}px`,
      "--frame-height": `${frameHeight}px`,
      "--atlas-scale": String(Math.max(0.1, Math.min(4, atlasScale))),
      "--atlas-width": `${frameWidth * 8}px`,
      "--atlas-height": `${frameHeight * 9}px`,
      "--atlas-frames": frames,
      "--atlas-duration": `${totalMs}ms`,
      "--atlas-row-offset": `${row * frameHeight * -1}px`,
      "--atlas-end-x": `${frames * frameWidth * -1}px`,
    } as CSSProperties;
    const visualKey = `${visual.path}-${state}-${row}-${frames}-${totalMs}-${frameWidth}x${frameHeight}`;

    return (
      <div className="pet-visual-frame">
        <div
          key={visualKey}
          className={`pet-atlas-wrap render-${renderMode}`}
          style={style}
          aria-label={`宠物状态 ${state}`}
        >
          <div className="pet-atlas" key={visualKey} />
        </div>
      </div>
    );
  }

  return (
    <div className="pet-visual-frame">
      <img
        key={`${visual.path}-${state}`}
        className={`pet-image render-${renderMode}`}
        src={isTauriRuntime ? convertFileSrc(visual.path) : defaultPet}
        alt={`宠物状态 ${state}`}
        draggable={false}
      />
    </div>
  );
}
