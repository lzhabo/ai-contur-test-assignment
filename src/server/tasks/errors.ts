export type ServiceErrorCode =
  | "idempotency_conflict"
  | "active_task"
  | "mode_mismatch"
  | "decision_not_allowed"
  | "stale_version"
  | "decision_pending"
  | "resume_not_allowed"
  | "task_running"
  | "task_not_found"
  | "checkpoint_missing"
  | "artifact_not_found"
  | "artifact_changed"
  | "result_unavailable";

export class ServiceError extends Error {
  // Сохраняет смысловой код ошибки операции; транспорт выбирает способ ответа самостоятельно.
  constructor(
    public readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
