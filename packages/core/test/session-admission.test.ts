import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { SessionAdmission } from "@opencode-ai/core/session/admission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(SessionAdmission.node))

const session = SessionAdmission.SessionID.make("ses_admission")
const otherSession = SessionAdmission.SessionID.make("ses_admission_other")
const instance = SessionAdmission.InstanceID.make("/worktree/one")
const otherInstance = SessionAdmission.InstanceID.make("/worktree/two")

describe("SessionAdmission", () => {
  it.effect("drains an earlier claim before a session control runs", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const claimed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const controlled = yield* Deferred.make<void>()
      const work = yield* admission
        .withClaim(
          { sessionID: session, instanceID: instance },
          Deferred.succeed(claimed, void 0).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(claimed)
      const control = yield* admission
        .withSessionControl({ sessionID: session, instanceID: instance }, Deferred.succeed(controlled, void 0))
        .pipe(Effect.forkChild)

      expect(yield* admission.snapshot).toMatchObject({ claims: [{ sessionID: session, instanceID: instance }] })
      expect(yield* Deferred.isDone(controlled)).toBe(false)
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(work)
      yield* Fiber.join(control)
      expect(yield* Deferred.isDone(controlled)).toBe(true)
    }),
  )

  it.effect("refuses new claims while a session control owns the fence", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const control = yield* admission
        .withSessionControl(
          { sessionID: session, instanceID: instance },
          Deferred.succeed(entered, void 0).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const rejected = yield* admission
        .withClaim({ sessionID: session, instanceID: instance }, Effect.void)
        .pipe(Effect.flip)
      expect(rejected).toMatchObject({
        _tag: "SessionAdmission.ControlInProgressError",
        scope: "session",
        sessionID: session,
      })
      expect(yield* admission.snapshot).toMatchObject({ claims: [], sessionControls: [{ sessionID: session }] })
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(control)
      expect(yield* admission.snapshot).toEqual({ claims: [], sessionControls: [], instanceControls: [] })
    }),
  )

  it.effect("drains every claim before an instance control runs", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const first = yield* admission.claim({ sessionID: session, instanceID: instance })
      const second = yield* admission.claim({ sessionID: session, instanceID: instance })
      const third = yield* admission.claim({ sessionID: otherSession, instanceID: instance })
      const entered = yield* Deferred.make<void>()

      const control = yield* admission
        .withInstanceControl(instance, Deferred.succeed(entered, void 0))
        .pipe(Effect.forkChild)

      expect(yield* Deferred.isDone(entered)).toBe(false)
      yield* first.release
      yield* second.release
      expect(yield* Deferred.isDone(entered)).toBe(false)
      yield* third.release
      yield* Fiber.join(control)
      expect(yield* Deferred.isDone(entered)).toBe(true)
    }),
  )

  it.effect("instance controls drain matching claims and leave another instance available", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const claim = yield* admission.claim({ sessionID: session, instanceID: instance })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const control = yield* admission
        .withInstanceControl(instance, Deferred.succeed(entered, void 0).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkChild)

      expect(yield* Deferred.isDone(entered)).toBe(false)
      yield* claim.release
      yield* Deferred.await(entered)
      const rejected = yield* admission
        .withClaim({ sessionID: session, instanceID: instance }, Effect.void)
        .pipe(Effect.flip)
      const unrelated = yield* admission
        .withClaim({ sessionID: otherSession, instanceID: otherInstance }, Effect.void)
        .pipe(Effect.exit)
      expect(rejected).toMatchObject({
        _tag: "SessionAdmission.ControlInProgressError",
        scope: "instance",
        instanceID: instance,
      })
      expect(Exit.isSuccess(unrelated)).toBe(true)
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(control)
    }),
  )

  it.effect("returns the fence scope for session and instance control conflicts", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const control = yield* admission
        .withSessionControl(
          { sessionID: session, instanceID: instance },
          Deferred.succeed(entered, void 0).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      const instanceRejected = yield* admission.withInstanceControl(instance, Effect.void).pipe(Effect.flip)
      const duplicateRejected = yield* admission
        .withSessionControl({ sessionID: session, instanceID: instance }, Effect.void)
        .pipe(Effect.flip)
      const unrelated = yield* admission
        .withClaim({ sessionID: otherSession, instanceID: otherInstance }, Effect.void)
        .pipe(Effect.exit)
      expect(instanceRejected).toMatchObject({ _tag: "SessionAdmission.ControlInProgressError", scope: "session" })
      expect(duplicateRejected).toMatchObject({ _tag: "SessionAdmission.ControlInProgressError", scope: "session" })
      expect(Exit.isSuccess(unrelated)).toBe(true)
      yield* Deferred.succeed(release, void 0)
      yield* Fiber.join(control)

      const instanceEntered = yield* Deferred.make<void>()
      const instanceRelease = yield* Deferred.make<void>()
      const instanceControl = yield* admission
        .withInstanceControl(
          instance,
          Deferred.succeed(instanceEntered, void 0).pipe(Effect.andThen(Deferred.await(instanceRelease))),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(instanceEntered)
      const sessionRejected = yield* admission
        .withSessionControl({ sessionID: session, instanceID: instance }, Effect.void)
        .pipe(Effect.flip)
      expect(sessionRejected).toMatchObject({ _tag: "SessionAdmission.ControlInProgressError", scope: "instance" })
      yield* Deferred.succeed(instanceRelease, void 0)
      yield* Fiber.join(instanceControl)
    }),
  )

  it.effect("releases a claim exactly once when concurrent callers release it", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const claim = yield* admission.claim({ sessionID: session, instanceID: instance })

      yield* Effect.all([claim.release, claim.release], { concurrency: "unbounded" })
      yield* admission.withSessionControl({ sessionID: session, instanceID: instance }, Effect.void)
      expect(yield* admission.snapshot).toEqual({ claims: [], sessionControls: [], instanceControls: [] })
    }),
  )

  it.effect("releases control fences after typed failure and defects", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const target = { sessionID: session, instanceID: instance }

      const typed = yield* admission.withSessionControl(target, Effect.fail("expected")).pipe(Effect.exit)
      expect(Exit.isFailure(typed)).toBe(true)
      yield* admission.withClaim(target, Effect.void)

      const defect = yield* admission.withSessionControl(target, Effect.die("defect")).pipe(Effect.exit)
      expect(Exit.isFailure(defect)).toBe(true)
      yield* admission.withClaim(target, Effect.void)
    }),
  )

  it.effect("releases a fence when its scope is interrupted", () =>
    Effect.gen(function* () {
      const admission = yield* SessionAdmission.Service
      const entered = yield* Deferred.make<void>()
      const control = yield* admission
        .withSessionControl(
          { sessionID: session, instanceID: instance },
          Deferred.succeed(entered, void 0).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(entered)
      yield* Fiber.interrupt(control)
      yield* admission.withClaim({ sessionID: session, instanceID: instance }, Effect.void)
      expect(yield* admission.snapshot).toEqual({ claims: [], sessionControls: [], instanceControls: [] })
    }),
  )
})
