import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { ChangeSessionDirectory } from "@opencode-ai/core/control-plane/change-session-directory"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Location } from "@opencode-ai/core/location"
import { EventTable } from "@opencode-ai/core/event/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      ChangeSessionDirectory.node,
      Database.node,
      EventV2.node,
      ProjectDirectories.node,
      Project.node,
      SessionAdmission.node,
      SessionProjector.node,
    ]),
  ),
)

describe("ChangeSessionDirectory", () => {
  it.effect("atomically stores an exact nested directory, registers its root, and resets only its context epoch", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const projectID = Project.ID.make("project-directory-control")
      const source = AbsolutePath.make("/project/source")
      const root = AbsolutePath.make("/project/worktree")
      const destination = AbsolutePath.make("/project/worktree/packages/core")
      const sessionID = SessionV2.ID.make("ses_directory_control")
      const unrelated = SessionV2.ID.make("ses_directory_unrelated")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: sessionID,
            project_id: projectID,
            slug: "selected",
            directory: source,
            title: "selected",
            version: "test",
          },
          { id: unrelated, project_id: projectID, slug: "other", directory: source, title: "other", version: "test" },
        ])
        .run()
      yield* db
        .insert(SessionContextEpochTable)
        .values([
          { session_id: sessionID, baseline: "selected", snapshot: {}, baseline_seq: 0 },
          { session_id: unrelated, baseline: "other", snapshot: {}, baseline_seq: 0 },
        ])
        .run()

      const control = yield* ChangeSessionDirectory.Service
      const directories = yield* ProjectDirectories.Service
      const session = yield* control.change({ sessionID, expectedSource: source, destination, root })

      expect(session.location.directory).toBe(destination)
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, unrelated))
          .get(),
      ).toMatchObject({ baseline: "other" })
      expect(yield* directories.list(projectID)).toEqual([{ directory: root, strategy: undefined }])
    }),
  )

  it.effect("rolls back each directory-transition transaction failure without notification", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const directories = yield* ProjectDirectories.Service
      const control = yield* ChangeSessionDirectory.Service
      const projectID = Project.ID.make("project-directory-rollback")
      const source = AbsolutePath.make("/project/source")
      const root = AbsolutePath.make("/project/worktree")
      const destination = AbsolutePath.make("/project/worktree/packages/core")
      const sessionID = SessionV2.ID.make("ses_directory_rollback")
      const notified = new Array<string>()
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: source, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "rollback",
          directory: source,
          title: "rollback",
          version: "test",
        })
        .run()
      yield* db
        .insert(SessionContextEpochTable)
        .values({ session_id: sessionID, baseline: "baseline", snapshot: {}, baseline_seq: 0 })
        .run()
      yield* events.listen((event) =>
        Effect.sync(() => {
          notified.push(event.id)
        }),
      )

      const unchanged = Effect.fnUntraced(function* () {
        expect(
          yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get(),
        ).toEqual({ directory: source })
        expect(
          yield* db.select().from(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, projectID)).all(),
        ).toEqual([])
        expect(
          yield* db
            .select()
            .from(SessionContextEpochTable)
            .where(eq(SessionContextEpochTable.session_id, sessionID))
            .get(),
        ).toMatchObject({ baseline: "baseline" })
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
      })
      const change = () => control.change({ sessionID, expectedSource: source, destination, root })

      expect(
        yield* control
          .change({ sessionID, expectedSource: AbsolutePath.make("/project/stale"), destination, root })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      yield* unchanged()

      for (const [name, statement] of [
        [
          "directory_registration",
          "CREATE TRIGGER fail_directory_registration BEFORE INSERT ON project_directory BEGIN SELECT RAISE(ABORT, 'registration failed'); END",
        ],
        [
          "context_reset",
          "CREATE TRIGGER fail_context_reset BEFORE DELETE ON session_context_epoch BEGIN SELECT RAISE(ABORT, 'context reset failed'); END",
        ],
        [
          "event_row",
          "CREATE TRIGGER fail_event_row BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'event row failed'); END",
        ],
      ] as const) {
        yield* db.run(sql.raw(statement))
        expect(yield* change().pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        yield* db.run(sql.raw(`DROP TRIGGER fail_${name}`))
        yield* unchanged()
      }

      expect(
        yield* events
          .publish(
            SessionEvent.Moved,
            {
              sessionID,
              location: Location.Ref.make({ directory: root }),
              subdirectory: RelativePath.make("./packages/core"),
              timestamp: DateTime.makeUnsafe(1),
            },
            { commit: () => Effect.die("commit failed") },
          )
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      yield* unchanged()

      yield* events.project(SessionEvent.Moved, () => Effect.die("projector failed"))
      expect(yield* change().pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      yield* unchanged()
      expect(notified).toEqual([])
    }),
  )

  it.effect("replays root-relative moves and retains legacy direct-directory compatibility", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const directories = yield* ProjectDirectories.Service
      const projectID = Project.ID.make("project-directory-replay")
      const source = AbsolutePath.make("/project/source")
      const root = AbsolutePath.make("/project/worktree")
      const destination = AbsolutePath.make("/project/worktree/packages/core")
      const sessionID = SessionV2.ID.make("ses_directory_replay")
      yield* db.insert(ProjectTable).values({ id: projectID, worktree: source, sandboxes: [] }).run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "replay",
          directory: source,
          title: "replay",
          version: "test",
        })
        .run()
      yield* db
        .insert(SessionContextEpochTable)
        .values({ session_id: sessionID, baseline: "baseline", snapshot: {}, baseline_seq: 0 })
        .run()
      const published = yield* events.publish(SessionEvent.Moved, {
        sessionID,
        location: Location.Ref.make({ directory: root }),
        subdirectory: RelativePath.make("./packages/core"),
        timestamp: DateTime.makeUnsafe(1),
      })
      const serialized = yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get()
      expect(serialized).toBeDefined()
      expect(yield* directories.list(projectID)).toEqual([{ directory: root, strategy: undefined }])
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* events.remove(sessionID)
      yield* db.update(SessionTable).set({ directory: source, path: null }).where(eq(SessionTable.id, sessionID)).run()
      yield* db.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, projectID)).run()
      yield* db
        .insert(SessionContextEpochTable)
        .values({ session_id: sessionID, baseline: "baseline", snapshot: {}, baseline_seq: 0 })
        .run()
      if (!serialized) throw new Error("missing serialized move")
      yield* events.replay({
        id: serialized.id,
        type: serialized.type,
        seq: serialized.seq,
        aggregateID: serialized.aggregate_id,
        data: serialized.data,
      })
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination })
      expect(yield* directories.list(projectID)).toEqual([{ directory: root, strategy: undefined }])
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* events.remove(sessionID)
      yield* db.update(SessionTable).set({ directory: source, path: null }).where(eq(SessionTable.id, sessionID)).run()
      yield* db.delete(ProjectDirectoryTable).where(eq(ProjectDirectoryTable.project_id, projectID)).run()
      yield* db
        .insert(SessionContextEpochTable)
        .values({ session_id: sessionID, baseline: "baseline", snapshot: {}, baseline_seq: 0 })
        .run()
      yield* events.replay({
        id: EventV2.ID.make("evt_legacy_directory_move"),
        type: EventV2.versionedType(SessionEvent.Moved.type, 1),
        seq: 0,
        aggregateID: sessionID,
        data: {
          sessionID,
          location: { directory: destination },
          subdirectory: "packages/core",
          timestamp: 1,
        },
      })
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination })
      expect(yield* directories.list(projectID)).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()
    }),
  )

  it.effect("keeps a committed move after notification loss and suppresses exact-read repair replay", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const projectID = Project.ID.make("project-directory-notification")
      const source = AbsolutePath.make("/project/source")
      const root = AbsolutePath.make("/project/worktree")
      const destination = AbsolutePath.make("/project/worktree/packages/core")
      const sessionID = SessionV2.ID.make("ses_directory_notification")
      let observed = 0
      yield* db.insert(ProjectTable).values({ id: projectID, worktree: source, sandboxes: [] }).run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "notification",
          directory: source,
          title: "notification",
          version: "test",
        })
        .run()
      yield* events.listen(() => Effect.die("notification lost"))
      yield* events.listen(() =>
        Effect.sync(() => {
          observed += 1
        }),
      )
      const published = yield* events.publish(SessionEvent.Moved, {
        sessionID,
        location: Location.Ref.make({ directory: root }),
        subdirectory: RelativePath.make("./packages/core"),
        timestamp: DateTime.makeUnsafe(1),
      })
      const serialized = yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).get()
      expect(serialized).toBeDefined()
      expect(observed).toBe(1)
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory: destination })
      if (!serialized) throw new Error("missing committed move")
      yield* events.replay(
        {
          id: serialized.id,
          type: serialized.type,
          seq: serialized.seq,
          aggregateID: serialized.aggregate_id,
          data: serialized.data,
        },
        { publish: true },
      )
      expect(observed).toBe(1)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.id, published.id)).all()).toHaveLength(1)
    }),
  )
})
