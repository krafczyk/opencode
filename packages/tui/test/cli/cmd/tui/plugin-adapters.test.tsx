import { describe, expect, test } from "bun:test"
import { createTuiApiAdapters } from "../../../../src/plugin/adapters"

function adapters(input: { reconcile: (sessionID: string) => Promise<{ directory: string }> }) {
  const navigated: unknown[] = []
  const reconnected: string[] = []
  const api = createTuiApiAdapters({
    version: "1.18.18",
    tuiConfig: {} as never,
    dialog: {} as never,
    keymap: {} as never,
    kv: {} as never,
    route: {
      data: { type: "session", sessionID: "ses_control" },
      navigate(route: unknown) {
        navigated.push(route)
      },
    } as never,
    routes: {} as never,
    event: {} as never,
    sdk: {} as never,
    sync: { session: { reconcile: input.reconcile } } as never,
    editor: {
      reconnect(directory?: string) {
        if (directory) reconnected.push(directory)
      },
    } as never,
    theme: {} as never,
    toast: {} as never,
    renderer: {} as never,
    attention: {} as never,
    Slot: (() => null) as never,
  })
  return { api, navigated, reconnected }
}

describe("plugin control reconciliation", () => {
  test("repairs the selected route and editor from exact host-owned session hydration", async () => {
    const harness = adapters({ reconcile: async () => ({ directory: "/server/destination" }) })

    await expect(harness.api.session.reconcile("ses_control")).resolves.toEqual({ directory: "/server/destination" })

    expect(harness.reconnected).toEqual(["/server/destination"])
    expect(harness.navigated).toEqual([{ type: "session", sessionID: "ses_control" }])
  })

  test("falls home only when exact reconciliation fails for the selected route", async () => {
    const harness = adapters({
      reconcile: async () => {
        throw new Error("session missing")
      },
    })

    await expect(harness.api.session.reconcile("ses_control")).rejects.toThrow("session missing")

    expect(harness.reconnected).toEqual([])
    expect(harness.navigated).toEqual([{ type: "home" }])
  })
})
