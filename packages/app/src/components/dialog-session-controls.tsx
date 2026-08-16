import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Show, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { showToast } from "@/utils/toast"
import { legacySessionHref } from "@/utils/session-route"
import type {
  ProjectControlGuardedReloadOutcome,
  SessionControlChangeDirectoryOutcome,
  SessionControlReloadContextOutcome,
  SessionInspectionSnapshot,
} from "@opencode-ai/sdk/v2/client"

const feedback = {
  reload: {
    refused: "reload.refused",
    completed: "reload.completed",
    recovery_failed: "reload.recovery_failed",
    uncertain: "reload.uncertain",
  },
  directory: {
    noop: "directory.noop",
    refused: "directory.refused",
    completed: "directory.completed",
    precommit_failed: "directory.precommit_failed",
  },
  context: {
    idle_complete: "context.idle_complete",
    interrupted_complete: "context.interrupted_complete",
    failed_before_reset: "context.failed_before_reset",
    recovery_uncertain: "context.recovery_uncertain",
  },
} as const

type Feedback =
  | (typeof feedback.reload)[keyof typeof feedback.reload]
  | (typeof feedback.directory)[keyof typeof feedback.directory]
  | (typeof feedback.context)[keyof typeof feedback.context]
  | "reload.reconciliation_failed"
  | "directory.reconciliation_failed"
  | "context.reconciliation_failed"

type FeedbackInput =
  | { action: "reload"; type: ProjectControlGuardedReloadOutcome["type"] }
  | { action: "directory"; type: SessionControlChangeDirectoryOutcome["type"] }
  | { action: "context"; type: SessionControlReloadContextOutcome["type"] }

export function sessionControlFeedback(input: FeedbackInput): Feedback {
  if (input.action === "reload") return feedback.reload[input.type]
  if (input.action === "directory") return feedback.directory[input.type]
  return feedback.context[input.type]
}

export function sessionLocationKey(value: SessionInspectionSnapshot["location"]["classification"]) {
  return `session.controls.location.${value}` as const
}

export function sessionActivityKey(value: SessionInspectionSnapshot["control"]["activity"]) {
  return `session.controls.activity.${value}` as const
}

/** Runs one control mutation and, only for outcomes that changed server state, attempts exact client reconciliation. */
export async function runReconciledControl<T>(input: {
  mutate: () => Promise<T>
  reconcileWhen: (outcome: T) => boolean
  reconcile: () => Promise<void>
}) {
  const outcome = await input.mutate()
  if (!input.reconcileWhen(outcome)) return { outcome, reconciled: true }
  try {
    await input.reconcile()
    return { outcome, reconciled: true }
  } catch {
    return { outcome, reconciled: false }
  }
}

export function DialogSessionControls() {
  const dialog = useDialog()
  const navigate = useNavigate()
  const language = useLanguage()
  const sdk = useSDK()
  const sync = useSync()
  const { params, sessionKey } = useSessionKey()
  const ownership = createSessionOwnership(sessionKey)
  const [state, setState] = createStore({
    loading: true,
    pending: undefined as "reload" | "directory" | "context" | undefined,
    directory: "",
    inspection: undefined as SessionInspectionSnapshot | undefined,
  })
  let inspectionGeneration = 0

  const capture = () => {
    const sessionID = params.id
    if (!sessionID) return
    const session = sync().session.get(sessionID)
    if (!session) return
    return {
      client: sdk().client,
      directory: session.directory,
      owner: ownership.capture(),
      serverKey: params.serverKey,
      sessionID,
      sync: sync(),
    }
  }

  const inspect = async (request = capture()) => {
    if (!request) return
    const generation = ++inspectionGeneration
    setState("loading", true)
    try {
      const result = await request.client.session.inspection({
        sessionID: request.sessionID,
        directory: request.directory,
      })
      if (!result.data) throw new Error("Missing session inspection")
      if (generation !== inspectionGeneration) return
      request.owner.run(() => {
        setState("inspection", result.data)
        setState("directory", result.data.session.directory)
      })
    } catch {
      if (generation !== inspectionGeneration) return
      request.owner.run(() => showToast({ variant: "error", title: language.t("common.requestFailed") }))
    } finally {
      if (generation !== inspectionGeneration) return
      request.owner.run(() => setState("loading", false))
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
      const result = await runReconciledControl({
        mutate: async () => {
          const response = await request.client.session.reloadProject({
            sessionID: request.sessionID,
            directory: request.directory,
          })
          if (!response.data) throw new Error("Missing project reload outcome")
          return response.data
        },
        reconcileWhen: (outcome) => outcome.type === "completed",
        reconcile: () => request.sync.session.sync(request.sessionID, { force: true }),
      })
      const feedback = sessionControlFeedback({ action: "reload", type: result.outcome.type })
      if (!result.reconciled) {
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
      const result = await runReconciledControl({
        mutate: async () => {
          const response = await request.client.session.changeDirectory({
            sessionID: request.sessionID,
            directory: request.directory,
            sessionControlChangeDirectoryPayload: {
              expectedSource: request.directory,
              destination: state.directory.trim(),
            },
          })
          if (!response.data) throw new Error("Missing directory change outcome")
          return response.data
        },
        reconcileWhen: (outcome) => outcome.type === "completed" || outcome.type === "noop",
        reconcile: () => request.sync.session.sync(request.sessionID, { force: true }),
      })
      const feedback = sessionControlFeedback({ action: "directory", type: result.outcome.type })
      if (!result.reconciled) {
        report(request, "directory.reconciliation_failed")
        return
      }
      if (result.outcome.type === "completed") {
        if (params.id !== request.sessionID || params.serverKey !== request.serverKey) return
        showToast({ title: language.t(`session.controls.${feedback}`) })
        setState("pending", undefined)
        if (!request.serverKey) {
          navigate(legacySessionHref(result.outcome.session.location.directory, request.sessionID), { replace: true })
        }
        dialog.close()
        return
      }
      report(request, feedback)
      if (result.outcome.type === "noop") await inspect(request)
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
      const result = await runReconciledControl({
        mutate: async () => {
          const response = await request.client.session.reloadContext({
            sessionID: request.sessionID,
            directory: request.directory,
          })
          if (!response.data) throw new Error("Missing session context reload outcome")
          return response.data
        },
        reconcileWhen: (outcome) => outcome.type === "idle_complete" || outcome.type === "interrupted_complete",
        reconcile: () => request.sync.session.sync(request.sessionID, { force: true }),
      })
      if (!result.reconciled) {
        report(request, "context.reconciliation_failed")
        return
      }
      if (result.outcome.type === "idle_complete" || result.outcome.type === "interrupted_complete") {
        await inspect(request)
      }
      report(request, sessionControlFeedback({ action: "context", type: result.outcome.type }))
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
