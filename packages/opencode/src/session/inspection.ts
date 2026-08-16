import { SessionControlState } from "@/session/control-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Project } from "@/project/project"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@opencode-ai/core/git"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectSchema } from "@opencode-ai/core/project/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath, NonNegativeInt } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"

/** Server-defined classification of a session's durable directory. */
export const LocationClassification = Schema.Literals([
  "primary_worktree",
  "recognized_worktree",
  "registered_directory",
  "unregistered",
]).annotate({ identifier: "SessionInspection.LocationClassification" })
export type LocationClassification = typeof LocationClassification.Type

/** A server-known project directory or worktree available to clients without local filesystem interpretation. */
export class Directory extends Schema.Class<Directory>("SessionInspection.Directory")({
  directory: AbsolutePath,
  classification: LocationClassification,
}) {}

class SessionInfo extends Schema.Class<SessionInfo>("SessionInspection.SessionInfo")({
  id: SessionSchema.ID,
  directory: AbsolutePath,
}) {}

class ProjectInfo extends Schema.Class<ProjectInfo>("SessionInspection.ProjectInfo")({
  id: ProjectSchema.ID,
  primaryDirectory: AbsolutePath,
}) {}

class Location extends Schema.Class<Location>("SessionInspection.Location")({
  classification: LocationClassification,
  root: Schema.optional(AbsolutePath),
}) {}

class Counts extends Schema.Class<Counts>("SessionInspection.Counts")({
  userPrompts: NonNegativeInt,
  completedAssistantResponses: NonNegativeInt,
}) {}

/**
 * A bounded aggregate snapshot of one selected session.
 * Durable fields and counts share one SQLite transaction; `control` is an observed process-local
 * state attached afterward. It exposes no message, prompt, interaction, job-output, model, header,
 * credential, or permission/question body content.
 */
export class Snapshot extends Schema.Class<Snapshot>("SessionInspection.Snapshot")({
  session: SessionInfo,
  project: ProjectInfo,
  location: Location,
  directories: Schema.Array(Directory),
  counts: Counts,
  control: SessionControlState.Snapshot,
}) {}

/** Returned when the requested session no longer has a durable row. */
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionInspection.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

/**
 * Reads one authoritative selected-session inspection snapshot.
 * It accepts a session ID, fails with `NotFoundError` for a deleted session, reads only bounded
 * database aggregates, discovers available Git worktrees, and performs no model, prompt, or mutation side effect.
 */
export interface Interface {
  readonly inspect: (sessionID: SessionSchema.ID) => Effect.Effect<Snapshot, NotFoundError>
}

/** Provides the shared aggregate session inspection service. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInspection") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const directories = yield* ProjectDirectories.Service
    const sessions = yield* SessionStore.Service
    const git = yield* Git.Service
    const controlState = yield* SessionControlState.Service

    const inspect = Effect.fn("SessionInspection.inspect")(function* (sessionID: SessionSchema.ID) {
      const transaction = db.transaction((tx) =>
        Effect.gen(function* () {
          const session = yield* tx
            .select({ id: SessionTable.id, projectID: SessionTable.project_id, directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
          if (!session) return yield* new NotFoundError({ sessionID })
          const projectRow = yield* tx.select().from(ProjectTable).where(eq(ProjectTable.id, session.projectID)).get()
          if (!projectRow) return yield* new NotFoundError({ sessionID })
          const project = Project.fromRow(projectRow)
          const [registered, counts, pending] = yield* Effect.all([
            directories.list(session.projectID, tx),
            sessions.counts(sessionID, tx),
            SessionInput.pendingCounts(tx, sessionID),
          ])
          return { session, project, registered, counts, pending }
        }),
      )
      const durableResult = yield* transaction.pipe(
        Effect.map((value) => ({ type: "success" as const, value })),
        Effect.catchTag("SessionInspection.NotFoundError", (error) =>
          Effect.succeed({ type: "not-found" as const, error }),
        ),
        Effect.orDie,
      )
      if (durableResult.type === "not-found") return yield* durableResult.error
      const durable = durableResult.value
      const primaryDirectory = AbsolutePath.make(durable.project.worktree)
      const repository = yield* git.repo.discover(primaryDirectory)
      const recognized = repository
        ? yield* git.worktree.list(repository).pipe(
            Effect.map((worktrees) =>
              worktrees.filter((worktree) => worktree.kind === "linked").map((worktree) => worktree.directory),
            ),
            Effect.catch(() => Effect.succeed([])),
          )
        : []
      const registered = durable.registered.map((item) => item.directory)
      const classify = (directory: AbsolutePath) =>
        ProjectDirectories.classify({
          directory,
          primary: primaryDirectory,
          recognized,
          registered,
        })
      const sessionDirectory = AbsolutePath.make(durable.session.directory)
      const location = classify(sessionDirectory)
      const available = [...new Set([primaryDirectory, ...recognized.toSorted(), ...registered.toSorted()])].map(
        (directory) => new Directory({ directory, classification: classify(directory).type }),
      )
      const control = yield* controlState
        .snapshot({
          sessionID,
          instanceID: sessionDirectory,
          pendingInputs: durable.pending,
        })
        .pipe(
          Effect.provideService(InstanceRef, {
            directory: sessionDirectory,
            worktree: primaryDirectory,
            project: durable.project,
          }),
        )
      return new Snapshot({
        session: new SessionInfo({ id: durable.session.id, directory: sessionDirectory }),
        project: new ProjectInfo({ id: durable.project.id, primaryDirectory }),
        location:
          location.type === "unregistered"
            ? new Location({ classification: location.type })
            : new Location({ classification: location.type, root: location.root }),
        directories: available,
        counts: new Counts(durable.counts),
        control,
      })
    })

    return Service.of({ inspect })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Git.node, ProjectDirectories.node, SessionStore.node, SessionControlState.node],
})

export * as SessionInspection from "./inspection"
