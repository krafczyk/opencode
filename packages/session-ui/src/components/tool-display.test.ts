import { describe, expect, test } from "bun:test"
import { toolDisplay } from "./tool-display"

describe("toolDisplay", () => {
  test("preserves native task tools", () => {
    expect(toolDisplay("task")).toBe("task")
  })

  test("classifies custom tools with complete task navigation metadata", () => {
    expect(
      toolDisplay("ce_task", {
        parentSessionId: "session-parent",
        sessionId: "session-child",
        model: { providerID: "openai", modelID: "gpt-5.6-terra" },
      }),
    ).toBe("task")
  })

  test("keeps custom tools generic when task navigation metadata is incomplete", () => {
    expect(
      toolDisplay("ce_task", {
        sessionId: "session-child",
        model: { providerID: "openai", modelID: "gpt-5.6-terra" },
      }),
    ).toBe("generic")
  })

  test("classifies nested custom tasks from their immediate parent metadata", () => {
    expect(
      toolDisplay("ce_task", {
        parentSessionId: "session-child",
        sessionId: "session-grandchild",
        model: { providerID: "openai", modelID: "gpt-5.6-terra" },
      }),
    ).toBe("task")
  })
})
