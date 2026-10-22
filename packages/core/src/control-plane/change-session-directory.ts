export * as ChangeSessionDirectory from "./change-session-directory"

import { and, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import path from "path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { AbsolutePath, RelativePath } from "../schema"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { SessionStore } from "../session/store"

/** Input for an atomic selected-session directory transition. `root` is the validated destination root; optional `project` selects its owner. */
export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  expectedSource: AbsolutePath,
  destination: AbsolutePath,
  root: AbsolutePath,
  project: Schema.optional(SessionEvent.MoveProject),
}).annotate({ identifier: "ChangeSessionDirectory.Input" })
export type Input = typeof Input.Type

/** Returned when the selected durable session is absent or no longer belongs to its expected source directory. */
export class StaleSourceError extends Schema.TaggedErrorClass<StaleSourceError>()(
  "ChangeSessionDirectory.StaleSourceError",
  {
    sessionID: SessionSchema.ID,
    expectedSource: AbsolutePath,
  },
) {}

/**
 * Commits a selected session's exact directory, optional project reassignment/creation, root registration, moved event,
 * and context-epoch reset atomically. Returns the updated session or StaleSourceError when its source changed.
 * Callers must validate the destination directory and resolve its project before invoking it; this service never moves, copies, applies,
 * discards, cleans, or otherwise changes a worktree.
 */
export interface Interface {
  readonly change: (input: Input) => Effect.Effect<SessionSchema.Info, StaleSourceError>
}

/** Provides the durable no-worktree selected-session directory transition. */
export class Service extends Context.Service<Service, Interface>()("@opencode/ChangeSessionDirectory") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const change = Effect.fn("ChangeSessionDirectory.change")(function* (input: Input) {
      const current = yield* sessions.get(input.sessionID)
      if (!current || current.location.directory !== input.expectedSource) {
        return yield* new StaleSourceError({ sessionID: input.sessionID, expectedSource: input.expectedSource })
      }
      const subdirectory = path.relative(input.root, input.destination).replaceAll("\\", "/")
      return yield* Effect.gen(function* () {
        yield* events.publish(
          SessionEvent.Moved,
          {
            sessionID: input.sessionID,
            location: Location.Ref.make({ directory: input.root }),
            project: input.project,
            // Legacy moves store a plain relative path; the control prefix makes registration intent replayable.
            subdirectory: RelativePath.make(subdirectory ? `./${subdirectory}` : "."),
            timestamp: yield* DateTime.now,
          },
          {
            beforeProject: () =>
              db
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(
                  and(
                    eq(SessionTable.id, input.sessionID),
                    eq(SessionTable.directory, input.expectedSource),
                    eq(SessionTable.project_id, current.projectID),
                  ),
                )
                .get()
                .pipe(
                  Effect.flatMap((row) =>
                    row
                      ? Effect.void
                      : new StaleSourceError({ sessionID: input.sessionID, expectedSource: input.expectedSource }),
                  ),
                  Effect.orDie,
                ),
          },
        )
        const changed = yield* sessions.get(input.sessionID)
        if (!changed)
          return yield* new StaleSourceError({ sessionID: input.sessionID, expectedSource: input.expectedSource })
        return changed
      })
    })
    return Service.of({ change })
  }),
)

/** Process-global node for the durable directory transition and its transaction dependencies. */
export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionStore.node],
})
