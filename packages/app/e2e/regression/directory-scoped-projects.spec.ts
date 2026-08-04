import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const directoryA = "/checkouts/a"
const directoryB = "/checkouts/b"
const projectID = "proj_directory_scoped"

test("keeps same-project user directories independently selectable after reload", async ({ page }) => {
  const registrations: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/project/directories/current") registrations.push(request.url())
  })
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory: directoryA,
    project: {
      id: projectID,
      worktree: directoryA,
      vcs: "git",
      time: { created: 1, updated: 1 },
      sandboxes: ["/legacy/ignored-copy"],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route(`**/project/${projectID}/directories**`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { directory: directoryA, kind: "user" },
        { directory: directoryB, kind: "user" },
        { directory: "/managed/a-copy", kind: "managed", strategy: "worktree", sourceDirectory: directoryA },
      ]),
    }),
  )
  await page.addInitScript(
    ({ directoryA, directoryB }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: directoryA, expanded: true },
              { worktree: directoryB, expanded: true },
            ],
          },
          lastProject: { local: directoryB },
        }),
      )
    },
    { directoryA, directoryB },
  )

  await page.goto("/")
  const rows = page.locator('[data-component="home-project-row"]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("a")
  await expect(rows.nth(1)).toContainText("b")
  await rows.nth(1).click()
  await expect(rows.nth(1)).toHaveAttribute("data-selected", "")

  await page.reload()
  await expect(page.locator('[data-component="home-project-row"]')).toHaveCount(2)
  expect(registrations).toEqual([])
})
