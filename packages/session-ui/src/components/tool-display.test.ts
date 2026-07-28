import { describe, expect, test } from "bun:test"
import { taskRoleName, toolDisplay } from "./tool-display"

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

describe("taskRoleName", () => {
  test("formats the final CE role segment", () => {
    expect(taskRoleName("ce-debug.hypothesis-investigator")).toBe("Hypothesis Investigator")
    expect(taskRoleName("ce-simplify-code.code-quality-reviewer")).toBe("Code Quality Reviewer")
    expect(taskRoleName("ce-work.implementation-worker")).toBe("Implementation Worker")
  })

  test("rejects missing and malformed roles", () => {
    expect(taskRoleName(undefined)).toBeUndefined()
    expect(taskRoleName(42)).toBeUndefined()
    expect(taskRoleName("ce-debug.")).toBeUndefined()
  })
})
