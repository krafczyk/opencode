import { expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildHomeSessionRecords, sessionSearchKey } from "./home-sessions-helpers"

test("keeps same-project session search keys scoped to their exact directories", () => {
  expect(sessionSearchKey({ directory: "/checkout/a", id: "ses_1" })).toBe("/checkout/a:ses_1")
  expect(sessionSearchKey({ directory: "/checkout/b", id: "ses_1" })).toBe("/checkout/b:ses_1")
})

test("lists only the selected directory's sessions when checkouts share a project", () => {
  const projects = () => [
    { id: "project", worktree: "/checkout/a", expanded: true },
    { id: "project", worktree: "/checkout/b", expanded: true },
  ]
  const sessions = () => [
    { id: "a", directory: "/checkout/a", projectID: "project", time: { created: 1 } },
    { id: "b", directory: "/checkout/b", projectID: "project", time: { created: 2 } },
  ] as unknown as Session[]

  expect(
    buildHomeSessionRecords({
      sessions,
      projectDirectories: () => ["/checkout/a"],
      projects,
      projectByID: () => new Map([["project", projects()[0]!]]),
    }).map((record) => record.session.id),
  ).toEqual(["a"])
  expect(
    buildHomeSessionRecords({
      sessions,
      projectDirectories: () => ["/checkout/b"],
      projects,
      projectByID: () => new Map([["project", projects()[0]!]]),
    }).map((record) => record.session.id),
  ).toEqual(["b"])
})

test("keeps managed-copy history separate from its source root", () => {
  const projects = () => [
    {
      id: "project",
      worktree: "/checkout/a",
      expanded: true,
      managedDirectories: [{ directory: "/work/a-copy", kind: "managed" as const }],
    },
  ]
  const sessions = () => [
    { id: "source", directory: "/checkout/a", projectID: "project", time: { created: 1 } },
    { id: "copy", directory: "/work/a-copy", projectID: "project", time: { created: 2 } },
  ] as unknown as Session[]

  expect(
    buildHomeSessionRecords({
      sessions,
      projectDirectories: () => ["/work/a-copy"],
      projects,
      projectByID: () => new Map([["project", projects()[0]!]]),
    }).map((record) => record.session.id),
  ).toEqual(["copy"])
})
