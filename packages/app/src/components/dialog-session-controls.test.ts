import { describe, expect, test } from "bun:test"
import { sessionActivityKey, sessionControlFeedback, sessionLocationKey } from "./dialog-session-controls"

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
})
