import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { BackgroundJob } from "../../src/background/job"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { SessionControlState } from "../../src/session/control-state"
import { SessionInspection } from "../../src/session/inspection"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@opencode-ai/core/git"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MessageTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { TestInstance, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const services = LayerNode.group([
  SessionInspection.node,
  SessionControlState.node,
  Database.node,
  Git.node,
  ProjectDirectories.node,
  SessionStore.node,
  SessionAdmission.node,
  SessionRunState.node,
  SessionStatus.node,
  Permission.node,
  Question.node,
  BackgroundJob.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(AppNodeBuilder.build(services, [[SessionExecution.node, SessionExecution.noopLayer]]))

const insertSession = Effect.fn("SessionInspectionTest.insertSession")(function* (
  sessionID: SessionSchema.ID,
  directory: AbsolutePath,
  primary: AbsolutePath,
) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: primary, sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory,
      title: "inspection",
      version: "test",
    })
    .run()
})

describe("SessionInspection", () => {
  it.instance(
    "returns a complete server-defined primary, worktree, and registered directory snapshot",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const primary = AbsolutePath.make(test.directory)
        const registered = AbsolutePath.make(path.join(test.directory, "registered"))
        const linked = AbsolutePath.make(`${test.directory}-inspection-linked`)
        const sessionID = SessionSchema.ID.make("ses_inspection_registered")
        yield* Effect.promise(() => fs.mkdir(registered, { recursive: true }))
        yield* Effect.promise(() => $`git worktree add --detach ${linked} HEAD`.cwd(test.directory).quiet())
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(linked, { recursive: true, force: true })).pipe(Effect.ignore),
        )
        yield* insertSession(sessionID, AbsolutePath.make(path.join(registered, "nested")), primary)
        const directories = yield* ProjectDirectories.Service
        yield* directories.create({ projectID: Project.ID.global, directory: registered })
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionInputTable)
          .values([
            {
              id: "msg_pending-steer" as never,
              session_id: sessionID,
              prompt: {} as never,
              delivery: "steer",
              admitted_seq: 1,
            },
            {
              id: "msg_pending-queue" as never,
              session_id: sessionID,
              prompt: {} as never,
              delivery: "queue",
              admitted_seq: 2,
            },
          ])
          .run()
        yield* db
          .insert(MessageTable)
          .values([
            {
              id: SessionV1.MessageID.make("msg_inspection_legacy-user"),
              session_id: sessionID,
              time_created: 1,
              data: { role: "user", time: { created: 1 } } as never,
            },
            {
              id: SessionV1.MessageID.make("msg_inspection_legacy-assistant"),
              session_id: sessionID,
              time_created: 2,
              data: { role: "assistant", time: { created: 2, completed: 3 } } as never,
            },
          ])
          .run()
        yield* db
          .insert(SessionMessageTable)
          .values([
            {
              id: SessionMessage.ID.make("msg_inspection_current-user"),
              session_id: sessionID,
              type: "user",
              seq: 1,
              time_created: 4,
              data: { text: "inspection-private-prompt", files: [], agents: [], time: { created: 4 } } as never,
            },
            {
              id: SessionMessage.ID.make("msg_inspection_current-assistant"),
              session_id: sessionID,
              type: "assistant",
              seq: 2,
              time_created: 5,
              data: {
                agent: "build",
                model: { id: "model", providerID: "provider" },
                content: [],
                time: { created: 5, completed: 6 },
              } as never,
            },
          ])
          .run()

        const inspection = yield* SessionInspection.Service
        const snapshot = yield* inspection.inspect(sessionID)
        expect(snapshot.session.directory).toBe(AbsolutePath.make(path.join(registered, "nested")))
        expect(snapshot.location).toEqual({ classification: "registered_directory", root: registered })
        expect(snapshot.project).toEqual({ id: Project.ID.global, primaryDirectory: primary })
        expect(snapshot.directories).toEqual([
          { directory: primary, classification: "primary_worktree" },
          { directory: linked, classification: "recognized_worktree" },
          { directory: registered, classification: "registered_directory" },
        ])
        expect(snapshot.counts).toEqual({ userPrompts: 2, completedAssistantResponses: 2 })
        expect(snapshot.control).toEqual({
          observed: true,
          activity: "idle",
          pendingInputs: { steer: 1, queue: 1 },
          pendingInteractions: { permission: 0, question: 0 },
          control: "none",
          backgroundJobs: 0,
        })
        expect(JSON.stringify(snapshot)).not.toContain("inspection-private-prompt")
      }),
    { git: true },
  )

  it.instance(
    "observes blockers in the durable session instance rather than the ambient request instance",
    () =>
      Effect.gen(function* () {
        const target = yield* TestInstance
        const ambient = yield* tmpdirScoped({ git: true })
        const primary = AbsolutePath.make(target.directory)
        const sessionID = SessionSchema.ID.make("ses_inspection_instance")
        yield* insertSession(sessionID, primary, primary)
        const permission = yield* Permission.Service
        const question = yield* Question.Service
        yield* permission
          .ask({
            sessionID,
            permission: "bash",
            patterns: ["target-only"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* question
          .ask({
            sessionID,
            questions: [],
          })
          .pipe(provideInstance(ambient), Effect.forkScoped)
        yield* pollWithTimeout(
          permission.list().pipe(Effect.map((items) => (items.length === 1 ? true : undefined))),
          "target permission was not registered",
        )
        yield* pollWithTimeout(
          question.list().pipe(
            provideInstance(ambient),
            Effect.map((items) => (items.length === 1 ? true : undefined)),
          ),
          "ambient question was not registered",
        )

        const inspection = yield* SessionInspection.Service
        const snapshot = yield* inspection.inspect(sessionID).pipe(provideInstance(ambient))
        expect(snapshot.control.pendingInteractions).toEqual({ permission: 1, question: 0 })
        expect(JSON.stringify(snapshot)).not.toContain("target-only")
      }),
    { git: true },
  )

  it.instance(
    "classifies nested primary, recognized worktree, and unregistered historical locations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const primary = AbsolutePath.make(test.directory)
        const linked = AbsolutePath.make(`${test.directory}-inspection-classification`)
        yield* Effect.promise(() => $`git worktree add --detach ${linked} HEAD`.cwd(test.directory).quiet())
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => fs.rm(linked, { recursive: true, force: true })).pipe(Effect.ignore),
        )
        const inspection = yield* SessionInspection.Service
        const cases = [
          [
            SessionSchema.ID.make("ses_inspection_primary"),
            AbsolutePath.make(path.join(test.directory, "nested")),
            "primary_worktree",
          ],
          [
            SessionSchema.ID.make("ses_inspection_linked"),
            AbsolutePath.make(path.join(linked, "nested")),
            "recognized_worktree",
          ],
          [
            SessionSchema.ID.make("ses_inspection_historical"),
            AbsolutePath.make("/historical/session"),
            "unregistered",
          ],
        ] as const
        for (const [sessionID, directory, classification] of cases) {
          yield* insertSession(sessionID, directory, primary)
          expect((yield* inspection.inspect(sessionID)).location.classification).toBe(classification)
        }
      }),
    { git: true },
  )

  it.instance(
    "returns a typed not-found failure for a deleted session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessionID = SessionSchema.ID.make("ses_inspection_deleted")
        yield* insertSession(sessionID, AbsolutePath.make(test.directory), AbsolutePath.make(test.directory))
        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
        const inspection = yield* SessionInspection.Service
        expect(yield* inspection.inspect(sessionID).pipe(Effect.flip)).toMatchObject({
          _tag: "SessionInspection.NotFoundError",
          sessionID,
        })
      }),
    { git: true },
  )
})
