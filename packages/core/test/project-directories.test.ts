import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ProjectDirectories.node])))

const projectID = Project.ID.make("project-directories")
const directory = AbsolutePath.make("/tmp/project-directories")

function setup() {
  return Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

describe("ProjectDirectories", () => {
  it.effect("classifies the most-specific containing root with stable category precedence", () =>
    Effect.sync(() => {
      const input = {
        directory: AbsolutePath.make("/projects/main/vendor/docs"),
        primary: AbsolutePath.make("/projects/main"),
        recognized: [AbsolutePath.make("/projects/main-linked")],
        registered: [AbsolutePath.make("/projects/main/vendor")],
      }

      expect(ProjectDirectories.classify(input)).toEqual({
        type: "registered_directory",
        root: AbsolutePath.make("/projects/main/vendor"),
      })
      expect(
        ProjectDirectories.classify({
          ...input,
          directory: AbsolutePath.make("/projects/main/src"),
        }),
      ).toEqual({ type: "primary_worktree", root: AbsolutePath.make("/projects/main") })
      expect(
        ProjectDirectories.classify({
          ...input,
          directory: AbsolutePath.make("/projects/main-linked/packages"),
        }),
      ).toEqual({ type: "recognized_worktree", root: AbsolutePath.make("/projects/main-linked") })
      expect(
        ProjectDirectories.classify({
          ...input,
          directory: AbsolutePath.make("/projects/unknown"),
        }),
      ).toEqual({ type: "unregistered" })
      expect(
        ProjectDirectories.classify({
          ...input,
          directory: AbsolutePath.make("/project/nested"),
          primary: AbsolutePath.make("/"),
          recognized: [],
          registered: [AbsolutePath.make("/")],
        }),
      ).toEqual({ type: "primary_worktree", root: AbsolutePath.make("/") })
      expect(
        ProjectDirectories.classify({
          ...input,
          directory: AbsolutePath.make("/projects/main-sibling/src"),
        }),
      ).toEqual({ type: "unregistered" })
      if (process.platform === "win32") {
        expect(
          ProjectDirectories.classify({
            directory: AbsolutePath.make("C:\\projects\\main-sibling\\src"),
            primary: AbsolutePath.make("C:\\projects\\main"),
            recognized: [],
            registered: [],
          }),
        ).toEqual({ type: "unregistered" })
      }
    }),
  )

  it.effect("decodes directory schemas", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListInput)({ projectID })).toEqual({ projectID })
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListOutput)([{ directory }])).toEqual([{ directory }])
    }),
  )

  it.effect("creates once and ignores conflicts", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service

      expect(yield* service.create({ projectID, directory })).toBe(true)
      expect(yield* service.create({ projectID, directory, strategy: "git_worktree" })).toBe(false)
      expect(yield* service.list(projectID)).toEqual([{ directory, strategy: undefined }])
    }),
  )

  it.effect("replaces the strategy when requested", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service
      yield* service.create({ projectID, directory, strategy: "old/strategy" })

      expect(yield* service.create({ projectID, directory, strategy: "new/strategy", behavior: "replace" })).toBe(true)
      expect(yield* service.create({ projectID, directory, strategy: "new/strategy", behavior: "replace" })).toBe(false)
      expect(yield* service.create({ projectID, directory, behavior: "replace" })).toBe(true)
      expect(yield* service.create({ projectID, directory, behavior: "replace" })).toBe(false)
      expect(yield* service.create({ projectID, directory, strategy: "new/strategy", behavior: "replace" })).toBe(true)
      expect(yield* service.list(projectID)).toEqual([{ directory, strategy: "new/strategy" }])
    }),
  )
})
