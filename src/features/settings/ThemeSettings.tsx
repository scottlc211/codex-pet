import type { CSSProperties } from "react";
import { Check, Import, LoaderCircle, RefreshCw } from "lucide-react";
import type { RenderMode } from "../../config/preferences";
import { PetVisualView } from "../pet/PetVisualView";
import { resolveVisual, type PetCandidate } from "../pet/model";

const themePreviewPetSize = 112;
const themePreviewCanvasSize = 156;

type ThemeSettingsProps = {
  candidates: PetCandidate[];
  activePet: PetCandidate | null;
  packagePath: string;
  importing: boolean;
  renderMode: RenderMode;
  onRefresh: () => void;
  onSelectDefault: () => void;
  onSelect: (candidate: PetCandidate) => void;
  onPackagePathChange: (value: string) => void;
  onImport: () => void;
};

export function ThemeSettings({
  candidates,
  activePet,
  packagePath,
  importing,
  renderMode,
  onRefresh,
  onSelectDefault,
  onSelect,
  onPackagePathChange,
  onImport,
}: ThemeSettingsProps) {
  const previewStyle = {
    "--pet-size": `${themePreviewPetSize}px`,
    "--pet-canvas-size": `${themePreviewCanvasSize}px`,
    "--pet-visual-offset-x": "0px",
    "--pet-visual-offset-y": "0px",
  } as CSSProperties;

  return (
    <div className="settings-page">
      <div className="section-title with-action">
        <h2>主题</h2>
        <button className="icon-button" type="button" title="刷新主题" onClick={onRefresh}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="theme-grid" aria-label="主题列表">
        <button
          className={`theme-card ${activePet ? "" : "active"}`}
          type="button"
          onClick={onSelectDefault}
        >
          <div className="theme-preview" style={previewStyle}>
            <PetVisualView
              visual={null}
              state="idle"
              renderMode={renderMode}
              petSize={themePreviewPetSize}
            />
          </div>
          <div>
            <strong>默认主题</strong>
            <span>内置</span>
          </div>
          {!activePet && <Check size={16} />}
        </button>

        {candidates.map((candidate) => (
          <button
            className={`theme-card ${activePet?.path === candidate.path ? "active" : ""}`}
            key={candidate.path}
            type="button"
            title={candidate.path}
            onClick={() => onSelect(candidate)}
          >
            <div className="theme-preview" style={previewStyle}>
              <PetVisualView
                visual={resolveVisual(candidate, "idle")}
                state="idle"
                renderMode={renderMode}
                petSize={themePreviewPetSize}
              />
            </div>
            <div>
              <strong>{candidate.name}</strong>
              <span>{candidate.kind}</span>
            </div>
            {activePet?.path === candidate.path && <Check size={16} />}
          </button>
        ))}
      </div>

      <label className="field">
        <span>动画包 / 图片路径</span>
        <div className="path-row">
          <input
            value={packagePath}
            onChange={(event) => onPackagePathChange(event.currentTarget.value)}
            placeholder="选择目录、zip 或图片文件"
          />
          <button
            className="icon-button"
            type="button"
            title="导入动画包"
            disabled={importing}
            onClick={onImport}
          >
            {importing ? (
              <LoaderCircle className="spin-icon" size={16} />
            ) : (
              <Import size={16} />
            )}
          </button>
        </div>
      </label>
    </div>
  );
}
