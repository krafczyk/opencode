import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { log } from "@clack/prompts"
import { Installation, ManagedUpgradeMessage } from "../../src/installation"
import { GlobalBus } from "../../src/bus/global"
import { upgrade } from "../../src/cli/upgrade"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"

afterEach(() => {
  mock.restore()
})

test("skips automatic updates for MkChad versions before updater discovery", async () => {
  const method = spyOn(Installation, "method").mockRejectedValue(new Error("method discovery should not run"))
  const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("version lookup should not run"))
  const install = spyOn(Installation, "upgrade").mockRejectedValue(new Error("package upgrade should not run"))
  const event = spyOn(GlobalBus, "emit")

  await upgrade("1.18.3-mkchad.6")

  expect(method).not.toHaveBeenCalled()
  expect(latest).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
  expect(event).not.toHaveBeenCalled()
})

test("refuses MkChad CLI upgrades with target and method before package-manager use", async () => {
  const method = spyOn(Installation, "method").mockRejectedValue(new Error("method discovery should not run"))
  const latest = spyOn(Installation, "latest").mockRejectedValue(new Error("version lookup should not run"))
  const install = spyOn(Installation, "upgrade").mockRejectedValue(new Error("package upgrade should not run"))
  const info = spyOn(log, "info").mockImplementation(() => {})

  await UpgradeCommand.handler({ target: "9.9.9", method: "npm" }, "1.18.3-mkchad.6")

  expect(method).not.toHaveBeenCalled()
  expect(latest).not.toHaveBeenCalled()
  expect(install).not.toHaveBeenCalled()
  expect(info).toHaveBeenCalledWith(ManagedUpgradeMessage)
  expect(ManagedUpgradeMessage).toContain("GitHub Releases")
  expect(ManagedUpgradeMessage).toContain("managed MkChad container")
})
