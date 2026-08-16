import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MessageTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node])))
const sessionID = SessionSchema.ID.make("ses_store_counts")

describe("SessionStore", () => {
  it.effect("counts legacy-only projected history", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const legacyID = SessionSchema.ID.make("ses_store_legacy")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: legacyID,
          project_id: Project.ID.global,
          slug: "legacy",
          directory: "/project",
          title: "legacy",
          version: "test",
        })
        .run()
      yield* db
        .insert(MessageTable)
        .values([
          {
            id: SessionV1.MessageID.make("msg_legacy-user"),
            session_id: legacyID,
            time_created: 1,
            data: { role: "user", time: { created: 1 } } as never,
          },
          {
            id: SessionV1.MessageID.make("msg_legacy-assistant"),
            session_id: legacyID,
            time_created: 2,
            data: { role: "assistant", time: { created: 2, completed: 3 }, error: { type: "unknown" } } as never,
          },
        ])
        .run()

      const store = yield* SessionStore.Service
      expect(yield* store.counts(legacyID)).toEqual({ userPrompts: 1, completedAssistantResponses: 1 })
    }),
  )

  it.effect("counts current-only projected history", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const currentID = SessionSchema.ID.make("ses_store_current")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: currentID,
          project_id: Project.ID.global,
          slug: "current",
          directory: "/project",
          title: "current",
          version: "test",
        })
        .run()
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: SessionMessage.ID.make("msg_current-user"),
            session_id: currentID,
            type: "user",
            seq: 1,
            time_created: 1,
            data: { text: "private current prompt", files: [], agents: [], time: { created: 1 } } as never,
          },
          {
            id: SessionMessage.ID.make("msg_current-assistant"),
            session_id: currentID,
            type: "assistant",
            seq: 2,
            time_created: 2,
            data: {
              agent: "build",
              model: { id: "model", providerID: "provider" },
              content: [],
              error: { type: "unknown", message: "private error" },
              time: { created: 2, completed: 3 },
            } as never,
          },
        ])
        .run()

      const store = yield* SessionStore.Service
      expect(yield* store.counts(currentID)).toEqual({ userPrompts: 1, completedAssistantResponses: 1 })
    }),
  )

  it.effect("counts legacy and current projections once per message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "store-counts",
          directory: "/project",
          title: "store counts",
          version: "test",
        })
        .run()
      yield* db
        .insert(MessageTable)
        .values([
          {
            id: SessionV1.MessageID.make("msg_legacy-user"),
            session_id: sessionID,
            time_created: 1,
            data: { role: "user", time: { created: 1 } } as never,
          },
          {
            id: SessionV1.MessageID.make("msg_shared-user"),
            session_id: sessionID,
            time_created: 2,
            data: { role: "user", time: { created: 2 } } as never,
          },
          {
            id: SessionV1.MessageID.make("msg_legacy-complete"),
            session_id: sessionID,
            time_created: 3,
            data: { role: "assistant", time: { created: 3, completed: 4 }, error: { type: "unknown" } } as never,
          },
          {
            id: SessionV1.MessageID.make("msg_legacy-incomplete"),
            session_id: sessionID,
            time_created: 5,
            data: { role: "assistant", time: { created: 5 } } as never,
          },
        ])
        .run()
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: SessionMessage.ID.make("msg_shared-user"),
            session_id: sessionID,
            type: "user",
            seq: 1,
            time_created: 2,
            data: { text: "private current prompt", files: [], agents: [], time: { created: 2 } } as never,
          },
          {
            id: SessionMessage.ID.make("msg_current-error"),
            session_id: sessionID,
            type: "assistant",
            seq: 2,
            time_created: 6,
            data: {
              agent: "build",
              model: { id: "model", providerID: "provider" },
              content: [],
              error: { type: "unknown", message: "private error" },
              time: { created: 6, completed: 7 },
            } as never,
          },
          {
            id: SessionMessage.ID.make("msg_current-incomplete"),
            session_id: sessionID,
            type: "assistant",
            seq: 3,
            time_created: 8,
            data: {
              agent: "build",
              model: { id: "model", providerID: "provider" },
              content: [],
              time: { created: 8 },
            } as never,
          },
        ])
        .run()

      const store = yield* SessionStore.Service
      expect(yield* store.counts(sessionID)).toEqual({ userPrompts: 2, completedAssistantResponses: 2 })
    }),
  )

  it.effect("does not suppress a legacy message because another session has its ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const otherSessionID = SessionSchema.ID.make("ses_store_other")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: sessionID,
            project_id: Project.ID.global,
            slug: "store-cross-session",
            directory: "/project",
            title: "store cross session",
            version: "test",
          },
          {
            id: otherSessionID,
            project_id: Project.ID.global,
            slug: "store-other",
            directory: "/project",
            title: "store other",
            version: "test",
          },
        ])
        .run()
      yield* db
        .insert(MessageTable)
        .values({
          id: SessionV1.MessageID.make("msg_cross-session"),
          session_id: sessionID,
          time_created: 1,
          data: { role: "user", time: { created: 1 } } as never,
        })
        .run()
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make("msg_cross-session"),
          session_id: otherSessionID,
          type: "user",
          seq: 1,
          time_created: 1,
          data: { text: "other session", files: [], agents: [], time: { created: 1 } } as never,
        })
        .run()

      const store = yield* SessionStore.Service
      expect(yield* store.counts(sessionID)).toEqual({ userPrompts: 1, completedAssistantResponses: 0 })
    }),
  )
})
