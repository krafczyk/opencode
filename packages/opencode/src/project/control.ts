import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { SessionControlState } from "../session/control-state"
import { InstanceStore } from "./instance-store"
import { Project } from "./project"

/** Identifies the selected session and client-selected instance context for a guarded project reload. */
export class ReloadInput extends Schema.Class<ReloadInput>("ProjectControl.ReloadInput")({
  sessionID: SessionSchema.ID,
  directory: AbsolutePath,
}) {}

/** Privacy-safe refusal categories returned before an instance reload is dispatched. */
export const Refusal = Schema.Literals([
  "not_found",
  "stale_context",
  "blocked",
  "control_in_progress",
  "malformed_state",
]).annotate({ identifier: "ProjectControl.Refusal" })
export type Refusal = typeof Refusal.Type

/**
 * The server-authoritative outcome of one guarded exact-instance reload.
 * A refusal has no disposal side effect, `completed` confirms replacement bootstrap, `recovery_failed` reports a
 * dispatched reload that could not complete, and `uncertain` reserves an explicit recovery boundary for a future
 * admission implementation that cannot confirm restoration.
 */
export type ReloadResult =
  | { readonly type: "refused"; readonly reason: Refusal }
  | { readonly type: "completed" }
  | { readonly type: "recovery_failed" }
  | { readonly type: "uncertain" }

/**
 * Owns guarded project reload policy below transport adapters.
 * It derives the exact target from durable session state, fences that instance while earlier work becomes visible,
 * and inspects only privacy-safe blocker categories before dispatching one reload. It never creates prompts,
 * messages, model turns, provider requests, or client transport state.
 */
export interface Interface {
  /**
   * Reloads the selected session's exact durable instance after blocker validation.
   * Refusals occur before disposal; completion confirms bootstrap, while failure categories preserve causal uncertainty.
   */
  readonly reload: (input: ReloadInput) => Effect.Effect<ReloadResult>
}

/** Provides server-authoritative guarded exact-instance reload policy. */
export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const admission = yield* SessionAdmission.Service
    const controlState = yield* SessionControlState.Service
    const sessions = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service

    const reload = Effect.fn("ProjectControl.reload")(function* (input: ReloadInput) {
      const selected = yield* sessions.get(input.sessionID)
      if (!selected) return { type: "refused" as const, reason: "not_found" as const }
      const instanceID = SessionAdmission.InstanceID.make(FSUtil.resolve(selected.location.directory))
      if (instanceID !== FSUtil.resolve(input.directory)) {
        return { type: "refused" as const, reason: "stale_context" as const }
      }
      const projectRow = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, selected.projectID))
        .get()
        .pipe(Effect.exit)
      if (Exit.isFailure(projectRow) || !projectRow.value) {
        return { type: "refused" as const, reason: "malformed_state" as const }
      }

      return yield* admission
        .withInstanceControl(
          instanceID,
          instances.provideContext(
            {
              directory: instanceID,
              worktree: projectRow.value.worktree,
              project: Project.fromRow(projectRow.value),
            },
            Effect.gen(function* () {
              const current = yield* sessions.get(input.sessionID).pipe(Effect.exit)
              if (Exit.isFailure(current)) return { type: "refused" as const, reason: "malformed_state" as const }
              if (!current.value) return { type: "refused" as const, reason: "not_found" as const }
              if (FSUtil.resolve(current.value.location.directory) !== instanceID) {
                return { type: "refused" as const, reason: "stale_context" as const }
              }

              const located = yield* db
                .select({ id: SessionTable.id, directory: SessionTable.directory })
                .from(SessionTable)
                .where(eq(SessionTable.directory, instanceID))
                .all()
                .pipe(Effect.exit)
              if (Exit.isFailure(located)) return { type: "refused" as const, reason: "malformed_state" as const }
              const targets = located.value
              if (!targets.some((item) => item.id === input.sessionID)) {
                return { type: "refused" as const, reason: "stale_context" as const }
              }

              const blockers = yield* Effect.forEach(targets, (target) =>
                Effect.gen(function* () {
                  const pending = yield* SessionInput.pendingCounts(db, target.id)
                  return yield* controlState.snapshot({ sessionID: target.id, instanceID, pendingInputs: pending })
                }).pipe(Effect.exit),
              )
              if (blockers.some(Exit.isFailure)) return { type: "refused" as const, reason: "malformed_state" as const }
              if (
                blockers.some(
                  (snapshot) =>
                    Exit.isSuccess(snapshot) &&
                    (SessionControlState.hasWorkOrInteractions(snapshot.value) || snapshot.value.control === "session"),
                )
              ) {
                return { type: "refused" as const, reason: "blocked" as const }
              }

              const result = yield* instances.reloadForControl({ directory: instanceID })
              if (result.type === "completed") return { type: "completed" as const }
              if (result.type === "recovery_failed") return { type: "recovery_failed" as const }
              return { type: "uncertain" as const }
            }),
          ),
        )
        .pipe(
          Effect.catchTag("SessionAdmission.ControlInProgressError", () =>
            Effect.succeed({ type: "refused" as const, reason: "control_in_progress" as const }),
          ),
          Effect.catchCause(() => Effect.succeed({ type: "uncertain" as const })),
        )
    })

    return Service.of({ reload })
  }),
)

/** Process-global guarded project control node. It does not define an HttpApi route. */
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, InstanceStore.node, SessionAdmission.node, SessionControlState.node, SessionStore.node],
})

export * as ProjectControl from "./control"
