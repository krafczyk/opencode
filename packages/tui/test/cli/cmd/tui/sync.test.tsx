/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("control reconciliation refreshes the filtered list and retains the exact session outside its scope", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let lists = 0
    const session = {
      id: "ses_control_reconcile",
      title: "moved",
      time: { created: 0, updated: 0 },
      version: "1.18.18",
      directory: "/tmp/opencode/other-worktree",
    }
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/session") {
        lists += 1
        return json([])
      }
      if (url.pathname === `/session/${session.id}`) return json(session)
      if (
        [`/session/${session.id}/message`, `/session/${session.id}/todo`, `/session/${session.id}/diff`].includes(
          url.pathname,
        )
      ) {
        return json([])
      }
      return undefined
    }, tmp.path)

    try {
      await sync.session.reconcile(session.id)

      expect(lists).toBeGreaterThan(1)
      expect(sync.session.get(session.id)).toMatchObject({ directory: session.directory })
    } finally {
      app.renderer.destroy()
    }
  })

  test("forced reconciliation follows an older in-flight hydration with an authoritative read", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_control_race"
    let gets = 0
    let release: (() => void) | undefined
    const first = new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          json({
            id: sessionID,
            title: "source",
            time: { created: 0, updated: 0 },
            version: "1.18.18",
            directory: "/tmp/opencode/source",
          }),
        )
    })
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        gets += 1
        if (gets === 1) return first
        return json({
          id: sessionID,
          title: "destination",
          time: { created: 0, updated: 0 },
          version: "1.18.18",
          directory: "/tmp/opencode/destination",
        })
      }
      if ([`/session/${sessionID}/message`, `/session/${sessionID}/todo`, `/session/${sessionID}/diff`].includes(url.pathname)) {
        return json([])
      }
      return undefined
    }, tmp.path)

    try {
      const ordinary = sync.session.sync(sessionID)
      await wait(() => gets === 1)
      const forced = sync.session.reconcile(sessionID)
      release!()

      await ordinary
      await expect(forced).resolves.toMatchObject({ directory: "/tmp/opencode/destination" })
      expect(gets).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })
})
