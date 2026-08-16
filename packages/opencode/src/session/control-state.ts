export * as SessionControlState from "./control-state"

import { BackgroundJob } from "@/background/job"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

/** Privacy-safe durable input categories that have not yet been promoted to user messages. */
export const PendingInputs = Schema.Struct({
  steer: NonNegativeInt,
  queue: NonNegativeInt,
}).annotate({ identifier: "SessionControlState.PendingInputs" })
export type PendingInputs = typeof PendingInputs.Type

/** Process-local execution state observed after the inspection transaction completes. */
export const Activity = Schema.Literals(["idle", "active", "retrying"]).annotate({
  identifier: "SessionControlState.Activity",
})
export type Activity = typeof Activity.Type

/** Privacy-safe pending interaction category counts. Request bodies are never returned. */
export const PendingInteractions = Schema.Struct({
  permission: NonNegativeInt,
  question: NonNegativeInt,
}).annotate({ identifier: "SessionControlState.PendingInteractions" })
export type PendingInteractions = typeof PendingInteractions.Type

/** Exclusive control ownership affecting a selected session. */
export const Control = Schema.Literals(["none", "session", "instance"]).annotate({
  identifier: "SessionControlState.Control",
})
export type Control = typeof Control.Type

/**
 * Observed process-local state for inspection and later mutation policy.
 * It contains no prompt, permission, question, job-output, model, or credential content.
 */
export const Snapshot = Schema.Struct({
  observed: Schema.Literal(true),
  activity: Activity,
  pendingInputs: PendingInputs,
  pendingInteractions: PendingInteractions,
  control: Control,
  backgroundJobs: NonNegativeInt,
}).annotate({ identifier: "SessionControlState.Snapshot" })
export type Snapshot = typeof Snapshot.Type

/** Input identifying the durable session and exact instance whose volatile state is observed. */
export interface SnapshotInput {
  readonly sessionID: SessionSchema.ID
  readonly instanceID: SessionAdmission.InstanceID
  readonly pendingInputs: PendingInputs
}

/**
 * Normalizes process-local current and legacy session ownership for shared controls.
 * `snapshot` attaches an observed, privacy-safe state to caller-supplied durable input counts;
 * it has no side effects and does not load or expose interaction content.
 */
export interface Interface {
  readonly snapshot: (input: SnapshotInput) => Effect.Effect<Snapshot>
}

/** Provides the shared process-local control-state observer. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionControlState") {}

/** Optional observer hooks for deterministic control-state integration tests. */
export interface LayerOptions {
  readonly beforeSnapshot?: (input: SnapshotInput) => Effect.Effect<void>
}

/** Builds the process-local control-state observer, optionally with test instrumentation. */
export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const execution = yield* SessionExecution.Service
      const runState = yield* SessionRunState.Service
      const status = yield* SessionStatus.Service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const background = yield* BackgroundJob.Service

      const snapshot = Effect.fn("SessionControlState.snapshot")(function* (input: SnapshotInput) {
        yield* options?.beforeSnapshot?.(input) ?? Effect.void
        const [admissionState, current, legacy, legacyStatus, permissions, questions, jobs] = yield* Effect.all([
          admission.snapshot,
          execution.active,
          runState.active(input.sessionID),
          status.get(input.sessionID),
          permission.list(),
          question.list(),
          background.list(),
        ])
        const descendants = activeBackgroundJobs(input.sessionID, jobs)
        const control: Control = admissionState.sessionControls.some((item) => item.sessionID === input.sessionID)
          ? "session"
          : admissionState.instanceControls.some((item) => item.instanceID === input.instanceID)
            ? "instance"
            : "none"
        const claimed = admissionState.claims.some((item) => item.sessionID === input.sessionID)
        const activity: Activity =
          legacyStatus.type === "retry"
            ? "retrying"
            : current.has(input.sessionID) || legacy || legacyStatus.type === "busy" || claimed || descendants > 0
              ? "active"
              : "idle"
        return {
          observed: true as const,
          activity,
          pendingInputs: input.pendingInputs,
          pendingInteractions: {
            permission: permissions.filter((item) => item.sessionID === input.sessionID).length,
            question: questions.filter((item) => item.sessionID === input.sessionID).length,
          },
          control,
          backgroundJobs: descendants,
        }
      })

      return Service.of({ snapshot })
    }),
  )

/** Default process-local control-state observer. */
export const layer = layerWith()

function activeBackgroundJobs(sessionID: SessionSchema.ID, jobs: ReadonlyArray<BackgroundJob.Info>) {
  const pending = new Set<string>([sessionID])
  const selected = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const job of jobs) {
      if (job.status !== "running" || selected.has(job.id)) continue
      if (
        pending.has(job.id) ||
        (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) ||
        (typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId))
      ) {
        selected.add(job.id)
        pending.add(job.id)
        if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
        changed = true
      }
    }
  }
  return selected.size
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    SessionAdmission.node,
    SessionExecution.node,
    SessionRunState.node,
    SessionStatus.node,
    Permission.node,
    Question.node,
    BackgroundJob.node,
  ],
})
