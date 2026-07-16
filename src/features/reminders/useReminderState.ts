import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../agents/model";
import { isTauriRuntime, releaseTauriListener } from "../../runtime/tauri";
import {
  classifyReminderLateness,
  createReminderConfig,
  defaultReminderConfig,
  findNextReminder,
  isReminderScheduleValid,
  nextReminderDate,
  normalizeReminderConfig,
  normalizeReminderSnapshots,
  readReminderSnapshots,
  saveBrowserReminderSnapshots,
  upsertReminderSnapshot,
  type ReminderConfig,
  type ReminderEvent,
  type ReminderSnapshot,
  type ReminderStateSnapshot,
} from "./model";

type UseReminderStateOptions = {
  settingsWindow: boolean;
  onTriggered: (config: ReminderConfig) => void;
  pushEvent: (event: AgentEvent) => void;
};

export function useReminderState({
  settingsWindow,
  onTriggered,
  pushEvent,
}: UseReminderStateOptions) {
  const [initialSnapshots] = useState(() => readReminderSnapshots());
  const [reminderSnapshots, setReminderSnapshots] =
    useState<ReminderSnapshot[]>(initialSnapshots);
  const [reminderDraft, setReminderDraft] = useState<ReminderConfig | null>(() =>
    initialSnapshots[0]?.config ?? null,
  );
  const [selectedReminderId, setSelectedReminderId] = useState<string | null>(() =>
    initialSnapshots[0]?.config.id ?? null,
  );
  const [pendingReminderDeleteId, setPendingReminderDeleteId] = useState<string | null>(null);
  const scheduleTimerRef = useRef<number | null>(null);
  const selectedReminderIdRef = useRef(selectedReminderId);
  const callbacksRef = useRef({ onTriggered, pushEvent });
  selectedReminderIdRef.current = selectedReminderId;
  callbacksRef.current = { onTriggered, pushEvent };

  const applyReminderState = useCallback(
    (snapshot: ReminderStateSnapshot, updateDraft = true) => {
      const reminders = normalizeReminderSnapshots(snapshot.reminders);
      setReminderSnapshots(reminders);
      if (!updateDraft) {
        return;
      }
      const selected =
        reminders.find((reminder) => reminder.config.id === selectedReminderIdRef.current) ??
        reminders[0] ??
        null;
      setSelectedReminderId(selected?.config.id ?? null);
      setReminderDraft(selected ? { ...selected.config } : null);
    },
    [],
  );

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    void invoke<ReminderStateSnapshot>("get_reminder_state")
      .then((snapshot) => applyReminderState(snapshot))
      .catch((error) => {
        callbacksRef.current.pushEvent({
          kind: "reminder.load.error",
          message: String(error),
          state: "error",
        });
      });
    const unlistenPromise = listen<ReminderStateSnapshot>(
      "reminder-state-updated",
      (event) => applyReminderState(event.payload, false),
    );

    return () => releaseTauriListener(unlistenPromise);
  }, [applyReminderState]);

  useEffect(() => {
    if (!isTauriRuntime || settingsWindow) {
      return;
    }

    const unlistenPromise = listen<ReminderEvent>("reminder-triggered", (event) => {
      const reminder = event.payload;
      callbacksRef.current.onTriggered({
        ...defaultReminderConfig,
        id: reminder.reminderId,
        enabled: true,
        title: reminder.title,
        message: reminder.message,
        durationMinutes: reminder.durationMinutes,
      });
      const lastStatus = reminder.triggerKind;
      if (lastStatus !== "preview") {
        setReminderSnapshots((current) =>
          current.map((snapshot) =>
            snapshot.config.id === reminder.reminderId
              ? {
                  ...snapshot,
                  nextReminderAt: reminder.nextReminderAt,
                  lastHandledAt: reminder.triggeredAt,
                  lastStatus,
                }
              : snapshot,
          ),
        );
      }
    });

    return () => releaseTauriListener(unlistenPromise);
  }, [settingsWindow]);

  useEffect(() => {
    if (isTauriRuntime) {
      return;
    }

    const error = saveBrowserReminderSnapshots(reminderSnapshots);
    if (error) {
      callbacksRef.current.pushEvent({
        kind: "reminder.save.error",
        message: error,
        state: "error",
      });
    }
  }, [reminderSnapshots]);

  useEffect(() => {
    if (isTauriRuntime) {
      return;
    }

    clearScheduleTimer();
    const nextReminder = findNextReminder(reminderSnapshots);
    if (!nextReminder) {
      return;
    }

    const delay = Math.max(0, nextReminder.nextReminderAt - Date.now());
    scheduleTimerRef.current = window.setTimeout(() => {
      const handledAt = Date.now();
      const lastStatus = classifyReminderLateness(nextReminder.nextReminderAt, handledAt);
      if (lastStatus !== "missed") {
        callbacksRef.current.onTriggered(nextReminder.config);
      }
      const nextNow = new Date(handledAt + 1000);
      setReminderSnapshots((current) =>
          current.map((snapshot) =>
            snapshot.config.id === nextReminder.config.id
              ? {
                  ...snapshot,
                  config:
                    snapshot.config.scheduleType === "once"
                      ? { ...snapshot.config, enabled: false }
                      : snapshot.config,
                  nextReminderAt:
                    snapshot.config.scheduleType === "once"
                      ? null
                      : nextReminderDate(snapshot.config, nextNow)?.getTime() ?? null,
                  lastHandledAt: nextReminder.nextReminderAt,
                  lastStatus,
              }
            : snapshot,
        ),
      );
    }, delay);

    return clearScheduleTimer;
  }, [reminderSnapshots]);

  function clearScheduleTimer() {
    if (scheduleTimerRef.current !== null) {
      window.clearTimeout(scheduleTimerRef.current);
      scheduleTimerRef.current = null;
    }
  }

  function previewReminder() {
    if (!reminderDraft) {
      return;
    }
    const config = normalizeReminderConfig(reminderDraft);
    if (!isTauriRuntime) {
      callbacksRef.current.onTriggered(config);
      return;
    }

    void invoke("preview_reminder", { config }).catch((error) => {
      callbacksRef.current.pushEvent({
        kind: "reminder.preview.error",
        message: String(error),
        state: "error",
      });
    });
  }

  function saveReminderConfig() {
    if (!reminderDraft) {
      return;
    }
    const nextConfig = normalizeReminderConfig(reminderDraft);
    if (!isReminderScheduleValid(nextConfig)) {
      callbacksRef.current.pushEvent({
        kind: "reminder.schedule.error",
        message: "请选择当前时间之后的提醒日期和时间",
        state: "error",
      });
      return;
    }
    setSelectedReminderId(nextConfig.id);
    if (!isTauriRuntime) {
      setReminderDraft(nextConfig);
      setReminderSnapshots((current) => upsertReminderSnapshot(current, nextConfig));
      callbacksRef.current.pushEvent({
        kind: "reminder.saved",
        message: "提醒任务已保存",
        state: "idle",
      });
      return;
    }

    void invoke<ReminderStateSnapshot>("save_reminder_config", { config: nextConfig })
      .then((snapshot) => {
        const reminders = normalizeReminderSnapshots(snapshot.reminders);
        const saved = reminders.find((reminder) => reminder.config.id === nextConfig.id);
        setReminderSnapshots(reminders);
        setSelectedReminderId(saved?.config.id ?? null);
        setReminderDraft(saved ? { ...saved.config } : null);
        callbacksRef.current.pushEvent({
          kind: "reminder.saved",
          message: "提醒任务已保存",
          state: "idle",
        });
      })
      .catch((error) => {
        callbacksRef.current.pushEvent({
          kind: "reminder.save.error",
          message: String(error),
          state: "error",
        });
      });
  }

  function resetReminderDraft() {
    if (!reminderDraft) {
      return;
    }
    const saved = reminderSnapshots.find(
      (reminder) => reminder.config.id === reminderDraft.id,
    );
    setReminderDraft(
      saved ? { ...saved.config } : { ...createReminderConfig(), id: reminderDraft.id },
    );
  }

  function createReminder() {
    const reminder = createReminderConfig();
    setSelectedReminderId(reminder.id);
    setReminderDraft(reminder);
  }

  function editReminder(snapshot: ReminderSnapshot) {
    setSelectedReminderId(snapshot.config.id);
    setReminderDraft({ ...snapshot.config });
  }

  function requestReminderDeletion(reminderId: string) {
    const existing = reminderSnapshots.find((reminder) => reminder.config.id === reminderId);
    if (existing) {
      setPendingReminderDeleteId(existing.config.id);
    }
  }

  function confirmReminderDeletion() {
    const reminderId = pendingReminderDeleteId;
    if (!reminderId) {
      return;
    }
    setPendingReminderDeleteId(null);

    const applyDeletedState = (snapshot: ReminderStateSnapshot) => {
      const reminders = normalizeReminderSnapshots(snapshot.reminders);
      setReminderSnapshots(reminders);
      if (selectedReminderIdRef.current !== reminderId) {
        return;
      }
      const first = reminders[0] ?? null;
      setSelectedReminderId(first?.config.id ?? null);
      setReminderDraft(first ? { ...first.config } : null);
    };

    if (!isTauriRuntime) {
      applyDeletedState({
        reminders: reminderSnapshots.filter(
          (reminder) => reminder.config.id !== reminderId,
        ),
      });
      callbacksRef.current.pushEvent({
        kind: "reminder.deleted",
        message: "提醒任务已删除",
        state: "idle",
      });
      return;
    }

    void invoke<ReminderStateSnapshot>("delete_reminder_config", { reminderId })
      .then((snapshot) => {
        applyDeletedState(snapshot);
        callbacksRef.current.pushEvent({
          kind: "reminder.deleted",
          message: "提醒任务已删除",
          state: "idle",
        });
      })
      .catch((error) => {
        callbacksRef.current.pushEvent({
          kind: "reminder.delete.error",
          message: String(error),
          state: "error",
        });
      });
  }

  function updateReminderDraft<Key extends keyof ReminderConfig>(
    key: Key,
    value: ReminderConfig[Key],
  ) {
    setReminderDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  const savedReminderDraft = reminderDraft
    ? reminderSnapshots.find((snapshot) => snapshot.config.id === reminderDraft.id)
    : undefined;
  const pendingReminderDelete = pendingReminderDeleteId
    ? reminderSnapshots.find((snapshot) => snapshot.config.id === pendingReminderDeleteId)
    : undefined;

  return {
    reminderSnapshots,
    reminderDraft,
    selectedReminderId,
    savedReminderDraft,
    pendingReminderDelete,
    createReminder,
    editReminder,
    requestReminderDeletion,
    cancelReminderDeletion: () => setPendingReminderDeleteId(null),
    confirmReminderDeletion,
    resetReminderDraft,
    saveReminderConfig,
    previewReminder,
    updateReminderDraft,
  };
}
