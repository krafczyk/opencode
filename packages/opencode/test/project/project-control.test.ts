import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { BackgroundJob } from "../../src/background/job"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { ProjectControl } from "../../src/project/control"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { SessionControlState } from "../../src/session/control-state"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const bootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)
const services = LayerNode.group([
  ProjectControl.node,
  Database.node,
  InstanceStore.node,
  SessionAdmission.node,
  SessionControlState.node,
  SessionStore.node,
  SessionRunState.node,
  SessionStatus.node,
  BackgroundJob.node,
  Permission.node,
  Question.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(
  AppNodeBuilder.build(services, [
    [InstanceStore.bootstrapNode, bootstrap],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const seedSession = (input: { id: string; directory: AbsolutePath; slug: string }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(input.id),
        project_id: Project.ID.global,
        slug: input.slug,
        directory: input.directory,
        title: input.slug,
        version: "test",
      })
      .run()
    return SessionSchema.ID.make(input.id)
  })

describe("ProjectControl.reload", () => {
  it.instance("reloads only the selected session's exact durable instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = AbsolutePath.make(test.directory)
      const other = AbsolutePath.make(yield* tmpdirScoped({ git: true }))
      const store = yield* InstanceStore.Service
      const control = yield* ProjectControl.Service
      const selected = yield* seedSession({
        id: "ses_project_reload_selected",
        directory,
        slug: "selected",
      })
      const sameOriginOther = yield* seedSession({
        id: "ses_project_reload_other",
        directory: other,
        slug: "other",
      })
      let bootstraps = 0

      yield* setBootstrap(
        Effect.sync(() => {
          bootstraps++
        }),
      )
      const first = yield* store.load({ directory })
      const otherFirst = yield* store.load({ directory: other })

      expect(yield* control.reload({ sessionID: selected, directory })).toEqual({ type: "completed" })
      expect(yield* store.load({ directory })).not.toBe(first)
      expect(yield* store.load({ directory: other })).toBe(otherFirst)
      expect(bootstraps).toBe(2)
      expect(yield* SessionStore.Service.use((sessions) => sessions.get(selected))).toBeDefined()
      expect(yield* SessionStore.Service.use((sessions) => sessions.get(sameOriginOther))).toBeDefined()
    }),
  )

  it.instance("refuses a stale request-selected context without reloading", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = AbsolutePath.make(test.directory)
      const other = AbsolutePath.make(yield* tmpdirScoped({ git: true }))
      const sessionID = yield* seedSession({
        id: "ses_project_reload_stale",
        directory,
        slug: "stale",
      })
      const store = yield* InstanceStore.Service
      const control = yield* ProjectControl.Service
      const first = yield* store.load({ directory })

      expect(yield* control.reload({ sessionID, directory: other })).toEqual({
        type: "refused",
        reason: "stale_context",
      })
      expect(yield* store.load({ directory })).toBe(first)
    }),
  )

  it.instance("bootstraps an uncached selected instance exactly once", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make(yield* tmpdirScoped({ git: true }))
      const sessionID = yield* seedSession({ id: "ses_project_reload_uncached", directory, slug: "uncached" })
      const control = yield* ProjectControl.Service
      let bootstraps = 0

      yield* setBootstrap(
        Effect.sync(() => {
          bootstraps++
        }),
      )
      expect(yield* control.reload({ sessionID, directory })).toEqual({ type: "completed" })
      expect(bootstraps).toBe(1)
    }),
  )

  it.instance("refuses active work and pending interaction categories without exposing their content", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = AbsolutePath.make(test.directory)
      const active = yield* seedSession({ id: "ses_project_reload_active", directory, slug: "active" })
      const permission = yield* seedSession({ id: "ses_project_reload_permission", directory, slug: "permission" })
      const question = yield* seedSession({ id: "ses_project_reload_question", directory, slug: "question" })
      const status = yield* SessionStatus.Service
      const permissions = yield* Permission.Service
      const questions = yield* Question.Service
      const control = yield* ProjectControl.Service

      yield* status.set(active, { type: "busy" })
      yield* permissions
        .ask({
          sessionID: permission,
          permission: "bash",
          patterns: ["private permission"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      yield* questions
        .ask({
          sessionID: question,
          questions: [{ question: "private question", header: "private", options: [] }],
        })
        .pipe(Effect.forkScoped)
      yield* pollWithTimeout(
        Effect.all([permissions.list(), questions.list()]).pipe(
          Effect.map(([pendingPermissions, pendingQuestions]) =>
            pendingPermissions.length === 1 && pendingQuestions.length === 1 ? true : undefined,
          ),
        ),
        "pending interactions were not registered",
      )

      expect(yield* control.reload({ sessionID: active, directory })).toEqual({ type: "refused", reason: "blocked" })
      expect(yield* control.reload({ sessionID: permission, directory })).toEqual({
        type: "refused",
        reason: "blocked",
      })
      expect(yield* control.reload({ sessionID: question, directory })).toEqual({ type: "refused", reason: "blocked" })
    }),
  )

  it.instance("refuses pending steer and queue inputs without reloading", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { db } = yield* Database.Service
      const directory = AbsolutePath.make(test.directory)
      const control = yield* ProjectControl.Service

      for (const delivery of ["steer", "queue"] as const) {
        const sessionID = yield* seedSession({
          id: `ses_project_reload_pending_${delivery}`,
          directory,
          slug: `pending-${delivery}`,
        })
        yield* db
          .insert(SessionInputTable)
          .values({
            id: SessionMessage.ID.make(`msg_project_reload_pending_${delivery}`),
            session_id: sessionID,
            prompt: Prompt.make({ text: delivery }),
            delivery,
            admitted_seq: 0,
          })
          .run()

        expect(yield* control.reload({ sessionID, directory })).toEqual({ type: "refused", reason: "blocked" })
      }
    }),
  )

  it.instance("drains an earlier claim into a blocker and rejects later work under the instance fence", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = AbsolutePath.make(test.directory)
      const sessionID = yield* seedSession({ id: "ses_project_reload_handoff", directory, slug: "handoff" })
      const admission = yield* SessionAdmission.Service
      const control = yield* ProjectControl.Service
      const status = yield* SessionStatus.Service
      const claim = yield* admission.claim({ sessionID, instanceID: directory })
      const reload = yield* control.reload({ sessionID, directory }).pipe(Effect.forkScoped)

      yield* pollWithTimeout(
        admission.snapshot.pipe(
          Effect.map((snapshot) =>
            snapshot.instanceControls.some((item) => item.instanceID === directory) ? true : undefined,
          ),
        ),
        "instance fence was not acquired",
      )
      const late = yield* admission
        .claim({ sessionID: SessionSchema.ID.make("ses_project_reload_late"), instanceID: directory })
        .pipe(Effect.exit)
      expect(late._tag).toBe("Failure")
      yield* status.set(sessionID, { type: "busy" })
      yield* claim.release

      expect(yield* Fiber.join(reload)).toEqual({ type: "refused", reason: "blocked" })
    }),
  )

  it.instance("refuses a concurrent session control before dispatch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = AbsolutePath.make(test.directory)
      const sessionID = yield* seedSession({ id: "ses_project_reload_control", directory, slug: "control" })
      const admission = yield* SessionAdmission.Service
      const control = yield* ProjectControl.Service
      const release = yield* Deferred.make<void>()
      const held = yield* admission
        .withSessionControl({ sessionID, instanceID: directory }, Deferred.await(release))
        .pipe(Effect.forkScoped)

      yield* pollWithTimeout(
        admission.snapshot.pipe(
          Effect.map((snapshot) =>
            snapshot.sessionControls.some((item) => item.sessionID === sessionID) ? true : undefined,
          ),
        ),
        "session control was not acquired",
      )
      expect(yield* control.reload({ sessionID, directory })).toEqual({
        type: "refused",
        reason: "control_in_progress",
      })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(held)
    }),
  )

  it.instance("reports failed replacement bootstrap and restores instance admission", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = AbsolutePath.make(test.directory)
      const sessionID = yield* seedSession({ id: "ses_project_reload_failure", directory, slug: "failure" })
      const admission = yield* SessionAdmission.Service
      const control = yield* ProjectControl.Service

      yield* setBootstrap(Effect.die("replacement bootstrap failed"))
      expect(yield* control.reload({ sessionID, directory })).toEqual({
        type: "recovery_failed",
      })
      const claim = yield* admission.claim({ sessionID, instanceID: directory })
      yield* claim.release
    }),
  )
})
