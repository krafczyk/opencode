import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { showToast } from "@/utils/toast"
import type { SessionInspectionSnapshot } from "@opencode-ai/sdk/v2/client"

type Feedback =
  | "reload.refused"
  | "reload.completed"
  | "reload.recovery_failed"
  | "reload.uncertain"
  | "reload.reconciliation_failed"
  | "directory.noop"
  | "directory.refused"
  | "directory.precommit_failed"
  | "directory.completed"
  | "directory.reconciliation_failed"
  | "context.idle_complete"
  | "context.interrupted_complete"
  | "context.failed_before_reset"
  | "context.recovery_uncertain"

export function sessionControlFeedback(input: { action: "reload" | "directory" | "context"; type: string }): Feedback {
  if (input.action === "reload") return `reload.${input.type}` as Extract<Feedback, `reload.${string}`>
  if (input.action === "directory") return `directory.${input.type}` as Extract<Feedback, `directory.${string}`>
  return `context.${input.type}` as Extract<Feedback, `context.${string}`>
}

export function sessionLocationKey(value: SessionInspectionSnapshot["location"]["classification"]) {
  return `session.controls.location.${value}` as const
}

export function sessionActivityKey(value: SessionInspectionSnapshot["control"]["activity"]) {
  return `session.controls.activity.${value}` as const
}

export function DialogSessionControls() {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const { params, sessionKey } = useSessionKey()
  const ownership = createSessionOwnership(sessionKey)
  const [state, setState] = createStore({
    loading: true,
    pending: undefined as "reload" | "directory" | "context" | undefined,
    directory: "",
    inspection: undefined as SessionInspectionSnapshot | undefined,
  })

  const capture = () => {
    const sessionID = params.id
    if (!sessionID) return
    const session = sync().session.get(sessionID)
    if (!session) return
    return {
      client: sdk().client,
      directory: session.directory,
      expectedSource: session.directory,
      owner: ownership.capture(),
      scope: serverSDK().scope,
      sessionID,
      sync: sync(),
    }
  }

  const inspect = async () => {
    const request = capture()
    if (!request) return
    setState("loading", true)
    try {
      const result = await request.client.session.inspection({
        sessionID: request.sessionID,
        directory: request.directory,
      })
      if (!result.data) throw new Error("Missing session inspection")
      request.owner.run(() => {
        setState("inspection", result.data)
        setState("directory", result.data.session.directory)
      })
    } catch {
      request.owner.run(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
    } finally {
      request.owner.run(() => setState("loading", false))
    }
  }

  const refresh = async (request: NonNullable<ReturnType<typeof capture>>) => {
    try {
      await request.sync.session.sync(request.sessionID, { force: true })
      return true
    } catch {
      return false
    }
  }

  const report = (request: NonNullable<ReturnType<typeof capture>>, feedback: Feedback) => {
    request.owner.run(() => showToast({ title: language.t(`session.controls.${feedback}`) }))
  }

  const reload = async () => {
    const request = capture()
    if (!request) return
    setState("pending", "reload")
    try {
      const result = await request.client.instance.reload({
        directory: request.directory,
        projectControlGuardedReloadPayload: { sessionID: request.sessionID },
      })
      if (!result.data) throw new Error("Missing project reload outcome")
      const feedback = sessionControlFeedback({ action: "reload", type: result.data.type })
      if (result.data.type === "completed" && !(await refresh(request))) {
        report(request, "reload.reconciliation_failed")
        return
      }
      report(request, feedback)
    } catch {
      request.owner.run(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
    } finally {
      request.owner.run(() => setState("pending", undefined))
    }
  }

  const changeDirectory = async () => {
    const request = capture()
    if (!request || !state.directory.trim()) return
    setState("pending", "directory")
    try {
      const result = await request.client.session.changeDirectory({
        sessionID: request.sessionID,
        directory: request.directory,
        sessionControlChangeDirectoryPayload: {
          expectedSource: request.expectedSource,
          destination: state.directory.trim(),
        },
      })
      if (!result.data) throw new Error("Missing directory change outcome")
      const feedback = sessionControlFeedback({ action: "directory", type: result.data.type })
      if ((result.data.type === "completed" || result.data.type === "noop") && !(await refresh(request))) {
        report(request, "directory.reconciliation_failed")
        return
      }
      report(request, feedback)
      if (result.data.type === "completed" || result.data.type === "noop") void inspect()
    } catch {
      request.owner.run(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
    } finally {
      request.owner.run(() => setState("pending", undefined))
    }
  }

  const reloadContext = async () => {
    const request = capture()
    if (!request) return
    setState("pending", "context")
    try {
      const result = await request.client.session.reloadContext({
        sessionID: request.sessionID,
        directory: request.directory,
      })
      if (!result.data) throw new Error("Missing session context reload outcome")
      report(request, sessionControlFeedback({ action: "context", type: result.data.type }))
    } catch {
      request.owner.run(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
    } finally {
      request.owner.run(() => setState("pending", undefined))
    }
  }

  onMount(() => void inspect())

  return (
    <Dialog title={language.t("command.session.controls")}>
      <div class="flex max-h-[70vh] w-[min(32rem,calc(100vw-3rem))] flex-col gap-4 overflow-y-auto p-3">
        <Show when={state.loading}>
          <div class="text-13-regular text-text-weak">{language.t("common.loading")}</div>
        </Show>
        <Show when={state.inspection}>
          {(inspection) => (
            <div class="grid grid-cols-1 gap-2 text-13-regular sm:grid-cols-2">
              <div>
                <span class="text-text-weak">{language.t("session.controls.directory")}: </span>
                {inspection().session.directory}
              </div>
              <div>
                <span class="text-text-weak">{language.t("session.controls.project")}: </span>
                {inspection().project.id}
              </div>
              <div>
                <span class="text-text-weak">{language.t("session.controls.location")}: </span>
                {language.t(sessionLocationKey(inspection().location.classification))}
              </div>
              <div>
                <span class="text-text-weak">{language.t("session.controls.activity")}: </span>
                {language.t(sessionActivityKey(inspection().control.activity))}
              </div>
              <div>
                <span class="text-text-weak">{language.t("session.controls.userPrompts")}: </span>
                {inspection().counts.userPrompts}
              </div>
              <div>
                <span class="text-text-weak">{language.t("session.controls.assistantResponses")}: </span>
                {inspection().counts.completedAssistantResponses}
              </div>
            </div>
          )}
        </Show>
        <div class="flex flex-col gap-2">
          <label class="text-13-regular text-text-weak" for="session-controls-directory">
            {language.t("session.controls.destination")}
          </label>
          <input
            id="session-controls-directory"
            class="h-9 rounded-md border border-border-weak-base bg-surface-base px-3 text-13-regular text-text-base"
            value={state.directory}
            onInput={(event) => setState("directory", event.currentTarget.value)}
          />
          <Show when={state.inspection?.directories.length}>
            <div class="flex flex-wrap gap-1.5">
              {state.inspection!.directories.map((item) => (
                <Button size="small" variant="secondary" onClick={() => setState("directory", item.directory)}>
                  {item.directory}
                </Button>
              ))}
            </div>
          </Show>
        </div>
        <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="secondary" disabled={!!state.pending} onClick={() => void reload()}>
            {language.t("session.controls.reloadProject")}
          </Button>
          <Button
            variant="secondary"
            disabled={!!state.pending || !state.directory.trim()}
            onClick={() => void changeDirectory()}
          >
            {language.t("session.controls.changeDirectory")}
          </Button>
          <Button variant="secondary" disabled={!!state.pending} onClick={() => void reloadContext()}>
            {language.t("session.controls.reloadContext")}
          </Button>
          <Button variant="secondary" class="sm:ml-auto" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
