import { describe, expect, test } from "bun:test"
import { timelineChildTitle, timelineRemovedSessionIDs } from "./controller-projection"

describe("timeline controller", () => {
  test("projects child titles from task descriptions and session fallbacks", () => {
    expect(timelineChildTitle({ title: "Root", fallback: "New session" })).toBe("Root")
    expect(
      timelineChildTitle({ parentID: "parent", taskDescription: "Investigate timeline", fallback: "New session" }),
    ).toBe("Investigate timeline")
    expect(
      timelineChildTitle({ parentID: "parent", title: "Fallback (@build subagent)", fallback: "New session" }),
    ).toBe("Fallback")
    expect(timelineChildTitle({ parentID: "parent", fallback: "New session" })).toBe("New session")
  })

  test("collects the removed session and all descendants", () => {
    const removed = timelineRemovedSessionIDs(
      [
        { id: "root" },
        { id: "child", parentID: "root" },
        { id: "grandchild", parentID: "child" },
        { id: "sibling", parentID: "root" },
        { id: "unrelated" },
      ],
      "root",
    )

    expect([...removed]).toEqual(["root", "child", "grandchild", "sibling"])
  })
})
