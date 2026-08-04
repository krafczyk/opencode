import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
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
  it.effect("decodes directory schemas", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListInput)({ projectID })).toEqual({ projectID })
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListOutput)([{ directory, kind: "user" }])).toEqual([
        { directory, kind: "user" },
      ])
    }),
  )

  it.effect("keeps passive discovery neutral and lets registration claim a managed directory", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service

      expect(
        yield* service.createManaged({
          projectID,
          directory,
          strategy: "git_worktree",
          sourceDirectory: AbsolutePath.make("/tmp/project-source"),
        }),
      ).toBe(true)
      expect(yield* service.create({ projectID, directory })).toBe(false)
      expect(yield* service.list(projectID)).toEqual([
        {
          directory,
          kind: "managed",
          strategy: "git_worktree",
          sourceDirectory: AbsolutePath.make("/tmp/project-source"),
        },
      ])

      expect(yield* service.register({ projectID, directory })).toBe(true)
      expect(yield* service.list(projectID)).toEqual([{ directory, kind: "user" }])
    }),
  )

  it.effect("preserves a known managed source during discovery and leaves external sources unknown", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service
      const sourceDirectory = AbsolutePath.make("/tmp/project-source")
      const external = AbsolutePath.make("/tmp/project-external")
      yield* service.createManaged({ projectID, directory, strategy: "git_worktree", sourceDirectory })

      expect(yield* service.discover({ projectID, directory, strategy: "git_worktree" })).toBe(false)
      expect(yield* service.discover({ projectID, directory: external, strategy: "git_worktree" })).toBe(true)
      expect(yield* service.list(projectID)).toEqual(
        [
          { directory: external, kind: "managed", strategy: "git_worktree" },
          { directory, kind: "managed", strategy: "git_worktree", sourceDirectory },
        ],
      )
    }),
  )

  it.effect("serializes registration before a waiting discovery transition", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service
      const discovered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const discovery = yield* Effect.gen(function* () {
        yield* Deferred.succeed(discovered, undefined)
        yield* Deferred.await(release)
        return yield* service.discover({ projectID, directory, strategy: "git_worktree" })
      }).pipe(Effect.forkScoped)

      yield* Deferred.await(discovered)
      expect(yield* service.register({ projectID, directory })).toBe(true)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(discovery)).toBe(false)
      expect(yield* service.get({ projectID, directory })).toEqual({ directory, kind: "user" })
    }),
  )
})
