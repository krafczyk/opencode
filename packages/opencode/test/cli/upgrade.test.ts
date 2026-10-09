import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { log } from "@clack/prompts"
import { Installation, ManagedUpgradeMessage } from "../../src/installation"
import { GlobalBus } from "../../src/bus/global"
import { upgrade } from "../../src/cli/upgrade"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

afterEach(() => {
  mock.restore()
})

test.each(["1.18.3-mkchad.6", "1.18.35-mkchad.1"])(
  "skips automatic updates for %s before updater discovery",
  async (version) => {
    const method = spyOn(Installation, "method").mockRejectedValue(new Error("method discovery should not run"))
    const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("version lookup should not run"))
    const install = spyOn(Installation, "upgrade").mockRejectedValue(new Error("package upgrade should not run"))
    const event = spyOn(GlobalBus, "emit")

    await upgrade(version)

    expect(method).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
  },
)

test.each(["1.18.3-mkchad.6", "1.18.35-mkchad.1"])(
  "refuses %s CLI upgrades with target and method before package-manager use",
  async (version) => {
    const method = spyOn(Installation, "method").mockRejectedValue(new Error("method discovery should not run"))
    const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("version lookup should not run"))
    const install = spyOn(Installation, "upgrade").mockRejectedValue(new Error("package upgrade should not run"))
    const info = spyOn(log, "info").mockImplementation(() => {})

    await UpgradeCommand.handler({ target: "9.9.9", method: "npm" }, version)

    expect(method).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(ManagedUpgradeMessage)
    expect(ManagedUpgradeMessage).toContain("GitHub Releases")
    expect(ManagedUpgradeMessage).toContain("managed MkChad container")
  },
)
