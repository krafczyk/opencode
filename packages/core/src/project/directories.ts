export * as ProjectDirectories from "./directories"

import { and, asc, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { AbsolutePath, optional } from "../schema"
import { ProjectSchema } from "./schema"
import { ProjectDirectoryTable } from "./sql"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"

export interface Directory {
  readonly directory: AbsolutePath
  readonly strategy?: string
}

/** Stable categories for a session directory relative to its project roots. */
export type LocationClassification =
  | "primary_worktree"
  | "recognized_worktree"
  | "registered_directory"
  | "unregistered"

/** The classification and containing root when a session directory belongs to a known project location. */
export type Location =
  | { readonly type: Exclude<LocationClassification, "unregistered">; readonly root: AbsolutePath }
  | { readonly type: "unregistered" }

/** Input roots used to classify a durable session directory without filesystem access. */
export interface ClassifyInput {
  readonly directory: AbsolutePath
  readonly primary: AbsolutePath
  readonly recognized: ReadonlyArray<AbsolutePath>
  readonly registered: ReadonlyArray<AbsolutePath>
}

/**
 * Classifies a durable directory using supplied project roots only.
 * The most-specific exact-or-ancestor root wins; ties resolve primary, then recognized worktree,
 * then registered directory. This has no filesystem side effects and returns `unregistered` when
 * historical session data is outside every supplied root.
 */
export function classify(input: ClassifyInput): Location {
  const candidates = [
    { type: "primary_worktree" as const, root: input.primary, priority: 0 },
    ...input.recognized.map((root) => ({ type: "recognized_worktree" as const, root, priority: 1 })),
    ...input.registered.map((root) => ({ type: "registered_directory" as const, root, priority: 2 })),
  ].filter((candidate) => FSUtil.contains(candidate.root, input.directory))
  const match = candidates.toSorted((a, b) => b.root.length - a.root.length || a.priority - b.priority)[0]
  if (!match) return { type: "unregistered" }
  return { type: match.type, root: match.root }
}

export const CreateInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
  strategy: Schema.optional(Schema.String),
  behavior: Schema.Literals(["ignore", "replace"]).pipe(Schema.optional),
})
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
})
export type RemoveInput = typeof RemoveInput.Type

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export const ListInput = Schema.Struct({
  projectID: ProjectSchema.ID,
}).annotate({ identifier: "Project.DirectoriesInput" })
export type ListInput = typeof ListInput.Type

export const ListOutput = Schema.Array(
  Schema.Struct({
    directory: AbsolutePath,
    strategy: optional(Schema.String),
  }),
).annotate({ identifier: "Project.Directories" })
export type ListOutput = typeof ListOutput.Type

export interface Interface {
  /** Lists registered project directories, optionally within a caller-owned transaction. */
  readonly list: (projectID: ProjectSchema.ID, tx?: Transaction) => Effect.Effect<ReadonlyArray<Directory>>
  readonly get: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
  }) => Effect.Effect<Directory | undefined>
  readonly contains: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  readonly create: (input: CreateInput, tx?: Transaction) => Effect.Effect<boolean>
  readonly remove: (input: RemoveInput, tx?: Transaction) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectDirectories") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const create = Effect.fn("ProjectDirectories.create")(function* (input: CreateInput, tx?: Transaction) {
      const insert = (tx ?? db)
        .insert(ProjectDirectoryTable)
        .values({ project_id: input.projectID, directory: input.directory, strategy: input.strategy })
      const query =
        input.behavior === "replace"
          ? insert.onConflictDoUpdate({
              target: [ProjectDirectoryTable.project_id, ProjectDirectoryTable.directory],
              set: { strategy: input.strategy ?? null },
              setWhere: input.strategy
                ? or(isNull(ProjectDirectoryTable.strategy), ne(ProjectDirectoryTable.strategy, input.strategy))
                : isNotNull(ProjectDirectoryTable.strategy),
            })
          : insert.onConflictDoNothing()
      return (
        (yield* query.returning({ directory: ProjectDirectoryTable.directory }).get().pipe(Effect.orDie)) !== undefined
      )
    })

    const remove = Effect.fn("ProjectDirectories.remove")(function* (input: RemoveInput, tx?: Transaction) {
      return (
        (yield* (tx ?? db)
          .delete(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const list = Effect.fn("ProjectDirectories.list")(function* (projectID: ProjectSchema.ID, tx?: Transaction) {
      const rows = yield* (tx ?? db)
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .orderBy(desc(ProjectDirectoryTable.time_created), asc(ProjectDirectoryTable.directory))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
    })

    const contains = Effect.fn("ProjectDirectories.contains")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      return (
        (yield* db
          .select({ directory: ProjectDirectoryTable.directory })
          .from(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const get = Effect.fn("ProjectDirectories.get")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      const row = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            eq(ProjectDirectoryTable.directory, input.directory),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
    })

    return Service.of({
      list,
      get,
      contains,
      create,
      remove,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
