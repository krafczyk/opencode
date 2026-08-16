export * as SessionControl from "./control"

import { ChangeSessionDirectory } from "@opencode-ai/core/control-plane/change-session-directory"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { and, eq, isNull, sql } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { SessionControlState } from "./control-state"
import { SessionRunState } from "./run-state"

/** A request to change one selected session's durable directory without changing either worktree. */
export const ChangeDirectoryInput = Schema.Struct({
  sessionID: SessionSchema.ID,
  expectedSource: AbsolutePath,
  destination: AbsolutePath,
}).annotate({ identifier: "SessionControl.ChangeDirectoryInput" })
export type ChangeDirectoryInput = typeof ChangeDirectoryInput.Type

/** Identifies the selected session whose cached location-derived context must be discarded. */
export const ReloadContextInput = Schema.Struct({
  sessionID: SessionSchema.ID,
}).annotate({ identifier: "SessionControl.ReloadContextInput" })
export type ReloadContextInput = typeof ReloadContextInput.Type

/** A stable refusal category that intentionally exposes no prompt or interaction content. */
export const Refusal = Schema.Literals([
  "not_found",
  "stale_source",
  "blocked",
  "missing_directory",
  "not_directory",
  "not_git",
  "origin_missing",
  "origin_mismatch",
]).annotate({ identifier: "SessionControl.Refusal" })
export type Refusal = typeof Refusal.Type

/**
 * The server-authoritative result of a selected-session directory request.
 * `completed` includes the exact post-commit session; `precommit_failed` makes no mutation claim, while client dispatch
 * or notification reconciliation remains outside this domain service.
 */
export type ChangeDirectoryResult =
  | { readonly type: "noop"; readonly session: SessionSchema.Info }
  | { readonly type: "refused"; readonly reason: Refusal }
  | { readonly type: "completed"; readonly session: SessionSchema.Info }
  | { readonly type: "precommit_failed" }

/**
 * The outcome of an explicit selected-session context reload.
 * Completed results confirm that admission reopened after the selected epoch was deleted; failures preserve the old
 * epoch, while `recovery_uncertain` is reserved for a future admission implementation that cannot confirm restoration.
 */
export type ReloadContextResult =
  | { readonly type: "idle_complete" }
  | { readonly type: "interrupted_complete" }
  | { readonly type: "failed_before_reset" }
  | { readonly type: "recovery_uncertain" }

/**
 * Provides server-owned selected-session directory and context controls under the session admission lease.
 * Directory changes validate shared blockers and destination identity without changing either worktree. Context reloads
 * quiesce both execution systems before resetting one cached epoch. Callers own client-side reconciliation.
 */
export interface Interface {
  readonly changeDirectory: (input: ChangeDirectoryInput) => Effect.Effect<ChangeDirectoryResult>
  /**
   * Fences one session, interrupts current and legacy execution, and resets only its cached context epoch.
   * It never persists a prompt or message, changes session identity or location, or reloads the project instance.
   */
  readonly reloadContext: (input: ReloadContextInput) => Effect.Effect<ReloadContextResult>
}

/** Provides server-owned blocker, quiescence, and mutation policy for selected-session controls. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const admission = yield* SessionAdmission.Service
    const directories = yield* ProjectDirectories.Service
    const filesystem = yield* FSUtil.Service
    const project = yield* ProjectV2.Service
    const sessions = yield* SessionStore.Service
    const change = yield* ChangeSessionDirectory.Service
    const controlState = yield* SessionControlState.Service
    const execution = yield* SessionExecution.Service
    const runState = yield* SessionRunState.Service

    const changeDirectory = Effect.fn("SessionControl.changeDirectory")(function* (input: ChangeDirectoryInput) {
      const initial = yield* sessions.get(input.sessionID)
      if (!initial) return { type: "refused" as const, reason: "not_found" as const }
      if (initial.location.directory !== input.expectedSource) {
        return { type: "refused" as const, reason: "stale_source" as const }
      }
      return yield* admission
        .withSessionControl(
          { sessionID: input.sessionID, instanceID: initial.location.directory },
          Effect.gen(function* () {
            const current = yield* sessions.get(input.sessionID)
            if (!current) return { type: "refused" as const, reason: "not_found" as const }
            if (current.location.directory !== input.expectedSource) {
              return { type: "refused" as const, reason: "stale_source" as const }
            }
            // The lease makes this an authoritative no-op even if later blocker or Git checks would now fail.
            if (current.location.directory === input.destination) return { type: "noop" as const, session: current }
            const pending = (yield* db
              .select({
                steer: sql<number>`coalesce(sum(case when ${SessionInputTable.delivery} = 'steer' and ${SessionInputTable.promoted_seq} is null then 1 else 0 end), 0)`,
                queue: sql<number>`coalesce(sum(case when ${SessionInputTable.delivery} = 'queue' and ${SessionInputTable.promoted_seq} is null then 1 else 0 end), 0)`,
              })
              .from(SessionInputTable)
              .where(and(eq(SessionInputTable.session_id, input.sessionID), isNull(SessionInputTable.promoted_seq)))
              .get()) ?? { steer: 0, queue: 0 }
            const state = yield* controlState.snapshot({
              sessionID: input.sessionID,
              instanceID: initial.location.directory,
              pendingInputs: pending,
            })
            if (
              state.activity !== "idle" ||
              state.pendingInputs.steer !== 0 ||
              state.pendingInputs.queue !== 0 ||
              state.pendingInteractions.permission !== 0 ||
              state.pendingInteractions.question !== 0
            ) {
              return { type: "refused" as const, reason: "blocked" as const }
            }
            const registered = yield* directories.list(current.projectID)
            const registeredRoot = registered
              .map((item) => item.directory)
              .filter((root) => FSUtil.contains(root, input.destination))
              .toSorted((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0]
            if (!(yield* filesystem.existsSafe(input.destination))) {
              return { type: "refused" as const, reason: "missing_directory" as const }
            }
            if (!(yield* filesystem.isDir(input.destination))) {
              return { type: "refused" as const, reason: "not_directory" as const }
            }
            if (registeredRoot) {
              const session = yield* change.change({ ...input, root: registeredRoot })
              return { type: "completed" as const, session }
            }
            const destination = yield* project.origin(input.destination)
            if (!destination) return { type: "refused" as const, reason: "not_git" as const }
            const projectRow = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, current.projectID)).get()
            const origin = projectRow ? yield* project.origin(AbsolutePath.make(projectRow.worktree)) : undefined
            if (!destination.identity || !origin?.identity) {
              return { type: "refused" as const, reason: "origin_missing" as const }
            }
            if (destination.identity !== origin.identity)
              return { type: "refused" as const, reason: "origin_mismatch" as const }
            const session = yield* change.change({ ...input, root: destination.root })
            return { type: "completed" as const, session }
          }),
        )
        .pipe(
          Effect.catchTag("SessionAdmission.ControlInProgressError", () =>
            Effect.succeed({ type: "refused" as const, reason: "blocked" as const }),
          ),
          Effect.catch(() => Effect.succeed({ type: "precommit_failed" as const })),
        )
    })
    const reloadContext = Effect.fn("SessionControl.reloadContext")(function* (input: ReloadContextInput) {
      const initial = yield* sessions.get(input.sessionID)
      if (!initial) return { type: "failed_before_reset" as const }
      return yield* admission
        .withSessionControl(
          { sessionID: input.sessionID, instanceID: initial.location.directory },
          Effect.gen(function* () {
            const current = yield* sessions.get(input.sessionID)
            if (!current) return { type: "failed_before_reset" as const }
            const active = yield* controlState.snapshot({
              sessionID: input.sessionID,
              instanceID: current.location.directory,
              pendingInputs: { steer: 0, queue: 0 },
            })
            const interrupted = active.activity !== "idle" || active.backgroundJobs !== 0
            const stops = yield* Effect.all([
              execution.interrupt(input.sessionID).pipe(Effect.exit, Effect.timeoutOption("5 seconds")),
              runState.cancel(input.sessionID).pipe(Effect.exit, Effect.timeoutOption("5 seconds")),
            ])
            if (stops.some(Option.isNone) || stops.some((stop) => stop._tag === "Some" && Exit.isFailure(stop.value))) {
              return { type: "failed_before_reset" as const }
            }
            const quiesced = yield* controlState
              .awaitQuiescent({ sessionID: input.sessionID, instanceID: current.location.directory })
              .pipe(Effect.timeoutOption("5 seconds"))
            if (Option.isNone(quiesced)) {
              return { type: "failed_before_reset" as const }
            }
            const reset = yield* SessionContextEpoch.reset(db, input.sessionID).pipe(Effect.exit)
            if (Exit.isFailure(reset)) return { type: "failed_before_reset" as const }
            return { type: interrupted ? ("interrupted_complete" as const) : ("idle_complete" as const) }
          }),
        )
        .pipe(
          Effect.catchTag("SessionAdmission.ControlInProgressError", () =>
            Effect.succeed({ type: "failed_before_reset" as const }),
          ),
          Effect.catch(() => Effect.succeed({ type: "recovery_uncertain" as const })),
        )
    })
    return Service.of({ changeDirectory, reloadContext })
  }),
)

/** Process-global server control node. It does not define an HttpApi route. */
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    ChangeSessionDirectory.node,
    Database.node,
    FSUtil.node,
    ProjectDirectories.node,
    ProjectV2.node,
    SessionAdmission.node,
    SessionControlState.node,
    SessionExecution.node,
    SessionRunState.node,
    SessionStore.node,
  ],
})
