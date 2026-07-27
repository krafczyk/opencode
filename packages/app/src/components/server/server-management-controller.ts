import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl, ServerConnection, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { type ServerHealth, useCheckServerHealth } from "@/utils/server-health"
import { detectServerProtocol } from "@/utils/server-protocol"
import { showToast } from "@/utils/toast"
import { createServerHealthPreview, replaceServerConnection, type ServerFormValues } from "./server-management"

const DEFAULT_USERNAME = "opencode"

type FormMode = "list" | "add" | "edit"

function showRequestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

function useDefaultServer() {
  const language = useLanguage()
  const platform = usePlatform()
  const [defaultKey, defaultKeyActions] = createResource(
    async () => {
      try {
        return (await platform.getDefaultServer?.()) ?? null
      } catch (err) {
        showRequestError(language, err)
        return null
      }
    },
    { initialValue: null },
  )

  const set = async (key: ServerConnection.Key | null) => {
    try {
      await platform.setDefaultServer?.(key)
      defaultKeyActions.mutate(key)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return {
    key: () => defaultKey.latest,
    available: createMemo(() => !!platform.getDefaultServer && !!platform.setDefaultServer),
    set,
  }
}

function useServerMutations() {
  const server = useServer()
  const tabs = useTabs()

  return {
    add: (connection: ServerConnection.Http) => server.add(connection),
    replace: (original: ServerConnection.Http, next: ServerConnection.Http) =>
      replaceServerConnection(original, next, {
        active: () => server.key,
        removeTabs: (key) => tabs.removeServer(key),
        add: (connection) => server.add(connection),
        setActive: (key) => server.setActive(key),
        remove: (key) => server.remove(key),
      }),
  }
}

export function useServerActionsController() {
  const server = useServer()
  const tabs = useTabs()
  const platform = usePlatform()
  const language = useLanguage()
  const defaults = useDefaultServer()

  const remove = async (key: ServerConnection.Key) => {
    try {
      if (key.startsWith("wsl:")) await platform.wslServers?.removeServer(key)
      tabs.removeServer(key)
      server.remove(key)
      if ((await platform.getDefaultServer?.()) === key) await defaults.set(null)
    } catch (err) {
      showRequestError(language, err)
    }
  }

  return { defaults, connection: { remove } }
}

export type ServerActionsController = ReturnType<typeof useServerActionsController>

export function useServerCollectionController() {
  const server = useServer()
  const global = useGlobal()
  const settings = useSettings()
  const actions = useServerActionsController()

  const items = createMemo(() => {
    const current = server.current
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((item) => item !== current)]
  })
  const current = createMemo<ServerConnection.Any | undefined>(() =>
    settings.general.newLayoutDesigns()
      ? undefined
      : (items().find((item) => ServerConnection.key(item) === server.key) ?? items()[0]),
  )
  const sorted = createMemo(() => {
    const raw = items()
    const list = settings.general.newLayoutDesigns()
      ? raw
      : raw.filter((item) => global.ensureServerCtx(item).sdk.protocolKind() !== "v2")
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((item, index) => [item, index] as const))
    const rank = (value?: ServerHealth) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff =
        rank(global.servers.health[ServerConnection.key(a)]) - rank(global.servers.health[ServerConnection.key(b)])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })

  return {
    collection: {
      items: sorted,
      current,
      health: () => global.servers.health,
    },
    ...actions,
  }
}

export type ServerCollectionController = ReturnType<typeof useServerCollectionController>

export function useServerDomainController(options: { onSelect?: () => void } = {}) {
  const navigate = useNavigate()
  const server = useServer()
  const global = useGlobal()
  const collection = useServerCollectionController()

  const select = async (connection: ServerConnection.Any) => {
    if (global.servers.health[ServerConnection.key(connection)]?.healthy === false) return
    options.onSelect?.()
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(connection)))
  }

  return { ...collection, selection: { select } }
}

export type ServerDomainController = ReturnType<typeof useServerDomainController>

export function useServerFormController(options: { onSelect?: () => void; navigateOnAdd?: boolean } = {}) {
  const navigate = useNavigate()
  const server = useServer()
  const global = useGlobal()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const mutations = useServerMutations()
  const checkServerHealth = useCheckServerHealth()
  const healthPreview = createServerHealthPreview(checkServerHealth)
  const [store, setStore] = createStore({
    mode: "list" as FormMode,
    originalUrl: undefined as string | undefined,
    values: { url: "", name: "", username: DEFAULT_USERNAME, password: "" },
    error: "",
    status: undefined as boolean | undefined,
  })

  onCleanup(healthPreview.cancel)

  const reset = () => {
    healthPreview.cancel()
    setStore({
      mode: "list",
      originalUrl: undefined,
      values: { url: "", name: "", username: DEFAULT_USERNAME, password: "" },
      error: "",
      status: undefined,
    })
  }
  const allServers = () => {
    if (!server.current || server.list.includes(server.current)) return server.list
    return [server.current, ...server.list]
  }
  const editing = createMemo(() =>
    allServers().find((item) => item.type === "http" && item.http.url === store.originalUrl),
  )

  const request = useMutation(() => ({
    mutationFn: async () => {
      const normalized = normalizeServerUrl(store.values.url)
      if (!normalized) {
        reset()
        return
      }

      const original = store.mode === "edit" ? editing() : undefined
      if (store.mode === "edit" && !original) return
      const name = store.values.name.trim() || undefined
      const username = store.values.username || undefined
      const password = store.values.password || undefined
      if (
        original?.type === "http" &&
        normalized === original.http.url &&
        name === original.displayName &&
        username === original.http.username &&
        password === original.http.password
      ) {
        reset()
        return
      }

      const connection: ServerConnection.Http = {
        type: "http",
        displayName: name,
        http: {
          url: normalized,
          username: store.mode === "add" && !password ? undefined : username,
          password,
        },
      }
      const result = await checkServerHealth(connection.http)
      if (!result.healthy) {
        setStore("error", language.t("dialog.server.add.error"))
        return
      }
      if (
        !settings.general.newLayoutDesigns() &&
        (await detectServerProtocol(connection.http, platform.fetch ?? globalThis.fetch)) === "v2"
      ) {
        setStore("error", language.t("dialog.server.add.error"))
        return
      }

      if (original?.type === "http") {
        if (normalized === original.http.url) mutations.add(connection)
        if (normalized !== original.http.url) mutations.replace(original, connection)
        reset()
        return
      }

      reset()
      if (options.navigateOnAdd === false) {
        mutations.add(connection)
        options.onSelect?.()
        return
      }
      mutations.add(connection)
      options.onSelect?.()
      navigate("/")
    },
  }))

  const preview = () => void healthPreview.preview(store.values, (status) => setStore("status", status))
  const change = (field: keyof ServerFormValues, value: string) => {
    if (request.isPending) return
    setStore("values", field, value)
    setStore("error", "")
    if (field !== "name") preview()
  }
  const startAdd = () => {
    reset()
    setStore("mode", "add")
  }
  const startEdit = (connection: ServerConnection.Http) => {
    reset()
    setStore({
      mode: "edit",
      originalUrl: connection.http.url,
      values: {
        url: connection.http.url,
        name: connection.displayName ?? "",
        username: connection.http.username ?? "",
        password: connection.http.password ?? "",
      },
      error: "",
      status: global.servers.health[ServerConnection.key(connection)]?.healthy,
    })
  }
  const submit = () => {
    if (store.mode === "list" || request.isPending) return
    setStore("error", "")
    request.mutate()
  }

  createEffect(() => {
    if (store.mode !== "edit") return
    if (editing()) return
    reset()
  })

  return {
    state: {
      mode: () => store.mode,
      open: () => store.mode !== "list",
      adding: () => store.mode === "add",
      busy: () => request.isPending,
      value: () => store.values.url,
      name: () => store.values.name,
      username: () => store.values.username,
      password: () => store.values.password,
      error: () => store.error,
      status: () => store.status,
    },
    change: {
      value: (value: string) => change("url", value),
      name: (value: string) => change("name", value),
      username: (value: string) => change("username", value),
      password: (value: string) => change("password", value),
    },
    start: { add: startAdd, edit: startEdit },
    reset,
    submit,
  }
}

export type ServerFormController = ReturnType<typeof useServerFormController>
