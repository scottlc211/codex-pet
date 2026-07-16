import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Check, Import, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
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
  onRequestDelete: (candidate: PetCandidate) => void;
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
  onRequestDelete,
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
        <div className={`theme-card ${activePet ? "" : "active"}`}>
          <button
            className="theme-card-select"
            type="button"
            aria-pressed={!activePet}
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
            <div className="theme-card-copy">
              <strong>默认主题</strong>
              <span>内置</span>
            </div>
          </button>
          {!activePet && (
            <span className="theme-selected-indicator" title="当前主题" aria-label="当前主题">
              <Check size={16} aria-hidden="true" />
            </span>
          )}
        </div>

        {candidates.map((candidate) => {
          const isActive = activePet?.path === candidate.path;
          return (
            <div className={`theme-card ${isActive ? "active" : ""}`} key={candidate.path}>
              <button
                className="theme-card-select"
                type="button"
                title={candidate.path}
                aria-pressed={isActive}
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
                <div className="theme-card-copy">
                  <strong>{candidate.name}</strong>
                  <span>{candidate.kind}</span>
                </div>
              </button>
              <div className="theme-card-actions">
                {isActive && (
                  <span className="theme-selected-indicator" title="当前主题" aria-label="当前主题">
                    <Check size={16} aria-hidden="true" />
                  </span>
                )}
                {candidate.canDelete && (
                  <button
                    className="theme-delete-button"
                    type="button"
                    title={`卸载主题：${candidate.name}`}
                    aria-label={`卸载主题：${candidate.name}`}
                    onClick={() => onRequestDelete(candidate)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
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

type ThemeDeleteConfirmationProps = {
  theme: PetCandidate;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ThemeDeleteConfirmation({
  theme,
  deleting,
  onCancel,
  onConfirm,
}: ThemeDeleteConfirmationProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();

    return () => {
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (deleting) {
      dialogRef.current?.focus();
    }
  }, [deleting]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !deleting) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const focusableButtons = [cancelButtonRef.current, confirmButtonRef.current].filter(
      (button): button is HTMLButtonElement => Boolean(button && !button.disabled),
    );
    if (focusableButtons.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const firstButton = focusableButtons[0];
    const lastButton = focusableButtons[focusableButtons.length - 1];
    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton.focus();
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton.focus();
    }
  }

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-theme-title"
        aria-describedby="delete-theme-description"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="confirmation-icon" aria-hidden="true">
          <Trash2 size={18} />
        </div>
        <div>
          <h2 id="delete-theme-title">卸载主题？</h2>
          <p title={theme.name}>{theme.name}</p>
          <small id="delete-theme-description" className="confirmation-description">
            将删除 Codex Pet 保存的本地主题文件，此操作无法撤销。
          </small>
        </div>
        <div className="confirmation-actions">
          <button
            ref={cancelButtonRef}
            className="secondary-button"
            type="button"
            disabled={deleting}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            ref={confirmButtonRef}
            className="danger-button"
            type="button"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting ? (
              <LoaderCircle className="spin-icon" size={15} aria-hidden="true" />
            ) : (
              <Trash2 size={15} aria-hidden="true" />
            )}
            <span>{deleting ? "卸载中" : "卸载"}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
