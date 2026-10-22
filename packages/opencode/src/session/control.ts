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
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { InstanceStore } from "../project/instance-store"
import { Project } from "../project/project"
import { eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { SessionControlState } from "./control-state"
import { SessionRunState } from "./run-state"

/** A request to move one selected idle session to an existing directory, including another project, without moving files. */
export class ChangeDirectoryInput extends Schema.Class<ChangeDirectoryInput>("SessionControl.ChangeDirectoryInput")({
  sessionID: SessionSchema.ID,
  expectedSource: AbsolutePath,
  destination: AbsolutePath,
}) {}

/** Identifies the selected session whose cached location-derived context must be discarded. */
export class ReloadContextInput extends Schema.Class<ReloadContextInput>("SessionControl.ReloadContextInput")({
  sessionID: SessionSchema.ID,
}) {}

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
 * Directory changes validate shared blockers and an existing destination, resolve its project, and atomically update
 * placement and ownership without changing worktree files. Registered roots retain their explicit project association. Context reloads
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
    const instances = yield* InstanceStore.Service

    const changeDirectory = Effect.fn("SessionControl.changeDirectory")(function* (input: ChangeDirectoryInput) {
      const initial = yield* sessions.get(input.sessionID)
      if (!initial) return { type: "refused" as const, reason: "not_found" as const }
      if (initial.location.directory !== input.expectedSource) {
        return { type: "refused" as const, reason: "stale_source" as const }
      }
      const contextProject = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, initial.projectID))
        .get()
        .pipe(Effect.exit)
      if (Exit.isFailure(contextProject) || !contextProject.value) return { type: "precommit_failed" as const }
      return yield* admission
        .withSessionControl(
          { sessionID: input.sessionID, instanceID: FSUtil.resolve(initial.location.directory) },
          instances.provideContext(
            {
              directory: initial.location.directory,
              worktree: contextProject.value.worktree,
              project: Project.fromRow(contextProject.value),
            },
            Effect.gen(function* () {
              const current = yield* sessions.get(input.sessionID)
              if (!current) return { type: "refused" as const, reason: "not_found" as const }
              if (current.location.directory !== input.expectedSource) {
                return { type: "refused" as const, reason: "stale_source" as const }
              }
              // The lease makes this an authoritative no-op even if later blocker or Git checks would now fail.
              if (current.location.directory === input.destination) return { type: "noop" as const, session: current }
              const pending = yield* SessionInput.pendingCounts(db, input.sessionID)
              const state = yield* controlState.snapshot({
                sessionID: input.sessionID,
                instanceID: initial.location.directory,
                pendingInputs: pending,
              })
              if (SessionControlState.hasWorkOrInteractions(state)) {
                return { type: "refused" as const, reason: "blocked" as const }
              }
              const registered = yield* directories.list(current.projectID)
              const registeredRoot = registered
                .map((item) => item.directory)
                .filter((root) => FSUtil.contains(root, input.destination))
                .toSorted((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0]
              const destinationInfo = yield* filesystem.stat(input.destination).pipe(Effect.option)
              if (Option.isNone(destinationInfo)) {
                return { type: "refused" as const, reason: "missing_directory" as const }
              }
              if (destinationInfo.value.type !== "Directory") {
                return { type: "refused" as const, reason: "not_directory" as const }
              }
              if (registeredRoot) {
                const session = yield* change.change({ ...input, root: registeredRoot })
                return { type: "completed" as const, session }
              }
              const destination = yield* project.resolve(input.destination)
              const session = yield* change.change({
                ...input,
                root: destination.vcs ? destination.directory : input.destination,
                project: { id: destination.id, vcs: destination.vcs?.type },
              })
              return { type: "completed" as const, session }
            }),
          ),
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
      const contextProject = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, initial.projectID))
        .get()
        .pipe(Effect.exit)
      if (Exit.isFailure(contextProject) || !contextProject.value) return { type: "failed_before_reset" as const }
      return yield* admission
        .withSessionControl(
          { sessionID: input.sessionID, instanceID: FSUtil.resolve(initial.location.directory) },
          instances.provideContext(
            {
              directory: initial.location.directory,
              worktree: contextProject.value.worktree,
              project: Project.fromRow(contextProject.value),
            },
            Effect.gen(function* () {
              const current = yield* sessions.get(input.sessionID)
              if (!current) return { type: "failed_before_reset" as const }
              const active = yield* controlState.snapshot({
                sessionID: input.sessionID,
                instanceID: current.location.directory,
                pendingInputs: { steer: 0, queue: 0 },
              })
              const interrupted = active.activity !== "idle"
              const stops = yield* Effect.all([
                execution.interrupt(input.sessionID).pipe(Effect.exit, Effect.timeoutOption("5 seconds")),
                runState.cancel(input.sessionID).pipe(Effect.exit, Effect.timeoutOption("5 seconds")),
              ])
              if (
                stops.some(Option.isNone) ||
                stops.some((stop) => stop._tag === "Some" && Exit.isFailure(stop.value))
              ) {
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
          ),
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
    InstanceStore.node,
    ProjectDirectories.node,
    ProjectV2.node,
    SessionAdmission.node,
    SessionControlState.node,
    SessionExecution.node,
    SessionRunState.node,
    SessionStore.node,
  ],
})

export * as SessionControl from "./control"
