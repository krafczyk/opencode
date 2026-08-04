export * as PermissionSaved from "./saved"

import { and, eq, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectV2 } from "../project"
import { PermissionTable } from "./sql"
import { PermissionSaved } from "@opencode-ai/schema/permission-saved"

export const ID = PermissionSaved.ID
export type ID = typeof ID.Type

export const Info = PermissionSaved.Info
export type Info = typeof Info.Type

/** Filters saved approvals by project and, when supplied, active directory plus legacy project-wide rows. */
export const ListInput = Schema.Struct({
  projectID: ProjectV2.ID.pipe(Schema.optional),
  directory: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionSaved.ListInput" })
export type ListInput = typeof ListInput.Type

/** Persists new approvals for one established project directory. */
export const AddInput = Schema.Struct({
  projectID: ProjectV2.ID,
  directory: Schema.String,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
}).annotate({ identifier: "PermissionSaved.AddInput" })
export type AddInput = typeof AddInput.Type

export interface Interface {
  /** Lists approvals applicable to the requested project and optional active directory. */
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  /** Saves each resource for the supplied project directory. */
  readonly add: (input: AddInput) => Effect.Effect<void>
  /** Removes one saved approval by identifier. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PermissionSaved") {}

function listCondition(input?: ListInput) {
  if (!input?.projectID) return
  if (!input.directory) return eq(PermissionTable.project_id, input.projectID)
  return and(
    eq(PermissionTable.project_id, input.projectID),
    or(eq(PermissionTable.directory, input.directory), isNull(PermissionTable.directory)),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = Effect.fn("PermissionSaved.list")(function* (input?: ListInput) {
      const rows = yield* db
        .select()
        .from(PermissionTable)
        .where(listCondition(input))
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): Info => ({
          id: row.id,
          projectID: row.project_id,
          ...(row.directory ? { directory: row.directory } : {}),
          action: row.action,
          resource: row.resource,
        }),
      )
    })

    const add = Effect.fn("PermissionSaved.add")(function* (input: AddInput) {
      if (!input.resources.length) return
      yield* db
        .insert(PermissionTable)
        .values(
          input.resources.map((resource) => ({
            id: ID.create(),
            project_id: input.projectID,
            directory: input.directory,
            action: input.action,
            resource,
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const remove = Effect.fn("PermissionSaved.remove")(function* (id: ID) {
      yield* db.delete(PermissionTable).where(eq(PermissionTable.id, id)).run().pipe(Effect.orDie)
    })

    return Service.of({ list, add, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
