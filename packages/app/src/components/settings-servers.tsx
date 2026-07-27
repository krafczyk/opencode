import { Show, type Component } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { useServerDomainController, useServerFormController } from "./server/server-management-controller"
import { ServerConnectionForm, ServerConnectionList } from "./dialog-select-server"

export const SettingsServers: Component = () => {
  const language = useLanguage()
  const domain = useServerDomainController()
  const form = useServerFormController()

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col flex-1 min-h-0 max-w-[720px]">
        <Show
          when={form.state.open()}
          fallback={
            <>
              <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
                <div class="flex flex-col gap-1 pt-6 pb-8">
                  <h2 class="text-16-medium text-text-strong">{language.t("status.popover.tab.servers")}</h2>
                </div>
              </div>
              <ServerConnectionList domain={domain} onAdd={form.start.add} onEdit={form.start.edit} />
            </>
          }
        >
          <div class="flex flex-1 min-h-0 flex-col gap-4 pt-6">
            <div class="text-16-medium text-text-strong">
              <div class="flex items-center gap-2 -ml-2">
                <IconButton
                  icon="arrow-left"
                  variant="ghost"
                  onClick={form.reset}
                  aria-label={language.t("common.goBack")}
                />
                <span>
                  {form.state.adding() ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")}
                </span>
              </div>
            </div>
            <ServerConnectionForm form={form} />
          </div>
        </Show>
      </div>
    </div>
  )
}
