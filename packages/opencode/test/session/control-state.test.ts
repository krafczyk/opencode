import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { BackgroundJob } from "../../src/background/job"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { SessionControlState } from "../../src/session/control-state"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_control_state")
const instanceID = SessionAdmission.InstanceID.make("/control-state")
const services = LayerNode.group([
  SessionControlState.node,
  SessionAdmission.node,
  SessionRunState.node,
  SessionStatus.node,
  Permission.node,
  Question.node,
  BackgroundJob.node,
])
const idle = testEffect(AppNodeBuilder.build(services, [[SessionExecution.node, SessionExecution.noopLayer]]))
const current = testEffect(
  AppNodeBuilder.build(services, [
    [
      SessionExecution.node,
      Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.succeed(new Set([sessionID])),
          resume: () => Effect.void,
          wake: () => Effect.void,
          interrupt: () => Effect.void,
        }),
      ),
    ],
  ]),
)

const input = { sessionID, instanceID, pendingInputs: { steer: 2, queue: 1 } }

describe("SessionControlState", () => {
  idle.instance(
    "reports retrying, pending categories, control ownership, and descendant background work without bodies",
    () =>
      Effect.gen(function* () {
        const state = yield* SessionControlState.Service
        const status = yield* SessionStatus.Service
        const permission = yield* Permission.Service
        const question = yield* Question.Service
        const admission = yield* SessionAdmission.Service
        const background = yield* BackgroundJob.Service
        const blocker = yield* Deferred.make<void>()
        yield* permission
          .ask({
            sessionID,
            permission: "bash",
            patterns: ["private-pattern"],
            metadata: {},
            always: [],
            ruleset: [],
          })
          .pipe(Effect.forkScoped)
        yield* question
          .ask({
            sessionID,
            questions: [
              {
                question: "private question",
                header: "private header",
                options: [{ label: "yes", description: "private description" }],
              },
            ],
          })
          .pipe(Effect.forkScoped)
        yield* pollWithTimeout(
          Effect.all([permission.list(), question.list()]).pipe(
            Effect.map(([permissions, questions]) =>
              permissions.length === 1 && questions.length === 1 ? true : undefined,
            ),
          ),
          "pending interactions were not registered",
        )
        yield* background.start({
          type: "task",
          metadata: { parentSessionId: sessionID, private: "do not expose" },
          run: Deferred.await(blocker).pipe(Effect.as("")),
        })
        yield* status.set(sessionID, { type: "retry", attempt: 1, message: "private retry", next: 1 })

        yield* admission.withSessionControl(
          { sessionID, instanceID },
          Effect.gen(function* () {
            const snapshot = yield* state.snapshot(input)
            expect(snapshot).toEqual({
              observed: true,
              activity: "retrying",
              pendingInputs: { steer: 2, queue: 1 },
              pendingInteractions: { permission: 1, question: 1 },
              control: "session",
              backgroundJobs: 1,
            })
            expect(JSON.stringify(snapshot)).not.toContain("private")
          }),
        )
        yield* Deferred.succeed(blocker, void 0)
      }),
    { git: true },
  )

  current.instance(
    "reports current execution as active when no legacy status exists",
    () =>
      Effect.gen(function* () {
        const state = yield* SessionControlState.Service
        expect((yield* state.snapshot({ ...input, pendingInputs: { steer: 0, queue: 0 } })).activity).toBe("active")
      }),
    { git: true },
  )
})
