import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { type ServerConnection } from "@/context/server"
import { useServerFormController } from "../server/server-management-controller"
import "./settings-v2.css"

export const DialogServerV2: Component<{
  mode: "add" | "edit"
  server?: ServerConnection.Http
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const form = useServerFormController({
    onSelect: () => dialog.close(),
    navigateOnAdd: false,
  })
  const [opened, setOpened] = createSignal(false)

  onMount(() => {
    if (props.mode === "add") form.start.add()
    if (props.mode === "edit" && props.server) form.start.edit(props.server)
    setOpened(true)
  })

  onCleanup(() => {
    form.reset()
  })

  createEffect(() => {
    if (!opened()) return
    if (form.state.open()) return
    dialog.close()
  })

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    form.submit()
  }

  const title = () =>
    props.mode === "add" ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")

  const submitLabel = () => {
    if (form.state.busy()) return language.t("dialog.server.add.checking")
    if (props.mode === "add") return language.t("dialog.server.add.button")
    return language.t("common.save")
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.url")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={form.state.value()}
              placeholder={language.t("dialog.server.add.placeholder")}
              invalid={!!form.state.error()}
              disabled={form.state.busy()}
              autofocus
              onInput={(event) => form.change.value(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
            <Show when={form.state.error()}>
              <span class="settings-v2-server-dialog-error">{form.state.error()}</span>
            </Show>
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={form.state.name()}
              placeholder={language.t("dialog.server.add.namePlaceholder")}
              disabled={form.state.busy()}
              onInput={(event) => form.change.name(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
          </div>
          <div class="grid w-full min-w-0 grid-cols-2 gap-4">
            <div class="flex min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.username")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={form.state.username()}
                placeholder={language.t("dialog.server.add.usernamePlaceholder")}
                disabled={form.state.busy()}
                onInput={(event) => form.change.username(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
            <div class="flex min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.password")}</label>
              <TextInputV2
                type="password"
                appearance="large"
                class="!w-full self-stretch"
                value={form.state.password()}
                placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                disabled={form.state.busy()}
                onInput={(event) => form.change.password(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={form.state.busy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={form.state.busy()} onClick={form.submit}>
          {submitLabel()}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
