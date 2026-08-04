export * as ProjectDirectories from "./directories"

import { and, asc, desc, eq, isNotNull, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { AbsolutePath, optional } from "../schema"
import { ProjectSchema } from "./schema"
import { ProjectDirectoryTable } from "./sql"

/** A persisted directory classification returned by the Core project-directory service. */
export interface Directory {
  readonly directory: AbsolutePath
  readonly kind: "user" | "managed"
  readonly strategy?: string
  readonly sourceDirectory?: AbsolutePath
}

/** Input for passive or explicit user directory registration. */
export const CreateInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
})
export type CreateInput = typeof CreateInput.Type

/** Input for recording an OpenCode-created managed directory and its source. */
export const CreateManagedInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
  strategy: Schema.String,
  sourceDirectory: AbsolutePath,
})
export type CreateManagedInput = typeof CreateManagedInput.Type

/** Input for recording a managed directory discovered from existing Git topology. */
export const DiscoverInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
  strategy: Schema.String,
})
export type DiscoverInput = typeof DiscoverInput.Type

export const RemoveInput = Schema.Struct({
  projectID: ProjectSchema.ID,
  directory: AbsolutePath,
})
export type RemoveInput = typeof RemoveInput.Type

export const ListInput = Schema.Struct({
  projectID: ProjectSchema.ID,
}).annotate({ identifier: "Project.DirectoriesInput" })
export type ListInput = typeof ListInput.Type

export const ListOutput = Schema.Array(
  Schema.Struct({
    directory: AbsolutePath,
    kind: Schema.Literals(["user", "managed"]),
    strategy: optional(Schema.String),
    sourceDirectory: optional(AbsolutePath),
  }),
).annotate({ identifier: "Project.Directories" })
export type ListOutput = typeof ListOutput.Type

export interface Interface {
  /** Lists persisted directory classifications for one repository project. */
  readonly list: (projectID: ProjectSchema.ID) => Effect.Effect<ReadonlyArray<Directory>>
  /** Returns one persisted directory classification, or undefined when it is absent. */
  readonly get: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
  }) => Effect.Effect<Directory | undefined>
  /** Reports whether a directory row exists without changing its classification. */
  readonly contains: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  /** Runs a directory transition while excluding registration, removal, and reconciliation for that path. */
  readonly withLock: <A, E, R>(
    input: { directory: AbsolutePath },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /** Passively records a missing ordinary directory and never changes an existing row. */
  readonly create: (input: CreateInput) => Effect.Effect<boolean>
  /** Validates and records explicit user intent under one directory transition lock. */
  readonly register: <E = never, R = never>(
    input: CreateInput,
    validate?: Effect.Effect<void, E, R>,
  ) => Effect.Effect<boolean, E, R>
  /** Records a newly created managed directory with its required strategy and exact source. */
  readonly createManaged: (input: CreateManagedInput) => Effect.Effect<boolean>
  /** Records a newly discovered managed directory without changing any known row. */
  readonly discover: (input: DiscoverInput) => Effect.Effect<boolean>
  /** Deletes a directory row and returns whether a row was removed. */
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean>
  /** Rechecks a row while locked and removes it only when the supplied predicate still permits removal. */
  readonly removeIf: <E, R>(
    input: RemoveInput,
    predicate: (directory: Directory) => Effect.Effect<boolean, E, R>,
  ) => Effect.Effect<boolean, E, R>
  /** Runs managed removal under the row lock and deletes the row only after the callback succeeds. */
  readonly removeManaged: <E, R>(
    input: RemoveInput,
    remove: (directory: Directory) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<boolean, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectDirectories") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const locks = KeyedMutex.makeUnsafe<string>()
    const withLock = <A, E, R>(input: { directory: AbsolutePath }, effect: Effect.Effect<A, E, R>) =>
      locks.withLock(input.directory)(effect)
    const toDirectory = (row: {
      directory: Directory["directory"]
      kind: Directory["kind"]
      strategy: string | null
      sourceDirectory: Directory["directory"] | null
    }): Directory => ({
      directory: row.directory,
      kind: row.kind,
      strategy: row.strategy ?? undefined,
      sourceDirectory: row.sourceDirectory ?? undefined,
    })

    const create = Effect.fn("ProjectDirectories.create")(function* (input: CreateInput) {
      return yield* withLock(
        input,
        db
          .insert(ProjectDirectoryTable)
          .values({ project_id: input.projectID, directory: input.directory, kind: "user" })
          .onConflictDoNothing()
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((result) => result !== undefined),
          ),
      )
    })

    const register = Effect.fn("ProjectDirectories.register")(function* <E = never, R = never>(
      input: CreateInput,
      validate: Effect.Effect<void, E, R> = Effect.void,
    ) {
      return yield* withLock(
        input,
        validate.pipe(
          Effect.andThen(
            db
              .insert(ProjectDirectoryTable)
              .values({ project_id: input.projectID, directory: input.directory, kind: "user" })
              .onConflictDoUpdate({
                target: [ProjectDirectoryTable.project_id, ProjectDirectoryTable.directory],
                set: { kind: "user", strategy: null, source_directory: null },
                setWhere: or(
                  ne(ProjectDirectoryTable.kind, "user"),
                  isNotNull(ProjectDirectoryTable.strategy),
                  isNotNull(ProjectDirectoryTable.source_directory),
                ),
              })
              .returning({ directory: ProjectDirectoryTable.directory })
              .get()
              .pipe(
                Effect.orDie,
                Effect.map((result) => result !== undefined),
              ),
          ),
        ),
      )
    })

    const createManaged = Effect.fn("ProjectDirectories.createManaged")(function* (input: CreateManagedInput) {
      return yield* withLock(
        input,
        db
          .insert(ProjectDirectoryTable)
          .values({
            project_id: input.projectID,
            directory: input.directory,
            kind: "managed",
            strategy: input.strategy,
            source_directory: input.sourceDirectory,
          })
          .onConflictDoNothing()
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((result) => result !== undefined),
          ),
      )
    })

    const discover = Effect.fn("ProjectDirectories.discover")(function* (input: DiscoverInput) {
      return yield* withLock(
        input,
        db
          .insert(ProjectDirectoryTable)
          .values({
            project_id: input.projectID,
            directory: input.directory,
            kind: "managed",
            strategy: input.strategy,
          })
          .onConflictDoNothing()
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((result) => result !== undefined),
          ),
      )
    })

    const remove = Effect.fn("ProjectDirectories.remove")(function* (input: RemoveInput) {
      return yield* withLock(
        input,
        db
          .delete(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((result) => result !== undefined),
          ),
      )
    })

    const removeIf = <E, R>(input: RemoveInput, predicate: (directory: Directory) => Effect.Effect<boolean, E, R>) =>
      withLock(
        input,
        Effect.gen(function* () {
          const directory = yield* get(input)
          if (!directory) return false
          if (!(yield* predicate(directory))) return false
          return (
            (yield* db
              .delete(ProjectDirectoryTable)
              .where(
                and(
                  eq(ProjectDirectoryTable.project_id, input.projectID),
                  eq(ProjectDirectoryTable.directory, input.directory),
                  eq(ProjectDirectoryTable.kind, directory.kind),
                ),
              )
              .returning({ directory: ProjectDirectoryTable.directory })
              .get()
              .pipe(Effect.orDie)) !== undefined
          )
        }),
      )

    const list = Effect.fn("ProjectDirectories.list")(function* (projectID: ProjectSchema.ID) {
      const rows = yield* db
        .select({
          directory: ProjectDirectoryTable.directory,
          kind: ProjectDirectoryTable.kind,
          strategy: ProjectDirectoryTable.strategy,
          sourceDirectory: ProjectDirectoryTable.source_directory,
        })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .orderBy(desc(ProjectDirectoryTable.time_created), asc(ProjectDirectoryTable.directory))
        .all()
        .pipe(Effect.orDie)
      return rows.map(toDirectory)
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
        .select({
          directory: ProjectDirectoryTable.directory,
          kind: ProjectDirectoryTable.kind,
          strategy: ProjectDirectoryTable.strategy,
          sourceDirectory: ProjectDirectoryTable.source_directory,
        })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            eq(ProjectDirectoryTable.directory, input.directory),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? toDirectory(row) : undefined
    })

    const removeManaged = <E, R>(
      input: RemoveInput,
      managedRemove: (directory: Directory) => Effect.Effect<void, E, R>,
    ) =>
      withLock(
        input,
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const directory = yield* get(input)
            if (directory?.kind !== "managed" || !directory.strategy) return false
            yield* restore(managedRemove(directory))
            return (
              (yield* db
                .delete(ProjectDirectoryTable)
                .where(
                  and(
                    eq(ProjectDirectoryTable.project_id, input.projectID),
                    eq(ProjectDirectoryTable.directory, input.directory),
                    eq(ProjectDirectoryTable.kind, "managed"),
                  ),
                )
                .returning({ directory: ProjectDirectoryTable.directory })
                .get()
                .pipe(Effect.orDie)) !== undefined
            )
          }),
        ),
      )

    return Service.of({
      list,
      get,
      contains,
      withLock,
      create,
      register,
      createManaged,
      discover,
      remove,
      removeIf,
      removeManaged,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
