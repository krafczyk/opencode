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
      expect(session.at(-1)?.searchParams.get("directory")).toBe("/tmp/opencode/packages/tui")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses the exact active directory instead of a same-relative-path sibling checkout", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, session } = await mount((url) => {
      if (url.pathname === "/path") {
        return json({
          home: "",
          state: "",
          config: "",
          worktree: "/tmp/checkout-a",
          directory: "/tmp/checkout-a/packages/tui",
        })
      }
    }, tmp.path)

    try {
      expect(session.at(-1)?.searchParams.get("directory")).toBe("/tmp/checkout-a/packages/tui")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses the active checkout as the TUI history location at its repository root", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, project, session } = await mount((url) => {
      if (url.pathname === "/path") {
        return new Response(
          JSON.stringify({
            home: "",
            state: "",
            config: "",
            worktree: "/tmp/opencode",
            directory: "/tmp/opencode",
          }),
          { headers: { "content-type": "application/json" } },
        )
      }
    }, tmp.path)

    try {
      expect(project.data.project.mainDir).toBe("/tmp/opencode")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("directory")).toBe("/tmp/opencode")
    } finally {
      app.renderer.destroy()
    }
  })

  test("removes a session moved out of the active directory", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    const session = {
      id: "ses_active",
      directory: "/tmp/opencode/packages/tui",
      projectID: "proj_test",
      title: "active",
      time: { created: 1, updated: 1 },
    }

    try {
      emit({
        directory: session.directory,
        project: "proj_test",
        payload: { id: "evt_updated", type: "session.updated", properties: { info: session } },
      } as GlobalEvent)
      expect(sync.data.session.map((item) => item.id)).toEqual([session.id])

      emit({
        directory: "/tmp/opencode/packages/app",
        project: "proj_test",
        payload: {
          id: "evt_moved",
          type: "session.next.moved",
          properties: {
            sessionID: session.id,
            location: { directory: "/tmp/opencode/packages/app" },
            timestamp: 2,
          },
        },
      } as GlobalEvent)
      await wait(() => sync.data.session.length === 0)
      expect(sync.data.session).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  test("refreshes the active directory when a move event arrives at its destination", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let moved = false
    const destination = {
      id: "ses_moved",
      directory: "/tmp/opencode/packages/tui",
      projectID: "proj_test",
      title: "moved",
      time: { created: 1, updated: 2 },
    }
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname !== "/session") return
      return new Response(JSON.stringify(moved ? [destination] : []), {
        headers: { "content-type": "application/json" },
      })
    }, tmp.path)

    try {
      moved = true
      emit({
        directory: "/tmp/opencode/packages/app",
        project: "proj_test",
        payload: {
          id: "evt_moved_here",
          type: "session.next.moved",
          properties: {
            sessionID: destination.id,
            location: { directory: destination.directory },
            timestamp: destination.time.updated,
          },
        },
      } as GlobalEvent)

      await wait(() => sync.data.session.some((item) => item.id === destination.id))
      expect(sync.data.session.map((item) => item.id)).toEqual([destination.id])
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps project-wide history updated by sessions outside the active directory", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, kv, sync } = await mount(undefined, tmp.path)
    const session = {
      id: "ses_project",
      directory: "/tmp/opencode/packages/app",
      projectID: "proj_test",
      title: "project-wide",
      time: { created: 1, updated: 1 },
    }

    try {
      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      emit({
        directory: session.directory,
        project: "proj_test",
        payload: { id: "evt_project_updated", type: "session.updated", properties: { info: session } },
      } as GlobalEvent)
      expect(sync.data.session.map((item) => item.id)).toEqual([session.id])

      emit({
        directory: "/tmp/opencode/packages/other",
        project: "proj_test",
        payload: {
          id: "evt_project_moved",
          type: "session.next.moved",
          properties: {
            sessionID: session.id,
            location: { directory: "/tmp/opencode/packages/other" },
            timestamp: 2,
          },
        },
      } as GlobalEvent)
      await wait(() => sync.data.session[0]?.directory === "/tmp/opencode/packages/other")
      expect(sync.data.session[0]?.directory).toBe("/tmp/opencode/packages/other")
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores a stale refresh after a session moves out of the active directory", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let defer = false
    let resolve!: (response: Response) => void
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname !== "/session") return
      if (!defer) return json([])
      return new Promise((done) => {
        resolve = done
      })
    }, tmp.path)
    const session = {
      id: "ses_stale",
      directory: "/tmp/opencode/packages/tui",
      projectID: "proj_test",
      title: "stale",
      time: { created: 1, updated: 1 },
    }

    try {
      defer = true
      const refresh = sync.session.refresh()
      await wait(() => resolve !== undefined)
      emit({
        directory: session.directory,
        project: "proj_test",
        payload: { id: "evt_stale_updated", type: "session.updated", properties: { info: session } },
      } as GlobalEvent)
      emit({
        directory: "/tmp/opencode/packages/app",
        project: "proj_test",
        payload: {
          id: "evt_stale_moved",
          type: "session.next.moved",
          properties: {
            sessionID: session.id,
            location: { directory: "/tmp/opencode/packages/app" },
            timestamp: 2,
          },
        },
      } as GlobalEvent)
      await wait(() => sync.data.session.length === 0)
      resolve(json([session]))
      await refresh

      expect(sync.data.session).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores a stale refresh after the active directory changes", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let directory = "/tmp/opencode/packages/tui"
    let defer = false
    const pending: Array<(response: Response) => void> = []
    const { app, project, sync } = await mount((url) => {
      if (url.pathname === "/path")
        return json({ home: "", state: "", config: "", worktree: "/tmp/opencode", directory })
      if (url.pathname !== "/session") return
      if (!defer) return json([])
      return new Promise((resolve) => {
        pending.push(resolve)
      })
    }, tmp.path)
    const stale = {
      id: "ses_old_directory",
      directory: "/tmp/opencode/packages/tui",
      projectID: "proj_test",
      title: "old",
      time: { created: 1, updated: 1 },
    }
    const current = {
      id: "ses_new_directory",
      directory: "/tmp/opencode/packages/app",
      projectID: "proj_test",
      title: "new",
      time: { created: 2, updated: 2 },
    }

    try {
      defer = true
      const staleRefresh = sync.session.refresh()
      await wait(() => pending.length === 1)
      directory = current.directory
      await project.sync()
      pending[0](json([stale]))
      await staleRefresh
      expect(sync.data.session).toEqual([])

      const currentRefresh = sync.session.refresh()
      await wait(() => pending.length === 2)
      pending[1](json([current]))
      await currentRefresh

      expect(sync.data.session.map((item) => item.id)).toEqual([current.id])
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
})
