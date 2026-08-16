export * as SessionStore from "./store"

import { eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

/** Counts that can be read from legacy and current message projections without hydrating message bodies. */
export interface Counts {
  readonly userPrompts: number
  readonly completedAssistantResponses: number
}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
  /**
   * Returns privacy-safe aggregate prompt and completed-assistant counts for one session.
   * Current `session_message` rows own their IDs; a legacy `message` row is included only when
   * no current row in that session has that ID, preserving mixed history without double-counting mirrored rows.
   * The query reads aggregates only, never message bodies, and has no side effects.
   */
  readonly counts: (sessionID: SessionSchema.ID, tx?: Transaction) => Effect.Effect<Counts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
      counts: Effect.fn("SessionStore.counts")(function* (sessionID, tx?: Transaction) {
        const database = tx ?? db
        const current = yield* database
          .select({
            userPrompts: sql<number>`coalesce(sum(case when ${SessionMessageTable.type} = 'user' then 1 else 0 end), 0)`,
            completedAssistantResponses: sql<number>`coalesce(sum(case when ${SessionMessageTable.type} = 'assistant' and json_extract(${SessionMessageTable.data}, '$.time.completed') is not null then 1 else 0 end), 0)`,
          })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const legacy = yield* database
          .select({
            userPrompts: sql<number>`coalesce(sum(case when json_extract(${MessageTable.data}, '$.role') = 'user' and not exists (select 1 from "session_message" as "current" where "current"."id" = "message"."id" and "current"."session_id" = "message"."session_id") then 1 else 0 end), 0)`,
            completedAssistantResponses: sql<number>`coalesce(sum(case when json_extract(${MessageTable.data}, '$.role') = 'assistant' and json_extract(${MessageTable.data}, '$.time.completed') is not null and not exists (select 1 from "session_message" as "current" where "current"."id" = "message"."id" and "current"."session_id" = "message"."session_id") then 1 else 0 end), 0)`,
          })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        return {
          userPrompts: (current?.userPrompts ?? 0) + (legacy?.userPrompts ?? 0),
          completedAssistantResponses:
            (current?.completedAssistantResponses ?? 0) + (legacy?.completedAssistantResponses ?? 0),
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
