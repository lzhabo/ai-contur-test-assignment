import { interrupt } from "@langchain/langgraph";
import { createHash, randomUUID } from "node:crypto";
import {
  ApplierOutputSchema,
  ApprovalSchema,
  AuthorOutputSchema,
  ReviewerOutputSchema,
  type Attempt,
  type TaskState,
} from "./types.js";

import type { TaskNode } from "./node-logging.js";
import { createRoleCalls, KnownAgentError, type AgentHooks } from "./role-call.js";
// Ставит дату завершения шага после выполнения его побочных эффектов.
const now = (): string => new Date().toISOString();
export type AgentSteps = Record<
  | "prepareAuthor"
  | "callAuthor"
  | "check"
  | "prepareReviewer"
  | "callReviewer"
  | "waitApproval"
  | "pauseUnknown"
  | "pauseAuth"
  | "prepareApplier"
  | "callApplier",
  TaskNode
>;

// Реализует шаги агентов, проверки кода и публикацию точной одобренной версии.
export function createAgentSteps(hooks: AgentHooks): AgentSteps {
  const { ports } = hooks;
  const { emit, reserve, stopForLimit, invokeRole, failed } = createRoleCalls(hooks);
  return {
    prepareAuthor: /* Резервирует попытку автора и расход бюджета до вызова модели. */ (state) => ({
      value: reserve(state.value, "author"),
    }),
    callAuthor:
      /* Получает кандидата от автора, сохраняет новую версию и очищает старое ревью. */ async (
        state,
      ) => {
        const current = state.value;
        try {
          const { output, observations } = await invokeRole(current, "author");
          const candidate = AuthorOutputSchema.parse(output);
          const artifact = await ports.artifacts.writeVersion({
            taskId: current.taskId,
            candidate,
          });
          const completed: Attempt = {
            ...current.activeAttempt!,
            status: "completed",
            endedAt: now(),
            observations,
          };
          const next: TaskState = {
            ...current,
            currentArtifact: artifact,
            createdVersions: current.createdVersions + 1,
            phase: "checking",
            activeAttempt: null,
            lastAttempt: completed,
            latestReview: null,
            latestChecks: null,
            updatedAt: now(),
          };
          await emit(
            next,
            "version_created",
            `Автор создал версию ${artifact.versionId}.`,
            `${completed.attemptId}:version`,
            { from: "author", to: "reviewer", attemptId: completed.attemptId },
          );
          return { value: next };
        } catch (error) {
          return { value: await failed(current, error) };
        }
      },
    check:
      /* Запускает независимые проверки версии с поддержкой отмены и фиксирует результат. */ async (
        state,
      ) => {
        const current = state.value;
        if (!current.currentArtifact) throw new Error("No candidate for checks");
        const controller = new AbortController();
        hooks.registerAbort(current.taskId, controller);
        try {
          const result = await ports.checks.run(current.currentArtifact, {
            signal: controller.signal,
            timeoutMs: current.limits.checkTimeoutMs,
            memoryLimitBytes: current.limits.checkMemoryBytes,
          });
          if (hooks.isStopRequested(current.taskId))
            return { value: stopForLimit(current, "Остановлено пользователем.") };
          const next: TaskState = {
            ...current,
            latestChecks: result,
            phase: "review",
            updatedAt: now(),
          };
          await emit(
            next,
            "checks_finished",
            `Проверки: ${result.compilation.status}, тесты: ${result.tests.status}.`,
            `${result.versionId}:checks`,
          );
          return { value: next };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const next: TaskState = {
            ...current,
            phase: hooks.isStopRequested(current.taskId) ? "stopped" : "error",
            stopReason: reason,
            updatedAt: now(),
          };
          await emit(
            next,
            next.phase === "stopped" ? "task_stopped" : "task_failed",
            reason,
            `${current.currentArtifact?.versionId}:check-error`,
          );
          return { value: next };
        } finally {
          hooks.clearAbort(current.taskId, controller);
        }
      },
    prepareReviewer: /* Резервирует попытку ревьюера до обращения к модели. */ (state) => ({
      value: reserve(state.value, "reviewer"),
    }),
    callReviewer:
      /* Проверяет ответ ревьюера и запрещает одобрение при проваленных независимых проверках. */ async (
        state,
      ) => {
        const current = state.value;
        try {
          const { output, observations } = await invokeRole(current, "reviewer");
          const parsed = ReviewerOutputSchema.parse(output);
          const artifact = current.currentArtifact!;
          const checksPassed =
            current.latestChecks?.compilation.status === "passed" &&
            current.latestChecks.tests.status === "passed";
          const verdict: "approved" | "changes_requested" =
            parsed.verdict === "approved" && checksPassed ? "approved" : "changes_requested";
          const findings = checksPassed
            ? parsed.findings
            : [...parsed.findings, "Независимые проверки не прошли; публикация запрещена."];
          const review = {
            reviewId: randomUUID(),
            versionId: artifact.versionId,
            manifestHash: artifact.manifestHash,
            verdict,
            findings,
            at: now(),
          };
          const completed: Attempt = {
            ...current.activeAttempt!,
            status: "completed",
            endedAt: now(),
            observations,
          };
          const next: TaskState = {
            ...current,
            latestReview: review,
            phase: verdict === "approved" ? "awaiting_approval" : "author",
            activeAttempt: null,
            lastAttempt: completed,
            updatedAt: now(),
          };
          await emit(
            next,
            "review_finished",
            verdict === "approved"
              ? "Ревьюер одобрил версию."
              : `Ревьюер запросил изменения: ${findings.join("; ")}`,
            `${completed.attemptId}:review`,
            {
              from: "reviewer",
              to: verdict === "approved" ? "user" : "author",
              attemptId: completed.attemptId,
            },
          );
          return { value: next };
        } catch (error) {
          return { value: await failed(current, error) };
        }
      },
    waitApproval: /* Приостанавливает граф до решения пользователя по точной версии и хешу. */ (
      state,
    ) => {
      const current = state.value;
      const artifact = current.currentArtifact;
      if (!artifact) throw new Error("Missing reviewed artifact");
      const raw = interrupt({ versionId: artifact.versionId, manifestHash: artifact.manifestHash });
      const approval = ApprovalSchema.parse(raw);
      const next: TaskState = {
        ...current,
        approval,
        phase: approval.decision === "approve" ? "applying" : "stopped",
        stopReason: approval.decision === "reject" ? "Пользователь отклонил версию." : null,
        updatedAt: now(),
      };
      return { value: next };
    },
    pauseUnknown: /* Ожидает явного повторного запуска после неизвестного исхода модели. */ (
      state,
    ) => {
      const current = state.value;
      interrupt({
        action: "explicit_retry_required",
        attemptId: current.lastAttempt?.attemptId ?? null,
      });
      return {
        value: { ...current, phase: "preparing" as const, stopReason: null, updatedAt: now() },
      };
    },
    pauseAuth: /* Сохраняет паузу до ручного продолжения после повторного входа. */ (state) => {
      const current = state.value;
      interrupt({ action: "login_required", attemptId: current.lastAttempt?.attemptId ?? null });
      return {
        value: { ...current, phase: "preparing" as const, stopReason: null, updatedAt: now() },
      };
    },
    prepareApplier: /* Резервирует вызов применяющего агента до публикации версии. */ (state) => ({
      value: reserve(state.value, "applier"),
    }),
    callApplier:
      /* Проверяет запрос применяющего агента и публикует точные одобренные байты. */ async (
        state,
      ) => {
        const current = state.value;
        try {
          const { output, observations } = await invokeRole(current, "applier");
          const parsed = ApplierOutputSchema.parse(output);
          const artifact = current.currentArtifact!;
          if (
            parsed.versionId !== artifact.versionId ||
            parsed.manifestHash !== artifact.manifestHash
          )
            throw new KnownAgentError("Applier requested a different artifact");
          if (hooks.isStopRequested(current.taskId))
            throw new Error("Task stopped before publication");
          hooks.setPublishing?.(current.taskId, true);
          let published;
          try {
            published = await ports.artifacts.publishApprovedVersion(artifact, current.approval!);
            for (const file of artifact.files) {
              const actual = await ports.artifacts.getFile(
                current.taskId,
                file.artifactId,
                "result",
              );
              if (createHash("sha256").update(actual.content).digest("hex") !== file.sha256)
                throw new KnownAgentError(`Published file mismatch: ${file.path}`);
            }
          } finally {
            hooks.setPublishing?.(current.taskId, false);
          }
          const completed: Attempt = {
            ...current.activeAttempt!,
            status: "completed",
            endedAt: now(),
            observations,
          };
          const next: TaskState = {
            ...current,
            phase: "completed",
            resultPath: published.resultPath,
            activeAttempt: null,
            lastAttempt: completed,
            updatedAt: now(),
          };
          await emit(
            next,
            "publication_finished",
            "Одобренная версия опубликована.",
            `${completed.attemptId}:published`,
            { from: "applier", to: "user", attemptId: completed.attemptId },
          );
          return { value: next };
        } catch (error) {
          return { value: await failed(current, error) };
        }
      },
  };
}
