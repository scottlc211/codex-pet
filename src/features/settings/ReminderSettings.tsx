import {
  Bell,
  CalendarDays,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Trash2,
} from "lucide-react";
import {
  clampReminderDuration,
  clampReminderWeekday,
  defaultReminderDate,
  formatReminderRule,
  formatReminderRunStatus,
  formatReminderSchedule,
  isReminderScheduleValid,
  maxReminderDurationMinutes,
  maxReminderMessageCharacters,
  nextReminderDate,
  normalizeReminderDate,
  normalizeReminderTime,
  reminderWeekdayOptions,
  todayReminderDate,
  type ReminderConfig,
  type ReminderSnapshot,
} from "../reminders/model";

export type UpdateReminderDraft = <Key extends keyof ReminderConfig>(
  key: Key,
  value: ReminderConfig[Key],
) => void;

type ReminderSettingsProps = {
  reminders: ReminderSnapshot[];
  selectedReminderId: string | null;
  draft: ReminderConfig | null;
  savedDraft: ReminderSnapshot | undefined;
  onCreate: () => void;
  onEdit: (snapshot: ReminderSnapshot) => void;
  onRequestDelete: (reminderId: string) => void;
  onReset: () => void;
  onSave: () => void;
  onPreview: () => void;
  onDraftChange: UpdateReminderDraft;
};

export function ReminderSettings({
  reminders,
  selectedReminderId,
  draft,
  savedDraft,
  onCreate,
  onEdit,
  onRequestDelete,
  onReset,
  onSave,
  onPreview,
  onDraftChange,
}: ReminderSettingsProps) {
  const draftNextReminderAt = draft ? nextReminderDate(draft)?.getTime() ?? null : null;
  const scheduleError =
    draft?.enabled && !isReminderScheduleValid(draft)
      ? "请选择当前时间之后的提醒日期和时间"
      : null;

  return (
    <div className="settings-page reminder-page">
      <div className="section-title with-action">
        <h2>定时提醒</h2>
        <button className="secondary-button" type="button" onClick={onCreate}>
          <Plus size={15} />
          <span>新建提醒</span>
        </button>
      </div>

      <div className="reminder-workspace">
        <div className="reminder-list" aria-label="提醒任务列表">
          {reminders.length === 0 && (
            <div className="reminder-empty">
              <Bell size={18} />
              <span>暂无提醒任务</span>
            </div>
          )}
          {reminders.map((snapshot) => (
            <div
              className={`reminder-list-item ${selectedReminderId === snapshot.config.id ? "active" : ""}`}
              key={snapshot.config.id}
            >
              <button type="button" onClick={() => onEdit(snapshot)}>
                <span>
                  <strong>{snapshot.config.title}</strong>
                  <small>
                    {formatReminderRule(snapshot.config)} · {formatReminderRunStatus(snapshot)}
                  </small>
                </span>
                <Pencil size={14} />
              </button>
              <button
                className="reminder-delete-button"
                type="button"
                title="删除提醒"
                aria-label={`删除提醒 ${snapshot.config.title}`}
                onClick={() => onRequestDelete(snapshot.config.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {draft ? (
          <div className="reminder-editor">
            <header className="reminder-editor-header">
              <div>
                <strong>{savedDraft ? "编辑提醒" : "新建提醒"}</strong>
                <span>{formatReminderRule(draft)}</span>
              </div>
              <div className="reminder-actions">
                <button className="icon-button" type="button" title="还原当前提醒" onClick={onReset}>
                  <RefreshCw size={16} />
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={Boolean(scheduleError)}
                  onClick={onSave}
                >
                  <Check size={15} />
                  <span>保存</span>
                </button>
              </div>
            </header>

            <div className="reminder-summary">
              <div>
                <strong>下次提醒</strong>
                <span>{formatReminderSchedule(draftNextReminderAt, draft.enabled)}</span>
              </div>
              <div>
                <strong>最近状态</strong>
                <span>{savedDraft ? formatReminderRunStatus(savedDraft) : "等待保存"}</span>
              </div>
              <button className="secondary-button" type="button" onClick={onPreview}>
                <Bell size={15} />
                <span>立即测试</span>
              </button>
            </div>

            <label className="toggle-field">
              <span>启用提醒</span>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => onDraftChange("enabled", event.currentTarget.checked)}
              />
              <span className="toggle-track" aria-hidden="true" />
            </label>

            <label className="field">
              <span>提醒标题</span>
              <input
                value={draft.title}
                maxLength={16}
                onChange={(event) => onDraftChange("title", event.currentTarget.value)}
                placeholder="例如：周报提醒"
              />
            </label>

            <label className="field">
              <span>提醒内容</span>
              <textarea
                value={draft.message}
                rows={3}
                maxLength={maxReminderMessageCharacters}
                onChange={(event) => onDraftChange("message", event.currentTarget.value)}
                placeholder="例如：老大，该写周报了。"
              />
            </label>

            <div className="field reminder-schedule-type">
              <span id={`reminder-schedule-type-${draft.id}`}>提醒方式</span>
              <div
                className="reminder-schedule-options"
                role="group"
                aria-labelledby={`reminder-schedule-type-${draft.id}`}
              >
                <button
                  className={draft.scheduleType === "weekly" ? "active" : ""}
                  type="button"
                  aria-pressed={draft.scheduleType === "weekly"}
                  onClick={() => onDraftChange("scheduleType", "weekly")}
                >
                  <Repeat2 size={15} aria-hidden="true" />
                  每周
                </button>
                <button
                  className={draft.scheduleType === "once" ? "active" : ""}
                  type="button"
                  aria-pressed={draft.scheduleType === "once"}
                  onClick={() => {
                    onDraftChange("scheduleType", "once");
                    if (!draft.date) {
                      onDraftChange("date", defaultReminderDate());
                    }
                  }}
                >
                  <CalendarDays size={15} aria-hidden="true" />
                  指定日期
                </button>
              </div>
            </div>

            <div className="reminder-grid">
              {draft.scheduleType === "weekly" ? (
                <label className="field">
                  <span>每周星期</span>
                  <select
                    value={String(draft.weekday)}
                    onChange={(event) =>
                      onDraftChange(
                        "weekday",
                        clampReminderWeekday(Number(event.currentTarget.value)),
                      )
                    }
                  >
                    {reminderWeekdayOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="field">
                  <span>具体日期</span>
                  <input
                    type="date"
                    min={todayReminderDate()}
                    value={draft.date}
                    required={draft.enabled}
                    aria-invalid={Boolean(scheduleError)}
                    aria-describedby={scheduleError ? `reminder-schedule-error-${draft.id}` : undefined}
                    onChange={(event) =>
                      onDraftChange("date", normalizeReminderDate(event.currentTarget.value))
                    }
                  />
                  {scheduleError && (
                    <small
                      className="field-error"
                      id={`reminder-schedule-error-${draft.id}`}
                      role="alert"
                    >
                      {scheduleError}
                    </small>
                  )}
                </label>
              )}

              <label className="field">
                <span>提醒时间</span>
                <input
                  type="time"
                  value={draft.time}
                  onChange={(event) =>
                    onDraftChange("time", normalizeReminderTime(event.currentTarget.value))
                  }
                />
              </label>
            </div>

            <label className="field">
              <span>提醒时长（分钟）</span>
              <input
                type="number"
                min="0"
                max={String(maxReminderDurationMinutes)}
                value={draft.durationMinutes}
                onChange={(event) =>
                  onDraftChange(
                    "durationMinutes",
                    clampReminderDuration(Number(event.currentTarget.value)),
                  )
                }
              />
              <small className="field-hint">0 表示持续显示，直到手动关闭。</small>
            </label>
          </div>
        ) : (
          <div className="reminder-empty editor-empty">
            <Bell size={20} />
            <span>选择或新建提醒任务</span>
          </div>
        )}
      </div>
    </div>
  );
}

type ReminderDeleteConfirmationProps = {
  reminder: ReminderSnapshot;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ReminderDeleteConfirmation({
  reminder,
  onCancel,
  onConfirm,
}: ReminderDeleteConfirmationProps) {
  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        className="confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-reminder-title"
      >
        <div className="confirmation-icon" aria-hidden="true">
          <Trash2 size={18} />
        </div>
        <div>
          <h2 id="delete-reminder-title">删除提醒？</h2>
          <p>{reminder.config.title}</p>
        </div>
        <div className="confirmation-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="danger-button" type="button" onClick={onConfirm}>
            <Trash2 size={15} />
            <span>删除</span>
          </button>
        </div>
      </section>
    </div>
  );
}
