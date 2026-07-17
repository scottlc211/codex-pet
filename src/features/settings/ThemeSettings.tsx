import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  Check,
  Import,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { RenderMode } from "../../config/preferences";
import { PetVisualView } from "../pet/PetVisualView";
import {
  applyPetStateOverrides,
  getPetActionOptions,
  petStates,
  petVisualFormatLabel,
  resolveVisual,
  stateLabels,
  validatePetVisual,
  type PetActionOption,
  type PetCandidate,
  type PetState,
  type PetStateActionMap,
} from "../pet/model";

const themePreviewPetSize = 112;
const themePreviewCanvasSize = 156;
const actionPreviewPetSize = 76;

type ThemeSettingsProps = {
  candidates: PetCandidate[];
  activePet: PetCandidate | null;
  packagePath: string;
  importing: boolean;
  renderMode: RenderMode;
  stateActionOverrides: PetStateActionMap;
  onRefresh: () => void;
  onSelectDefault: () => void;
  onSelect: (candidate: PetCandidate) => void;
  onRequestDelete: (candidate: PetCandidate) => void;
  onPackagePathChange: (value: string) => void;
  onImport: () => void;
  onStateActionChange: (state: PetState, sourceAction: string | null) => void;
  onResetStateActions: () => void;
};

export function ThemeSettings({
  candidates,
  activePet,
  packagePath,
  importing,
  renderMode,
  stateActionOverrides,
  onRefresh,
  onSelectDefault,
  onSelect,
  onRequestDelete,
  onPackagePathChange,
  onImport,
  onStateActionChange,
  onResetStateActions,
}: ThemeSettingsProps) {
  const previewStyle = {
    "--pet-size": `${themePreviewPetSize}px`,
    "--pet-canvas-size": `${themePreviewCanvasSize}px`,
    "--pet-visual-offset-x": "0px",
    "--pet-visual-offset-y": "0px",
  } as CSSProperties;
  const configuredActivePet = useMemo(
    () => (activePet ? applyPetStateOverrides(activePet, stateActionOverrides) : null),
    [activePet, stateActionOverrides],
  );

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
          const previewCandidate = isActive ? (configuredActivePet ?? candidate) : candidate;
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
                    visual={resolveVisual(previewCandidate, "idle")}
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

      {activePet && configuredActivePet ? (
        <PetStateActionEditor
          pet={activePet}
          configuredPet={configuredActivePet}
          renderMode={renderMode}
          overrides={stateActionOverrides}
          onChange={onStateActionChange}
          onResetAll={onResetStateActions}
        />
      ) : (
        <div className="state-action-empty">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>选择主题后可配置状态动作</strong>
            <span>动作仅能从当前主题已校验的图片或图集中选择。</span>
          </div>
        </div>
      )}

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

type PetStateActionEditorProps = {
  pet: PetCandidate;
  configuredPet: PetCandidate;
  renderMode: RenderMode;
  overrides: PetStateActionMap;
  onChange: (state: PetState, sourceAction: string | null) => void;
  onResetAll: () => void;
};

function PetStateActionEditor({
  pet,
  configuredPet,
  renderMode,
  overrides,
  onChange,
  onResetAll,
}: PetStateActionEditorProps) {
  const actionOptions = useMemo(() => getPetActionOptions(pet), [pet]);
  const hasOverrides = petStates.some((state) => Boolean(overrides[state]));
  const previewStyle = {
    "--pet-size": `${actionPreviewPetSize}px`,
    "--pet-visual-offset-x": "0px",
    "--pet-visual-offset-y": "0px",
    "--pet-bubble-shift": "0px",
  } as CSSProperties;

  return (
    <section className="state-action-editor" aria-labelledby="state-action-editor-title">
      <div className="state-action-editor-header">
        <div>
          <h3 id="state-action-editor-title">状态动作</h3>
          <p>每项修改会立即应用并同步到桌宠。</p>
        </div>
        <button
          className="secondary-button state-action-reset-all"
          type="button"
          disabled={!hasOverrides}
          onClick={onResetAll}
        >
          <RotateCcw size={14} aria-hidden="true" />
          全部重置
        </button>
      </div>

      <div className="state-action-format-note">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>
          仅支持 PNG、JPG、JPEG、GIF、WebP、SVG、APNG；图集固定为 8 列 × 9 行。
        </span>
      </div>

      <div className="state-action-grid">
        {petStates.map((state) => (
          <PetStateActionCard
            key={state}
            state={state}
            pet={pet}
            configuredPet={configuredPet}
            renderMode={renderMode}
            overrideKey={overrides[state]}
            actionOptions={actionOptions}
            previewStyle={previewStyle}
            onChange={onChange}
          />
        ))}
      </div>
    </section>
  );
}

type PetStateActionCardProps = {
  state: PetState;
  pet: PetCandidate;
  configuredPet: PetCandidate;
  renderMode: RenderMode;
  overrideKey: string | undefined;
  actionOptions: PetActionOption[];
  previewStyle: CSSProperties;
  onChange: (state: PetState, sourceAction: string | null) => void;
};

function PetStateActionCard({
  state,
  pet,
  configuredPet,
  renderMode,
  overrideKey,
  actionOptions,
  previewStyle,
  onChange,
}: PetStateActionCardProps) {
  const resolvedVisual = resolveVisual(configuredPet, state);
  const previewError = resolvedVisual
    ? validatePetVisual(resolvedVisual)
    : "主题未提供可用动作";
  const overrideVisual = overrideKey ? pet.states[overrideKey] : undefined;
  const overrideError = overrideKey
    ? Object.prototype.hasOwnProperty.call(pet.states, overrideKey)
      ? validatePetVisual(overrideVisual)
      : `已保存动作“${overrideKey}”不存在`
    : null;
  const error = overrideError ?? previewError;
  const previewVisual = previewError ? null : resolvedVisual;
  const hasCurrentOption = overrideKey
    ? actionOptions.some((option) => option.key === overrideKey)
    : true;
  const stateTitleId = `state-action-title-${state}`;
  const selectId = `state-action-select-${state}`;

  return (
    <article
      className={`state-action-card ${error ? "has-error" : ""}`}
      data-customized={Boolean(overrideKey)}
      aria-labelledby={stateTitleId}
    >
      <div
        className={`state-action-preview state-${state}`}
        style={previewStyle}
        role="img"
        aria-label={`预览：${stateLabels[state]}状态`}
      >
        {previewVisual ? (
          <PetVisualView
            visual={previewVisual}
            state={state}
            renderMode={renderMode}
            petSize={actionPreviewPetSize}
          />
        ) : (
          <span className="state-action-preview-unavailable">无法预览</span>
        )}
      </div>

      <div className="state-action-card-content">
        <div className="state-action-card-heading">
          <div>
            <strong id={stateTitleId}>{stateLabels[state]}</strong>
            <small>{state}</small>
          </div>
          <span className="state-action-mode" aria-live="polite">
            {overrideKey ? "已自定义" : "主题默认"}
          </span>
        </div>

        <label className="state-action-select-label" htmlFor={selectId}>
          <span>动作</span>
          <select
            id={selectId}
            value={overrideKey ?? ""}
            disabled={actionOptions.length === 0}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${selectId}-error` : undefined}
            onChange={(event) => onChange(state, event.currentTarget.value || null)}
          >
            <option value="">跟随主题默认</option>
            {overrideKey && !hasCurrentOption && (
              <option value={overrideKey}>
                当前：{overrideKey} · {overrideError ? "格式无效" : petVisualFormatLabel(overrideVisual ?? null)}
              </option>
            )}
            {actionOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label} · {petVisualFormatLabel(option.visual)}
              </option>
            ))}
          </select>
        </label>

        <div className="state-action-card-footer">
          <span>{petVisualFormatLabel(previewVisual)}</span>
          <button
            className="state-action-reset"
            type="button"
            title={`重置${stateLabels[state]}状态`}
            aria-label={`重置${stateLabels[state]}状态`}
            disabled={!overrideKey}
            onClick={() => onChange(state, null)}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        </div>

        {error && (
          <small id={`${selectId}-error`} className="field-error" aria-live="polite">
            {error}{overrideKey ? "，已回退主题默认动作。" : "。"}
          </small>
        )}
      </div>
    </article>
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
