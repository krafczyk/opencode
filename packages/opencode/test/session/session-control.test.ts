import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { SessionControl } from "../../src/session/control"
import { SessionControlState } from "../../src/session/control-state"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { BackgroundJob } from "../../src/background/job"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { ChangeSessionDirectory } from "@opencode-ai/core/control-plane/change-session-directory"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Git } from "@opencode-ai/core/git"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const services = LayerNode.group([
  SessionControl.node,
  ChangeSessionDirectory.node,
  SessionControlState.node,
  Database.node,
  EventV2.node,
  Git.node,
  Project.node,
  ProjectDirectories.node,
  SessionAdmission.node,
  SessionProjector.node,
  SessionStore.node,
  SessionRunState.node,
  SessionStatus.node,
  BackgroundJob.node,
  Permission.node,
  Question.node,
  CrossSpawnSpawner.node,
  MoveSession.node,
])
const it = testEffect(AppNodeBuilder.build(services, [[SessionExecution.node, SessionExecution.noopLayer]]))
const currentSessionID = SessionSchema.ID.make("ses_directory_current_active")
const current = testEffect(
  AppNodeBuilder.build(services, [
    [
      SessionExecution.node,
      Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.succeed(new Set([currentSessionID])),
          resume: () => Effect.void,
          wake: () => Effect.void,
          interrupt: () => Effect.void,
        }),
      ),
    ],
  ]),
)
let beforeSnapshot: ((input: SessionControlState.SnapshotInput) => Effect.Effect<void>) | undefined
const raceControlState = LayerNode.make({
  service: SessionControlState.Service,
  layer: SessionControlState.layerWith({ beforeSnapshot: (input) => beforeSnapshot?.(input) ?? Effect.void }),
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
const race = testEffect(
  AppNodeBuilder.build(services, [
    [SessionExecution.node, SessionExecution.noopLayer],
    [SessionControlState.node, raceControlState],
  ]),
)

describe("SessionControl.changeDirectory", () => {
  it.instance("returns a lease-protected same-directory no-op before blocker or Git checks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_directory_noop")
      const directory = AbsolutePath.make(test.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "noop",
          directory,
          title: "noop",
          version: "test",
        })
        .run()
      yield* (yield* SessionStatus.Service).set(sessionID, { type: "busy" })

      const result = yield* (yield* SessionControl.Service).changeDirectory({
        sessionID,
        expectedSource: directory,
        destination: directory,
      })

      expect(result).toEqual({
        type: "noop",
        session: expect.objectContaining({ location: { directory } }),
      })
    }),
  )

  current.instance("returns same-directory no-op before current process activity checks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const directory = AbsolutePath.make(test.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: currentSessionID,
          project_id: Project.ID.global,
          slug: "current-active",
          directory,
          title: "current-active",
          version: "test",
        })
        .run()
      expect(
        yield* (yield* SessionControl.Service).changeDirectory({
          sessionID: currentSessionID,
          expectedSource: directory,
          destination: directory,
        }),
      ).toEqual({
        type: "noop",
        session: expect.objectContaining({ location: { directory } }),
      })
    }),
  )

  it.instance("returns same-directory no-op before retrying work and interaction checks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const source = AbsolutePath.make(test.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      const insert = (sessionID: SessionSchema.ID, slug: string) =>
        db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug,
            directory: source,
            title: slug,
            version: "test",
          })
          .run()
      const control = yield* SessionControl.Service
      const status = yield* SessionStatus.Service

      const retrying = SessionSchema.ID.make("ses_directory_retrying")
      yield* insert(retrying, "retrying")
      yield* status.set(retrying, { type: "retry", attempt: 1, message: "retry", next: 1 })
      expect(
        yield* control.changeDirectory({ sessionID: retrying, expectedSource: source, destination: source }),
      ).toMatchObject({
        type: "noop",
      })

      for (const delivery of ["steer", "queue"] as const) {
        const sessionID = SessionSchema.ID.make(`ses_directory_${delivery}`)
        yield* insert(sessionID, delivery)
        yield* db
          .insert(SessionInputTable)
          .values({
            id: SessionMessage.ID.make(`msg_directory_${delivery}`),
            session_id: sessionID,
            prompt: Prompt.make({ text: delivery }),
            delivery,
            admitted_seq: 0,
          })
          .run()
        expect(
          yield* control.changeDirectory({ sessionID, expectedSource: source, destination: source }),
        ).toMatchObject({
          type: "noop",
        })
      }

      const permissionSession = SessionSchema.ID.make("ses_directory_permission")
      yield* insert(permissionSession, "permission")
      const permission = yield* Permission.Service
      yield* permission
        .ask({
          sessionID: permissionSession,
          permission: "bash",
          patterns: ["directory-control"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        permission.list().pipe(Effect.map((items) => (items.length === 1 ? true : undefined))),
        "pending permission was not registered",
      )
      expect(
        yield* control.changeDirectory({ sessionID: permissionSession, expectedSource: source, destination: source }),
      ).toMatchObject({ type: "noop" })

      const questionSession = SessionSchema.ID.make("ses_directory_question")
      yield* insert(questionSession, "question")
      const question = yield* Question.Service
      yield* question.ask({ sessionID: questionSession, questions: [] }).pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        question.list().pipe(Effect.map((items) => (items.length === 1 ? true : undefined))),
        "pending question was not registered",
      )
      expect(
        yield* control.changeDirectory({ sessionID: questionSession, expectedSource: source, destination: source }),
      ).toMatchObject({ type: "noop" })

      const jobSession = SessionSchema.ID.make("ses_directory_descendant")
      yield* insert(jobSession, "descendant")
      const release = yield* Deferred.make<void>()
      yield* (yield* BackgroundJob.Service).start({
        type: "task",
        metadata: { parentSessionId: jobSession },
        run: Deferred.await(release).pipe(Effect.as("")),
      })
      expect(
        yield* control.changeDirectory({ sessionID: jobSession, expectedSource: source, destination: source }),
      ).toMatchObject({ type: "noop" })
      yield* Deferred.succeed(release, undefined)
    }),
  )

  it.instance("returns destination and source refusal categories before persistence", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const source = AbsolutePath.make(test.directory)
      const sessionID = SessionSchema.ID.make("ses_directory_refusals")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "refusals",
          directory: source,
          title: "refusals",
          version: "test",
        })
        .run()
      const control = yield* SessionControl.Service
      const missing = AbsolutePath.make(path.join(test.directory, "missing"))
      expect(yield* control.changeDirectory({ sessionID, expectedSource: source, destination: missing })).toEqual({
        type: "refused",
        reason: "missing_directory",
      })
      const file = AbsolutePath.make(path.join(test.directory, "file"))
      yield* Effect.promise(() => fs.writeFile(file, "file"))
      expect(yield* control.changeDirectory({ sessionID, expectedSource: source, destination: file })).toEqual({
        type: "refused",
        reason: "not_directory",
      })
      const nongit = AbsolutePath.make(path.join(test.directory, "nongit"))
      yield* Effect.promise(() => fs.mkdir(nongit))
      expect(yield* control.changeDirectory({ sessionID, expectedSource: source, destination: nongit })).toEqual({
        type: "refused",
        reason: "not_git",
      })
      expect(
        yield* control.changeDirectory({
          sessionID,
          expectedSource: AbsolutePath.make(path.join(test.directory, "stale")),
          destination: source,
        }),
      ).toEqual({ type: "refused", reason: "stale_source" })
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(yield* control.changeDirectory({ sessionID, expectedSource: source, destination: source })).toEqual({
        type: "refused",
        reason: "not_found",
      })
    }),
  )

  it.instance(
    "refuses origin-less and mismatched unregistered Git destinations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { db } = yield* Database.Service
        const source = AbsolutePath.make(test.directory)
        const sessionID = SessionSchema.ID.make("ses_directory_origin_refusals")
        yield* Effect.promise(() => $`git remote add origin git@github.com:owner/project.git`.cwd(source).quiet())
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
          .onConflictDoNothing()
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "origin-refusals",
            directory: source,
            title: "origin-refusals",
            version: "test",
          })
          .run()
        const root = path.join(test.directory, "origin-refusal-destination")
        const destination = AbsolutePath.make(path.join(root, "nested"))
        yield* Effect.promise(() => fs.mkdir(destination, { recursive: true }))
        yield* Effect.promise(() => $`git init`.cwd(root).quiet())
        const control = yield* SessionControl.Service
        expect(yield* control.changeDirectory({ sessionID, expectedSource: source, destination })).toEqual({
          type: "refused",
          reason: "origin_missing",
        })
        yield* Effect.promise(() => $`git remote add origin https://github.com/other/project.git`.cwd(root).quiet())
        expect(yield* control.changeDirectory({ sessionID, expectedSource: source, destination })).toEqual({
          type: "refused",
          reason: "origin_mismatch",
        })
        expect(yield* (yield* SessionStore.Service).get(sessionID)).toMatchObject({ location: { directory: source } })
      }),
    { git: true },
  )

  race.instance(
    "rejects a legacy move while directory control holds the session lease",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { db } = yield* Database.Service
        const project = yield* Project.Service
        const source = AbsolutePath.make(test.directory)
        const projectID = (yield* project.resolve(source)).id
        const sessionID = SessionSchema.ID.make("ses_directory_legacy_race")
        const root = AbsolutePath.make(path.join(test.directory, "registered"))
        const destination = AbsolutePath.make(path.join(root, "nested"))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let blocked = false
        beforeSnapshot = () => {
          if (blocked) return Effect.void
          blocked = true
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            beforeSnapshot = undefined
          }),
        )
        yield* Effect.promise(() => fs.mkdir(destination, { recursive: true }))
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: source, sandboxes: [] })
          .onConflictDoNothing()
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "legacy-race",
            directory: source,
            title: "legacy-race",
            version: "test",
          })
          .run()
        yield* (yield* ProjectDirectories.Service).create({ projectID, directory: root })
        const control = yield* SessionControl.Service
        const directoryChange = yield* control
          .changeDirectory({ sessionID, expectedSource: source, destination })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const legacyMove = yield* (yield* MoveSession.Service)
          .moveSession({ sessionID, destination: { directory: source } })
          .pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.yieldNow
        expect(yield* (yield* SessionStore.Service).get(sessionID)).toMatchObject({ location: { directory: source } })
        expect(yield* Fiber.join(legacyMove)).toMatchObject({ _tag: "Failure" })
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(directoryChange)).toMatchObject({
          type: "completed",
          session: { location: { directory: destination } },
        })
        expect(yield* (yield* SessionStore.Service).get(sessionID)).toMatchObject({
          location: { directory: destination },
        })
      }),
    { git: true },
  )

  race.instance(
    "returns precommit failure when deletion wins after the directory-control lease",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { db } = yield* Database.Service
        const source = AbsolutePath.make(test.directory)
        const sessionID = SessionSchema.ID.make("ses_directory_deletion_race")
        const root = AbsolutePath.make(path.join(test.directory, "registered"))
        const destination = AbsolutePath.make(path.join(root, "nested"))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        beforeSnapshot = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            beforeSnapshot = undefined
          }),
        )
        yield* Effect.promise(() => fs.mkdir(destination, { recursive: true }))
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
          .onConflictDoNothing()
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "deletion-race",
            directory: source,
            title: "deletion-race",
            version: "test",
          })
          .run()
        yield* (yield* ProjectDirectories.Service).create({ projectID: Project.ID.global, directory: root })
        const changing = yield* (yield* SessionControl.Service)
          .changeDirectory({ sessionID, expectedSource: source, destination })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(changing)).toEqual({ type: "precommit_failed" })
        expect(yield* (yield* SessionStore.Service).get(sessionID)).toBeUndefined()
      }),
    { git: true },
  )

  race.instance(
    "concurrently registers one matching origin root exactly once",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { db } = yield* Database.Service
        const source = AbsolutePath.make(test.directory)
        const root = AbsolutePath.make(`${test.directory}-directory-registration-race`)
        const destination = AbsolutePath.make(path.join(root, "nested"))
        const project = yield* Project.Service
        const projectID = (yield* project.resolve(source)).id
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let waiting = 0
        beforeSnapshot = () => {
          waiting += 1
          return (waiting === 2 ? Deferred.succeed(entered, undefined) : Effect.void).pipe(
            Effect.andThen(Deferred.await(entered)),
            Effect.andThen(Deferred.await(release)),
          )
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            beforeSnapshot = undefined
          }),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
        yield* Effect.promise(() => $`git remote add origin git@github.com:owner/project.git`.cwd(source).quiet())
        yield* Effect.promise(() => $`git worktree add --detach ${root} HEAD`.cwd(source).quiet())
        yield* Effect.promise(() => fs.mkdir(destination))
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: source, sandboxes: [] })
          .onConflictDoNothing()
          .run()
        const first = SessionSchema.ID.make("ses_directory_registration_first")
        const second = SessionSchema.ID.make("ses_directory_registration_second")
        yield* db
          .insert(SessionTable)
          .values(
            [first, second].map((id) => ({
              id,
              project_id: projectID,
              slug: id,
              directory: source,
              title: id,
              version: "test",
            })),
          )
          .run()
        const control = yield* SessionControl.Service
        const one = yield* control
          .changeDirectory({ sessionID: first, expectedSource: source, destination })
          .pipe(Effect.forkScoped)
        const two = yield* control
          .changeDirectory({ sessionID: second, expectedSource: source, destination })
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(one)).toMatchObject({
          type: "completed",
          session: { location: { directory: destination } },
        })
        expect(yield* Fiber.join(two)).toMatchObject({
          type: "completed",
          session: { location: { directory: destination } },
        })
        expect(
          (yield* (yield* ProjectDirectories.Service).list(projectID)).filter((item) => item.directory === root),
        ).toEqual([{ directory: root, strategy: undefined }])
      }),
    { git: true },
  )

  it.instance("accepts an existing registered non-Git directory and preserves the exact nested destination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_directory_registered")
      const source = AbsolutePath.make(test.directory)
      const root = AbsolutePath.make(path.join(test.directory, "registered"))
      const destination = AbsolutePath.make(path.join(root, "nested"))
      yield* Effect.promise(() => fs.mkdir(destination, { recursive: true }))
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "registered",
          directory: source,
          title: "registered",
          version: "test",
        })
        .run()
      yield* (yield* ProjectDirectories.Service).create({ projectID: Project.ID.global, directory: root })

      const result = yield* (yield* SessionControl.Service).changeDirectory({
        sessionID,
        expectedSource: source,
        destination,
      })

      expect(result.type).toBe("completed")
      if (result.type === "completed") expect(result.session.location.directory).toBe(destination)
    }),
  )

  it.instance("refuses active work before a registered destination is persisted", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_directory_blocked")
      const source = AbsolutePath.make(test.directory)
      const destination = AbsolutePath.make(path.join(test.directory, "registered-blocked"))
      yield* Effect.promise(() => fs.mkdir(destination))
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "blocked",
          directory: source,
          title: "blocked",
          version: "test",
        })
        .run()
      yield* (yield* ProjectDirectories.Service).create({ projectID: Project.ID.global, directory: destination })
      yield* (yield* SessionStatus.Service).set(sessionID, { type: "busy" })

      const result = yield* (yield* SessionControl.Service).changeDirectory({
        sessionID,
        expectedSource: source,
        destination,
      })

      expect(result).toEqual({ type: "refused", reason: "blocked" })
      expect(yield* (yield* SessionStore.Service).get(sessionID)).toMatchObject({ location: { directory: source } })
    }),
  )

  it.instance(
    "registers a matching-origin worktree without changing either worktree's files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { db } = yield* Database.Service
        const sessionID = SessionSchema.ID.make("ses_directory_origin")
        const source = AbsolutePath.make(test.directory)
        const root = AbsolutePath.make(`${test.directory}-directory-control-destination`)
        const destination = AbsolutePath.make(path.join(root, "nested"))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(root, { recursive: true, force: true })))
        yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "initial\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(source, ".gitignore"), "ignored.txt\n"))
        yield* Effect.promise(() => $`git add tracked.txt .gitignore`.cwd(source).quiet())
        yield* Effect.promise(() => $`git commit -m initial`.cwd(source).quiet())
        yield* Effect.promise(() => $`git remote add origin git@github.com:owner/project.git`.cwd(source).quiet())
        yield* Effect.promise(() => $`git worktree add --detach ${root} HEAD`.cwd(source).quiet())
        yield* Effect.promise(() => fs.mkdir(destination))
        yield* Effect.promise(() => fs.writeFile(path.join(source, "tracked.txt"), "source staged\n"))
        yield* Effect.promise(() => $`git add tracked.txt`.cwd(source).quiet())
        yield* Effect.promise(() => fs.writeFile(path.join(source, "source-untracked.txt"), "source untracked\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(source, "ignored.txt"), "source ignored\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(root, "tracked.txt"), "destination staged\n"))
        yield* Effect.promise(() => $`git add tracked.txt`.cwd(root).quiet())
        yield* Effect.promise(() =>
          fs.writeFile(path.join(destination, "destination-untracked.txt"), "destination untracked\n"),
        )
        yield* Effect.promise(() => fs.writeFile(path.join(destination, "ignored.txt"), "destination ignored\n"))
        const bytes = yield* Effect.promise(async () => ({
          sourceTracked: await fs.readFile(path.join(source, "tracked.txt")),
          sourceUntracked: await fs.readFile(path.join(source, "source-untracked.txt")),
          sourceIgnored: await fs.readFile(path.join(source, "ignored.txt")),
          destinationTracked: await fs.readFile(path.join(root, "tracked.txt")),
          destinationUntracked: await fs.readFile(path.join(destination, "destination-untracked.txt")),
          destinationIgnored: await fs.readFile(path.join(destination, "ignored.txt")),
        }))
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: source, sandboxes: [] })
          .onConflictDoNothing()
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "origin",
            directory: source,
            title: "origin",
            version: "test",
          })
          .run()

        const result = yield* (yield* SessionControl.Service).changeDirectory({
          sessionID,
          expectedSource: source,
          destination,
        })

        expect(result.type).toBe("completed")
        if (result.type === "completed") expect(result.session.location.directory).toBe(destination)
        expect(
          yield* Effect.promise(async () => ({
            sourceTracked: await fs.readFile(path.join(source, "tracked.txt")),
            sourceUntracked: await fs.readFile(path.join(source, "source-untracked.txt")),
            sourceIgnored: await fs.readFile(path.join(source, "ignored.txt")),
            destinationTracked: await fs.readFile(path.join(root, "tracked.txt")),
            destinationUntracked: await fs.readFile(path.join(destination, "destination-untracked.txt")),
            destinationIgnored: await fs.readFile(path.join(destination, "ignored.txt")),
          })),
        ).toEqual(bytes)
        expect(yield* (yield* ProjectDirectories.Service).list(Project.ID.global)).toEqual([
          { directory: root, strategy: undefined },
        ])
      }),
    { git: true },
  )
})
