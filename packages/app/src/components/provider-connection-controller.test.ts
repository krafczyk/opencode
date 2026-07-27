import { describe, expect, test, vi } from "bun:test"
import { createRoot } from "solid-js"
import {
  createProviderConnectionWorkflowController,
  type ProviderConnectMethod,
} from "./provider-connection-controller"

const authorization = {
  attemptID: "attempt-1",
  url: "https://example.com/auth",
  instructions: "Code: ABCD",
  mode: "auto" as const,
  time: { created: 0, expires: 1 },
}

function services(options: {
  methods: readonly ProviderConnectMethod[]
  status?: () => Promise<{ status: "pending" | "complete" }>
  refresh?: () => void
  finish?: () => void
}) {
  return {
    connection: {
      key: async () => undefined,
      oauth: async () => authorization,
      status: options.status ?? (async () => ({ status: "pending" as const })),
      complete: async () => undefined,
    },
    provider: { refresh: async () => options.refresh?.() },
    completion: { finish: options.finish ?? (() => undefined) },
  }
}

function create(options: Parameters<typeof services>[0]) {
  return createRoot((dispose) => ({
    dispose,
    controller: createProviderConnectionWorkflowController({
      provider: "example",
      directory: () => "/project",
      requestFailed: () => "Request failed",
      invalidCode: () => "Invalid code",
      loading: () => false,
      methods: () => [...options.methods],
      services: services(options),
      pollInterval: 100,
    }),
  }))
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("provider connection controller", () => {
  test("moves prompted OAuth methods through prompt and authorization states", async () => {
    const owned = create({
      methods: [
        {
          id: "oauth",
          type: "oauth",
          label: "OAuth",
          prompts: [{ type: "text", key: "account", message: "Account" }],
        },
      ],
    })

    await owned.controller.auth.select(0)
    expect(owned.controller.auth.state()).toBe("prompt")

    await owned.controller.auth.select(0, { account: "team" })
    expect(owned.controller.auth.state()).toBe("complete")
    expect(owned.controller.data.authorization()).toEqual(authorization)
    owned.dispose()
  })

  test("polls auto OAuth independently and completes after provider refresh", async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const statuses = [{ status: "pending" as const }, { status: "complete" as const }]
      const owned = create({
        methods: [{ id: "oauth", type: "oauth", label: "OAuth" }],
        status: async () => statuses.shift() ?? { status: "complete" as const },
        refresh: () => calls.push("refresh"),
        finish: () => calls.push("finish"),
      })

      await owned.controller.auth.select(0)
      await settle()
      expect(owned.controller.data.authorization()).toEqual(authorization)
      expect(calls).toEqual([])

      vi.advanceTimersByTime(100)
      await settle()
      expect(calls).toEqual(["refresh", "finish"])
      owned.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test("cancels an owned poll timer on reset and disposal", async () => {
    vi.useFakeTimers()
    try {
      const status = vi.fn(async () => ({ status: "pending" as const }))
      const owned = create({ methods: [{ id: "oauth", type: "oauth", label: "OAuth" }], status })

      await owned.controller.auth.select(0)
      expect(status).toHaveBeenCalledTimes(1)

      owned.controller.auth.reset()
      vi.advanceTimersByTime(1_000)
      await settle()
      expect(status).toHaveBeenCalledTimes(1)

      await owned.controller.auth.select(0)
      expect(status).toHaveBeenCalledTimes(2)
      owned.dispose()
      vi.advanceTimersByTime(1_000)
      await settle()
      expect(status).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
