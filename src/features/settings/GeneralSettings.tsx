import { FolderOpen, RefreshCw } from "lucide-react";
import {
  clampPetContainerDimension,
  clampPetOffset,
  clampPetSize,
  maxPetContainerDimension,
  minPetContainerDimension,
  petVisualOffsetLimit,
  type PetPreferences,
  type PreferencesLoadStatus,
  type RenderMode,
} from "../../config/preferences";
import type {
  DiagnosticsInfo,
  ReminderConfigHealth,
} from "../diagnostics/useDiagnostics";

export type UpdatePetPreference = <Key extends keyof PetPreferences>(
  key: Key,
  value: PetPreferences[Key],
) => void;

type GeneralSettingsProps = {
  preferences: PetPreferences;
  preferencesStatus: PreferencesLoadStatus;
  diagnosticsInfo: DiagnosticsInfo | null;
  reminderHealth: ReminderConfigHealth | null;
  diagnosticsBusy: boolean;
  onChange: UpdatePetPreference;
  onOpenDiagnostics: () => void;
  onRepairReminders: () => void;
};

export function GeneralSettings({
  preferences,
  preferencesStatus,
  diagnosticsInfo,
  reminderHealth,
  diagnosticsBusy,
  onChange,
  onOpenDiagnostics,
  onRepairReminders,
}: GeneralSettingsProps) {
  return (
    <div className="settings-page">
      <div className="section-title">
        <h2>通用</h2>
      </div>
      <label className="field">
        <span>桌宠大小</span>
        <div className="range-row">
          <input
            type="range"
            min="150"
            max="330"
            step="5"
            value={preferences.petSize}
            onChange={(event) => onChange("petSize", clampPetSize(Number(event.currentTarget.value)))}
          />
          <output>{preferences.petSize}px</output>
        </div>
      </label>
      <div className="field">
        <span>桌宠容器</span>
        <div className="container-size-row">
          <label>
            <span>宽度</span>
            <input
              type="number"
              min={minPetContainerDimension}
              max={maxPetContainerDimension}
              step="4"
              value={preferences.petContainerWidth}
              onChange={(event) =>
                onChange(
                  "petContainerWidth",
                  clampPetContainerDimension(Number(event.currentTarget.value)),
                )
              }
            />
          </label>
          <label>
            <span>高度</span>
            <input
              type="number"
              min={minPetContainerDimension}
              max={maxPetContainerDimension}
              step="4"
              value={preferences.petContainerHeight}
              onChange={(event) =>
                onChange(
                  "petContainerHeight",
                  clampPetContainerDimension(Number(event.currentTarget.value)),
                )
              }
            />
          </label>
        </div>
      </div>
      <div className="field">
        <span>显示偏移</span>
        <div className="offset-row">
          <label className="offset-control">
            <span aria-hidden="true">X</span>
            <input
              aria-label="显示偏移 X"
              type="range"
              min={-petVisualOffsetLimit}
              max={petVisualOffsetLimit}
              step="1"
              value={preferences.petOffsetX}
              onChange={(event) =>
                onChange("petOffsetX", clampPetOffset(Number(event.currentTarget.value)))
              }
            />
            <output>{preferences.petOffsetX}px</output>
          </label>
          <label className="offset-control">
            <span aria-hidden="true">Y</span>
            <input
              aria-label="显示偏移 Y"
              type="range"
              min={-petVisualOffsetLimit}
              max={petVisualOffsetLimit}
              step="1"
              value={preferences.petOffsetY}
              onChange={(event) =>
                onChange("petOffsetY", clampPetOffset(Number(event.currentTarget.value)))
              }
            />
            <output>{preferences.petOffsetY}px</output>
          </label>
        </div>
      </div>
      <label className="field">
        <span>渲染方式</span>
        <select
          value={preferences.renderMode}
          onChange={(event) => onChange("renderMode", event.currentTarget.value as RenderMode)}
        >
          <option value="smooth">平滑</option>
          <option value="pixelated">像素</option>
        </select>
      </label>
      <label className="toggle-field">
        <span>鼠标穿透</span>
        <input
          type="checkbox"
          checked={preferences.clickThrough}
          onChange={(event) => onChange("clickThrough", event.currentTarget.checked)}
        />
        <span className="toggle-track" aria-hidden="true" />
      </label>
      <div className="field diagnostics-section">
        <span>诊断与恢复</span>
        <div className="diagnostics-status-list">
          <div>
            <span>应用设置</span>
            <strong data-status={preferenceStatusTone(preferencesStatus)}>
              {preferenceStatusLabel(preferencesStatus)}
            </strong>
          </div>
          <div>
            <span>提醒配置</span>
            <strong data-status={reminderStatusTone(reminderHealth)}>
              {reminderStatusLabel(reminderHealth)}
            </strong>
          </div>
        </div>
        <div className="diagnostics-actions">
          <button className="secondary-button" type="button" onClick={onOpenDiagnostics}>
            <FolderOpen size={15} aria-hidden="true" />
            日志目录
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={diagnosticsBusy}
            onClick={onRepairReminders}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {diagnosticsBusy ? "正在重写" : "重写提醒配置"}
          </button>
        </div>
        {diagnosticsInfo && (
          <span className="diagnostics-path" title={diagnosticsInfo.logPath}>
            v{diagnosticsInfo.version} · {diagnosticsInfo.logPath}
          </span>
        )}
      </div>
    </div>
  );
}

function preferenceStatusLabel(status: PreferencesLoadStatus) {
  switch (status) {
    case "healthy":
      return "正常";
    case "recoveredFromBackup":
      return "已从备份恢复";
    case "migratedLegacy":
      return "已迁移旧配置";
    case "defaultsAfterInvalid":
      return "损坏后使用默认值";
    case "storageUnavailable":
      return "存储不可用";
    case "defaultsAfterMissing":
      return "默认配置";
  }
}

function preferenceStatusTone(status: PreferencesLoadStatus) {
  if (status === "storageUnavailable" || status === "defaultsAfterInvalid") {
    return "error";
  }
  return status === "recoveredFromBackup" ? "warning" : "healthy";
}

function reminderStatusLabel(health: ReminderConfigHealth | null) {
  switch (health?.status) {
    case "healthy":
      return "正常";
    case "recoveredFromBackup":
      return "已从备份恢复";
    case "defaultsAfterInvalid":
      return "损坏后使用默认值";
    case "defaultsAfterMissing":
      return "默认配置";
    default:
      return "正在检查";
  }
}

function reminderStatusTone(health: ReminderConfigHealth | null) {
  if (health?.status === "defaultsAfterInvalid") {
    return "error";
  }
  return health?.status === "recoveredFromBackup" ? "warning" : "healthy";
}
