import type { TaskEvent, TaskSnapshotResponse } from "../../src/shared/api.js";

export const event =
  /* Создаёт событие с заданным номером и данными для восстановления истории. */ (
    sequence: number,
    type: TaskEvent["type"],
    extra: Partial<TaskEvent> = {},
  ): TaskEvent => ({
    taskId: "task",
    sequence,
    eventId: `event-${sequence}`,
    at: "2026-09-25T10:00:00Z",
    type,
    from: "system",
    to: null,
    attemptId: null,
    text: `Event ${sequence}`,
    artifactVersionId: null,
    source: null,
    ...extra,
  });
// Собирает данные экрана для задачи в mock-режиме с заданными событиями и этапом.
export function snapshot(
  events: TaskEvent[] = [],
  phase: TaskSnapshotResponse["task"]["phase"] = "preparing",
): TaskSnapshotResponse {
  return {
    task: {
      taskId: "task",
      title: "Test",
      phase,
      createdAt: "2026-09-25T10:00:00Z",
      updatedAt: "2026-09-25T10:00:00Z",
      currentVersionId: null,
      stopReason: null,
    },
    state: {
      taskText: "Test",
      executionMode: "mock",
      models: { author: "sol", reviewer: "luna", applier: "sol" },
      currentVersionId: null,
      currentManifestHash: null,
      latestReview: null,
      latestChecks: null,
      activeAttempt: null,
      usedModelCalls: 0,
      maxModelCalls: 7,
      createdVersions: 0,
      maxVersions: 3,
      resultPath: null,
    },
    actions: {
      canStop: false,
      canDecide: false,
      canResume: false,
      resumeRequiresExplicitRetry: false,
    },
    files: [],
    events,
    lastEventSequence: events.at(-1)?.sequence ?? 0,
  };
}
