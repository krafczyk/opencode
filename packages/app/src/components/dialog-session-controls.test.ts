import { describe, expect, test } from "bun:test"
import {
  runReconciledControl,
  sessionActivityKey,
  sessionControlFeedback,
  sessionLocationKey,
} from "./dialog-session-controls"

type ControlOutcome = { type: "completed" } | { type: "refused" }

describe("session control feedback", () => {
  test("keeps typed server outcomes distinct", () => {
    expect(sessionControlFeedback({ action: "reload", type: "refused" })).toBe("reload.refused")
    expect(sessionControlFeedback({ action: "reload", type: "recovery_failed" })).toBe("reload.recovery_failed")
    expect(sessionControlFeedback({ action: "directory", type: "noop" })).toBe("directory.noop")
    expect(sessionControlFeedback({ action: "directory", type: "precommit_failed" })).toBe("directory.precommit_failed")
    expect(sessionControlFeedback({ action: "context", type: "interrupted_complete" })).toBe(
      "context.interrupted_complete",
    )
    expect(sessionControlFeedback({ action: "context", type: "recovery_uncertain" })).toBe("context.recovery_uncertain")
  })

  test("maps server inspection vocabulary to localized value keys", () => {
    expect(sessionLocationKey("primary_worktree")).toBe("session.controls.location.primary_worktree")
    expect(sessionLocationKey("recognized_worktree")).toBe("session.controls.location.recognized_worktree")
    expect(sessionLocationKey("registered_directory")).toBe("session.controls.location.registered_directory")
    expect(sessionLocationKey("unregistered")).toBe("session.controls.location.unregistered")
    expect(sessionActivityKey("idle")).toBe("session.controls.activity.idle")
    expect(sessionActivityKey("active")).toBe("session.controls.activity.active")
    expect(sessionActivityKey("retrying")).toBe("session.controls.activity.retrying")
  })

  test("forces reconciliation only after successful server mutations", async () => {
    const calls: string[] = []
    const completed = await runReconciledControl({
      mutate: async () => {
        calls.push("mutate")
        return { type: "completed" as const }
      },
      reconcileWhen: (outcome) => outcome.type === "completed",
      reconcile: async () => {
        calls.push("reconcile")
      },
    })
    const refused = await runReconciledControl({
      mutate: async (): Promise<ControlOutcome> => ({ type: "refused" }),
      reconcileWhen: (outcome) => outcome.type === "completed",
      reconcile: async () => {
        calls.push("unexpected")
      },
    })

    expect(completed).toEqual({ outcome: { type: "completed" }, reconciled: true })
    expect(refused).toEqual({ outcome: { type: "refused" }, reconciled: true })
    expect(calls).toEqual(["mutate", "reconcile"])
  })

  test("reports a distinct reconciliation failure without retrying the mutation", async () => {
    let mutations = 0
    const result = await runReconciledControl({
      mutate: async () => {
        mutations += 1
        return { type: "completed" as const }
      },
      reconcileWhen: () => true,
      reconcile: async () => {
        throw new Error("stale client")
      },
    })

    expect(result).toEqual({ outcome: { type: "completed" }, reconciled: false })
    expect(mutations).toBe(1)
  })
})
