export * as SessionAdmission from "./admission"

import { Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"

/** Identifies one durable session at the process-local admission boundary. */
export const SessionID = Schema.String.annotate({ identifier: "SessionAdmission.SessionID" })
export type SessionID = typeof SessionID.Type

/** Identifies one exact project instance directory at the process-local admission boundary. */
export const InstanceID = Schema.String.annotate({ identifier: "SessionAdmission.InstanceID" })
export type InstanceID = typeof InstanceID.Type

/** Describes the session and exact instance associated with a work admission or session control. */
export const SessionTarget = Schema.Struct({
  sessionID: SessionID,
  instanceID: InstanceID,
}).annotate({ identifier: "SessionAdmission.SessionTarget" })
export type SessionTarget = typeof SessionTarget.Type

/** Returned when a control fence prevents new work or another overlapping control. */
export class ControlInProgressError extends Schema.TaggedErrorClass<ControlInProgressError>()(
  "SessionAdmission.ControlInProgressError",
  {
    scope: Schema.Literals(["session", "instance"]),
    sessionID: Schema.optional(SessionID),
    instanceID: Schema.optional(InstanceID),
  },
) {}

/** A process-local snapshot of claims and exclusive control fences for blocker inspection. */
export interface Snapshot {
  readonly claims: ReadonlyArray<SessionTarget>
  readonly sessionControls: ReadonlyArray<SessionTarget>
  readonly instanceControls: ReadonlyArray<{ readonly instanceID: InstanceID }>
}

/** Releases one previously admitted work claim. Release is infallible, atomic, and idempotent across concurrent calls. */
export interface Claim {
  readonly release: Effect.Effect<void>
}

/**
 * Coordinates work admission and exclusive session or exact-instance controls in this process.
 * Work claims reject while their session or instance is fenced. Controls reject competing controls,
 * close new claims before waiting for earlier claims to hand work into runner-visible ownership, and
 * always release their fence when their protected effect exits.
 */
export interface Interface {
  /** Acquires a short-lived work claim before durable or model-visible work begins. */
  readonly claim: (target: SessionTarget) => Effect.Effect<Claim, ControlInProgressError>
  /** Runs work while a claim is held, releasing it in an uninterruptible finalizer. */
  readonly withClaim: <A, E, R>(
    target: SessionTarget,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ControlInProgressError, R>
  /** Fences one session, drains earlier claims, and runs an exclusive session mutation or control. */
  readonly withSessionControl: <A, E, R>(
    target: SessionTarget,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ControlInProgressError, R>
  /** Fences one exact instance, drains earlier claims, and runs an exclusive instance control. */
  readonly withInstanceControl: <A, E, R>(
    instanceID: InstanceID,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ControlInProgressError, R>
  /** Snapshots current work claims and control fences without exposing prompt or interaction content. */
  readonly snapshot: Effect.Effect<Snapshot>
}

/** Provides the process-global admission coordinator. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAdmission") {}

type ClaimEntry = SessionTarget & {
  count: number
  readonly drained: Deferred.Deferred<void>
}

const claims = new Map<SessionID, ClaimEntry>()
const sessionControls = new Map<SessionID, SessionTarget>()
const instanceControls = new Set<InstanceID>()

const controlError = (scope: "session" | "instance", target: Partial<SessionTarget>) =>
  new ControlInProgressError({ scope, sessionID: target.sessionID, instanceID: target.instanceID })

const releaseClaim = (entry: ClaimEntry) => {
  let released = false
  return Effect.sync(() => {
    if (released) return
    released = true
    entry.count--
    if (entry.count !== 0) return
    claims.delete(entry.sessionID)
    Deferred.doneUnsafe(entry.drained, Effect.void)
  })
}

const claim = Effect.fn("SessionAdmission.claim")(function* (target: SessionTarget) {
  const entry = yield* Effect.sync(() => {
    if (sessionControls.has(target.sessionID)) return { _tag: "Blocked" as const, scope: "session" as const }
    if (instanceControls.has(target.instanceID)) return { _tag: "Blocked" as const, scope: "instance" as const }
    const existing = claims.get(target.sessionID)
    if (existing) {
      existing.count++
      return { _tag: "Claimed" as const, entry: existing }
    }
    const next: ClaimEntry = { ...target, count: 1, drained: Deferred.makeUnsafe<void>() }
    claims.set(target.sessionID, next)
    return { _tag: "Claimed" as const, entry: next }
  })
  if (entry._tag === "Blocked") return yield* controlError(entry.scope, target)
  return {
    release: releaseClaim(entry.entry),
  } satisfies Claim
})

const withClaim = <A, E, R>(target: SessionTarget, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    claim(target),
    () => effect,
    (ownership) => ownership.release,
  )

const acquireSessionControl = Effect.fn("SessionAdmission.acquireSessionControl")(function* (target: SessionTarget) {
  const acquired = yield* Effect.sync(() => {
    if (sessionControls.has(target.sessionID)) return { _tag: "Blocked" as const, scope: "session" as const }
    if (instanceControls.has(target.instanceID)) return { _tag: "Blocked" as const, scope: "instance" as const }
    sessionControls.set(target.sessionID, target)
    return { _tag: "Acquired" as const, drained: claims.get(target.sessionID)?.drained }
  })
  if (acquired._tag === "Blocked") return yield* controlError(acquired.scope, target)
  return acquired
})

const withSessionControl = <A, E, R>(target: SessionTarget, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireSessionControl(target),
    (ownership) =>
      ownership.drained
        ? Deferred.await(ownership.drained).pipe(
            Effect.timeoutOption("5 seconds"),
            Effect.flatMap(
              (result): Effect.Effect<A, E | ControlInProgressError, R> =>
                Option.isNone(result) ? Effect.fail(controlError("session", target)) : effect,
            ),
          )
        : effect,
    () => Effect.sync(() => sessionControls.delete(target.sessionID)),
  )

const acquireInstanceControl = Effect.fn("SessionAdmission.acquireInstanceControl")(function* (instanceID: InstanceID) {
  const acquired = yield* Effect.sync(() => {
    if (instanceControls.has(instanceID)) return { _tag: "Blocked" as const, scope: "instance" as const }
    if (Array.from(sessionControls.values()).some((control) => control.instanceID === instanceID)) {
      return { _tag: "Blocked" as const, scope: "session" as const }
    }
    instanceControls.add(instanceID)
    return {
      _tag: "Acquired" as const,
      drained: Array.from(claims.values())
        .filter((entry) => entry.instanceID === instanceID)
        .map((entry) => entry.drained),
    }
  })
  if (acquired._tag === "Blocked") return yield* controlError(acquired.scope, { instanceID })
  return acquired.drained
})

const withInstanceControl = <A, E, R>(instanceID: InstanceID, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireInstanceControl(instanceID),
    (drained) =>
      Effect.forEach(drained, Deferred.await, { discard: true }).pipe(
        Effect.timeoutOption("5 seconds"),
        Effect.flatMap(
          (result): Effect.Effect<A, E | ControlInProgressError, R> =>
            Option.isNone(result) ? Effect.fail(controlError("instance", { instanceID })) : effect,
        ),
      ),
    () => Effect.sync(() => instanceControls.delete(instanceID)),
  )

const snapshot = Effect.sync<Snapshot>(() => ({
  claims: Array.from(claims.values()).map(({ sessionID, instanceID }) => ({ sessionID, instanceID })),
  sessionControls: Array.from(sessionControls.values()),
  instanceControls: Array.from(instanceControls).map((instanceID) => ({ instanceID })),
}))

const layer = Layer.succeed(
  Service,
  Service.of({ claim, withClaim, withSessionControl, withInstanceControl, snapshot }),
)

/** Process-global node used by Core and server service graphs. */
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
