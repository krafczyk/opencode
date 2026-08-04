import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { canRemoveManagedDirectory, presentProjectDirectories } from "./project-presentation"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("project directory presentation", () => {
  test("keeps user-added same-project directories as independently ordered roots", () => {
    const presentation = presentProjectDirectories(
      ["/checkout/b", "/checkout/a"],
      [
        { projectID: "repo", directory: "/checkout/a", kind: "user", fallbackDirectory: "/checkout/a" },
        { projectID: "repo", directory: "/checkout/b", kind: "user", fallbackDirectory: "/checkout/a" },
      ],
    )

    expect(presentation.roots).toEqual(["/checkout/b", "/checkout/a"])
    expect(presentation.children("/checkout/a")).toEqual([])
    expect(presentation.children("/checkout/b")).toEqual([])
  })

  test("keeps unresolved and failed persisted paths selectable without managed actions", () => {
    const presentation = presentProjectDirectories(["/checkout/pending", "/checkout/failed"], [])

    expect(presentation.roots).toEqual(["/checkout/pending", "/checkout/failed"])
    expect(presentation.parent("/checkout/pending")).toBeUndefined()
    expect(canRemoveManagedDirectory(undefined)).toBe(false)
  })

  test("keeps a pending explicit add above a stale managed record", () => {
    const presentation = presentProjectDirectories(
      ["/checkout/root", "/checkout/stale"],
      [
        { projectID: "repo", directory: "/checkout/root", kind: "user", fallbackDirectory: "/checkout/root" },
        {
          projectID: "repo",
          directory: "/checkout/stale",
          kind: "managed",
          strategy: "worktree",
          sourceDirectory: "/checkout/root",
          fallbackDirectory: "/checkout/root",
        },
      ],
      ["/checkout/stale"],
    )

    expect(presentation.roots).toEqual(["/checkout/root", "/checkout/stale"])
    expect(presentation.parent("/checkout/stale")).toBeUndefined()
    expect(presentation.children("/checkout/root")).toEqual([])
    expect(canRemoveManagedDirectory(presentation.managed("/checkout/stale"))).toBe(false)
  })

  test("groups managed copies by exact persisted source without collapsing another user checkout", () => {
    const presentation = presentProjectDirectories(
      ["/checkout/a", "/checkout/b", "/work/a-copy", "/work/b-copy"],
      [
        { projectID: "repo", directory: "/checkout/a", kind: "user", fallbackDirectory: "/checkout/a" },
        { projectID: "repo", directory: "/checkout/b", kind: "user", fallbackDirectory: "/checkout/a" },
        {
          projectID: "repo",
          directory: "/work/a-copy",
          kind: "managed",
          strategy: "worktree",
          sourceDirectory: "/checkout/a",
          fallbackDirectory: "/checkout/a",
        },
        {
          projectID: "repo",
          directory: "/work/b-copy",
          kind: "managed",
          strategy: "worktree",
          sourceDirectory: "/checkout/b",
          fallbackDirectory: "/checkout/a",
        },
      ],
    )

    expect(presentation.roots).toEqual(["/checkout/a", "/checkout/b"])
    expect(presentation.children("/checkout/a").map((item) => item.directory)).toEqual(["/work/a-copy"])
    expect(presentation.children("/checkout/b").map((item) => item.directory)).toEqual(["/work/b-copy"])
    expect(canRemoveManagedDirectory(presentation.managed("/work/a-copy"))).toBe(true)
  })

  test("uses only the compatibility root for legacy managed rows", () => {
    const presentation = presentProjectDirectories(
      ["/checkout/b", "/work/legacy"],
      [
        { projectID: "repo", directory: "/checkout/b", kind: "user", fallbackDirectory: "/checkout/a" },
        {
          projectID: "repo",
          directory: "/work/legacy",
          kind: "managed",
          strategy: "worktree",
          fallbackDirectory: "/checkout/a",
        },
      ],
    )

    expect(presentation.roots).toEqual(["/checkout/b", "/checkout/a"])
    expect(presentation.children("/checkout/a").map((item) => item.directory)).toEqual(["/work/legacy"])
    expect(presentation.children("/checkout/b")).toEqual([])
  })

  test("does not authorize removal for strategy-free managed records", () => {
    expect(canRemoveManagedDirectory({ directory: "/discovered", kind: "managed" })).toBe(false)
    expect(canRemoveManagedDirectory({ directory: "/user", kind: "user", strategy: "worktree" })).toBe(false)
  })
})
