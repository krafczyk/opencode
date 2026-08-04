import { describe, expect } from "bun:test"
import { $ } from "bun"
import path from "path"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect } from "effect"
import { Hash } from "@opencode-ai/core/util/hash"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectDirectoryTable, ProjectTable } from "@opencode-ai/core/project/sql"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Project } from "@/project/project"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Project.node, Database.node, CrossSpawnSpawner.node])))

function directories(projectID: ProjectV2.ID) {
  return Database.Service.use(({ db }) =>
    db
      .select()
      .from(ProjectDirectoryTable)
      .where(eq(ProjectDirectoryTable.project_id, projectID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) =>
          rows
            .map((row) => ({
              directory: row.directory,
              kind: row.kind,
              strategy: row.strategy ?? undefined,
              sourceDirectory: row.source_directory ?? undefined,
            }))
            .toSorted((a, b) => a.directory.localeCompare(b.directory)),
        ),
      ),
  )
}

describe("Project directory persistence", () => {
  it.live("stores the first opened checkout directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service

      const result = yield* project.fromDirectory(tmp)

      expect(yield* directories(result.project.id)).toEqual([
        { directory: AbsolutePath.make(tmp), kind: "user", strategy: undefined, sourceDirectory: undefined },
      ])
    }),
  )

  it.live("stores a repeatedly opened checkout directory only once", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service

      const result = yield* project.fromDirectory(tmp)
      const next = yield* project.fromDirectory(tmp)

      expect(next.project.id).toBe(result.project.id)
      expect(yield* directories(result.project.id)).toEqual([
        { directory: AbsolutePath.make(tmp), kind: "user", strategy: undefined, sourceDirectory: undefined },
      ])
    }),
  )

  it.live("stores an opened linked worktree directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service
      const main = yield* project.fromDirectory(tmp)
      const worktree = path.join(tmp, "..", path.basename(tmp) + "-project-directory-worktree")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove ${worktree}`.cwd(tmp).quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add ${worktree} -b project-directory-${Date.now()}`.cwd(tmp).quiet())

      yield* project.fromDirectory(worktree)

      expect(yield* directories(main.project.id)).toEqual(
        [
          { directory: AbsolutePath.make(tmp), kind: "user" as const, strategy: undefined, sourceDirectory: undefined },
          {
            directory: AbsolutePath.make(worktree),
            kind: "user" as const,
            strategy: undefined,
            sourceDirectory: undefined,
          },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
    }),
  )

  it.live("stores only the linked copy when first opened from an external linked worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const worktree = path.join(tmp, "..", path.basename(tmp) + "-project-directory-first-worktree")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove ${worktree}`.cwd(tmp).quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add --detach ${worktree} HEAD`.cwd(tmp).quiet())
      const project = yield* Project.Service

      const result = yield* project.fromDirectory(worktree)

      expect(yield* directories(result.project.id)).toEqual([
        { directory: AbsolutePath.make(worktree), kind: "user", strategy: undefined, sourceDirectory: undefined },
      ])
    }),
  )

  it.live("stores a separately opened clone as a secondary directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const bare = tmp + "-project-directory-bare"
      const clone = tmp + "-project-directory-clone"
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${clone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${clone}`.quiet())
      const project = yield* Project.Service
      const main = yield* project.fromDirectory(tmp)

      yield* project.fromDirectory(clone)

      expect(yield* directories(main.project.id)).toEqual(
        [
          { directory: AbsolutePath.make(tmp), kind: "user" as const, strategy: undefined, sourceDirectory: undefined },
          { directory: AbsolutePath.make(clone), kind: "user" as const, strategy: undefined, sourceDirectory: undefined },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
    }),
  )

  it.live("stores only the materialized worktree for a bare repository", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const bare = tmp + "-project-directory-bare-store.git"
      const worktree = tmp + "-project-directory-bare-worktree"
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${worktree}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktree} HEAD`.cwd(bare).quiet())
      const project = yield* Project.Service

      const result = yield* project.fromDirectory(worktree)

      expect(yield* directories(result.project.id)).toEqual([
        { directory: AbsolutePath.make(worktree), kind: "user", strategy: undefined, sourceDirectory: undefined },
      ])
    }),
  )

  it.live("records the active directory under its newly resolved project id", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service
      yield* project.fromDirectory(tmp)
      const remoteID = ProjectV2.ID.make(Hash.fast("git-remote:github.com/project-directory-test/collision"))
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: remoteID,
          worktree: AbsolutePath.make("/tmp/existing"),
          vcs: "git",
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        $`git remote add origin git@github.com:project-directory-test/collision.git`.cwd(tmp).quiet(),
      )

      yield* project.fromDirectory(tmp)

      expect(yield* directories(remoteID)).toEqual([
        { directory: AbsolutePath.make(tmp), kind: "user", strategy: undefined, sourceDirectory: undefined },
      ])
    }),
  )

  it.live("re-keys directories, sessions, workspaces, and permissions when the project id changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const project = yield* Project.Service
      const original = yield* project.fromDirectory(tmp)
      const userDirectory = AbsolutePath.make(tmp + "-user-checkout")
      const managedDirectory = AbsolutePath.make(tmp + "-managed-copy")
      const collision = AbsolutePath.make(tmp + "-classification-collision")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectDirectoryTable)
        .values([
          { project_id: original.project.id, directory: userDirectory, kind: "user" },
          {
            project_id: original.project.id,
            directory: managedDirectory,
            kind: "managed",
            strategy: "git_worktree",
            source_directory: AbsolutePath.make(tmp),
          },
          { project_id: original.project.id, directory: collision, kind: "user" },
        ])
        .run()
        .pipe(Effect.orDie)
      const remoteID = ProjectV2.ID.make(Hash.fast("git-remote:github.com/project-directory-test/migration"))
      const sessionID = SessionSchema.ID.make("ses_directory_migration")
      const workspaceID = WorkspaceV2.ID.make("wrk_directory_migration")
      const permissionID = PermissionSaved.ID.make("per_directory_migration")
      const targetPermissionID = PermissionSaved.ID.make("per_directory_migration_target")
      yield* Effect.promise(() =>
        $`git remote add origin git@github.com:project-directory-test/migration.git`.cwd(tmp).quiet(),
      )

      yield* db
        .insert(ProjectTable)
        .values({
          id: remoteID,
          worktree: AbsolutePath.make(tmp + "-remote"),
          vcs: "git",
          time_created: 1,
          time_updated: 1,
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ProjectDirectoryTable)
        .values({ project_id: remoteID, directory: collision, kind: "managed", strategy: "git_worktree" })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: original.project.id,
          slug: "directory-migration",
          directory: tmp,
          title: "Directory migration",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(WorkspaceTable)
        .values({ id: workspaceID, project_id: original.project.id, type: "local", time_used: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PermissionTable)
        .values({
          id: permissionID,
          project_id: original.project.id,
          directory: "/project/a",
          action: "bash",
          resource: "*",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PermissionTable)
        .values({
          id: targetPermissionID,
          project_id: remoteID,
          directory: "/project/b",
          action: "bash",
          resource: "*",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      yield* project.fromDirectory(tmp)

      expect(yield* directories(original.project.id)).toEqual([])
      expect(yield* directories(remoteID)).toEqual(
        [
          { directory: AbsolutePath.make(tmp), kind: "user" as const, strategy: undefined, sourceDirectory: undefined },
          { directory: userDirectory, kind: "user" as const, strategy: undefined, sourceDirectory: undefined },
          {
            directory: managedDirectory,
            kind: "managed" as const,
            strategy: "git_worktree",
            sourceDirectory: AbsolutePath.make(tmp),
          },
          { directory: collision, kind: "user" as const, strategy: undefined, sourceDirectory: undefined },
        ].toSorted((a, b) => a.directory.localeCompare(b.directory)),
      )
      expect(
        yield* db.select({ projectID: SessionTable.project_id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
      ).toEqual({ projectID: remoteID })
      expect(
        yield* db.select({ projectID: WorkspaceTable.project_id }).from(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).get(),
      ).toEqual({ projectID: remoteID })
      expect(
        yield* db
          .select({ id: PermissionTable.id, projectID: PermissionTable.project_id, directory: PermissionTable.directory })
          .from(PermissionTable)
          .where(eq(PermissionTable.action, "bash"))
          .all(),
      ).toEqual(
        [
          { id: permissionID, projectID: remoteID, directory: "/project/a" },
          { id: targetPermissionID, projectID: remoteID, directory: "/project/b" },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      )
    }),
  )
})
