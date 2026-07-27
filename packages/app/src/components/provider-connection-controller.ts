import type { IntegrationMethod, IntegrationOauthConnectOutput } from "@opencode-ai/client/promise"
import { createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"

export type ProviderConnectMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>
type Authorization = IntegrationOauthConnectOutput["data"]
type OAuthStatus = { status: "pending" | "complete" | "expired" } | { status: "failed"; message: string }

type ProviderConnectionServices = {
  integration: {
    load: (provider: string, directory?: string) => Promise<{ methods: readonly IntegrationMethod[] } | null>
  }
  connection: {
    key: (provider: string, directory: string | undefined, key: string) => Promise<unknown>
    oauth: (
      provider: string,
      directory: string | undefined,
      method: string,
      inputs: Record<string, string>,
    ) => Promise<Authorization>
    status: (provider: string, directory: string | undefined, attempt: string) => Promise<OAuthStatus>
    complete: (provider: string, directory: string | undefined, attempt: string, code: string) => Promise<unknown>
  }
  provider: { refresh: () => Promise<unknown> }
  completion: { finish: () => void }
}

export function createProviderConnectionController(options: {
  provider: string
  directory: () => string | undefined
  fallbackKeyLabel: () => string
  requestFailed: () => string
  invalidCode: () => string
  services: ProviderConnectionServices
  pollInterval?: number
}) {
  const [integration] = createResource(
    () => ({ provider: options.provider, directory: options.directory() }),
    (input) => options.services.integration.load(input.provider, input.directory),
  )
  const methods = createMemo<ProviderConnectMethod[]>(() => {
    const values = integration.latest?.methods.filter(
      (method): method is ProviderConnectMethod => method.type === "key" || method.type === "oauth",
    )
    if (values?.length) return [...values]
    return [{ type: "key", label: options.fallbackKeyLabel() }]
  })
  return createProviderConnectionWorkflowController({
    ...options,
    loading: () => integration.loading,
    methods,
  })
}

export function createProviderConnectionWorkflowController(options: {
  provider: string
  directory: () => string | undefined
  requestFailed: () => string
  invalidCode: () => string
  loading: () => boolean
  methods: () => ProviderConnectMethod[]
  services: Pick<ProviderConnectionServices, "connection" | "provider" | "completion">
  pollInterval?: number
}) {
  const [store, setStore] = createStore({
    methodIndex: undefined as number | undefined,
    authorization: undefined as Authorization | undefined,
    state: "pending" as "pending" | "complete" | "error" | "prompt" | undefined,
    error: undefined as string | undefined,
  })
  const polling = {
    generation: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    disposed: false,
  }
  const methods = options.methods
  const method = createMemo(() => (store.methodIndex === undefined ? undefined : methods().at(store.methodIndex)))

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: Authorization }
    | { type: "auth.error"; error: string }

  const dispatch = (action: Action) => {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const cancelPolling = () => {
    polling.generation++
    if (polling.timer === undefined) return
    clearTimeout(polling.timer)
    polling.timer = undefined
  }
  const finish = async () => {
    cancelPolling()
    await options.services.provider.refresh().catch(() => undefined)
    if (polling.disposed) return
    options.services.completion.finish()
  }
  const poll = async (authorization: Authorization, generation: number) => {
    const result = await options.services.connection
      .status(options.provider, options.directory(), authorization.attemptID)
      .then((status) => ({ ok: true as const, status }))
      .catch((error) => ({ ok: false as const, error }))
    if (polling.disposed || generation !== polling.generation) return
    if (!result.ok) {
      dispatch({ type: "auth.error", error: formatProviderConnectionError(result.error, options.requestFailed()) })
      return
    }
    if (result.status.status === "complete") {
      await finish()
      return
    }
    if (result.status.status === "failed") {
      dispatch({ type: "auth.error", error: result.status.message })
      return
    }
    if (result.status.status === "expired") {
      dispatch({ type: "auth.error", error: options.requestFailed() })
      return
    }
    polling.timer = setTimeout(() => void poll(authorization, generation), options.pollInterval ?? 1_000)
  }
  const select = async (index: number, inputs?: Record<string, string>) => {
    cancelPolling()
    const generation = polling.generation
    const selected = methods()[index]
    dispatch({ type: "method.select", index })
    if (selected.type !== "oauth") return
    if (selected.prompts?.length && !inputs) {
      dispatch({ type: "auth.prompt" })
      return
    }
    dispatch({ type: "auth.pending" })
    const result = await options.services.connection
      .oauth(options.provider, options.directory(), selected.id, inputs ?? {})
      .then((authorization) => ({ ok: true as const, authorization }))
      .catch((error) => ({ ok: false as const, error }))
    if (polling.disposed || generation !== polling.generation) return
    if (!result.ok) {
      dispatch({ type: "auth.error", error: formatProviderConnectionError(result.error, options.requestFailed()) })
      return
    }
    dispatch({ type: "auth.complete", authorization: result.authorization })
    if (result.authorization.mode === "auto") void poll(result.authorization, generation)
  }
  const reset = () => {
    cancelPolling()
    dispatch({ type: "method.reset" })
  }
  const connectKey = async (key: string) => {
    await options.services.connection.key(options.provider, options.directory(), key)
    await finish()
  }
  const completeCode = async (code: string) => {
    const authorization = store.authorization
    if (!authorization) return options.invalidCode()
    const result = await options.services.connection
      .complete(options.provider, options.directory(), authorization.attemptID, code)
      .then(() => ({ ok: true as const }))
      .catch((error) => ({ ok: false as const, error }))
    if (!result.ok) return formatProviderConnectionError(result.error, options.invalidCode())
    await finish()
    return undefined
  }

  let auto = false
  createEffect(() => {
    if (auto || options.loading() || methods().length !== 1) return
    auto = true
    void select(0)
  })
  onCleanup(() => {
    polling.disposed = true
    cancelPolling()
  })

  return {
    data: {
      loading: options.loading,
      methods,
      method,
      methodIndex: () => store.methodIndex,
      authorization: () => store.authorization,
    },
    auth: {
      state: () => store.state,
      error: () => store.error,
      select,
      reset,
      connectKey,
      completeCode,
    },
  }
}

export type ProviderConnectionController = ReturnType<typeof createProviderConnectionController>

export function formatProviderConnectionError(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "data" in value) {
    const data = value.data
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string" && data.message)
      return data.message
  }
  if (value && typeof value === "object" && "error" in value) {
    const nested = formatProviderConnectionError(value.error, "")
    if (nested) return nested
  }
  if (value && typeof value === "object" && "message" in value) {
    const message = value.message
    if (typeof message === "string" && message) return message
  }
  if (value instanceof Error && value.message) return value.message
  if (typeof value === "string" && value) return value
  return fallback
}
