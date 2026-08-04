import { describe, expect, test } from "bun:test"
import { moveDestinationCategory, moveSessionCurrentDirectory } from "../../src/component/dialog-move-session"

describe("move session directory selection", () => {
  test("keeps the explicit session directory while destinations load or fail", () => {
    expect(
      moveSessionCurrentDirectory({
        current: { type: "directory", directory: "/checkout/b", subdirectory: false },
        instanceDirectory: "/checkout/a",
      }),
    ).toBe("/checkout/b")
  })

  test("labels managed destinations with their persisted source when available", () => {
    expect(
      moveDestinationCategory(
        { directory: "/work/b-copy", kind: "managed", sourceDirectory: "/checkout/b" },
        "/checkout/a",
      ),
    ).toBe("Managed copy from /checkout/b")
    expect(moveDestinationCategory({ directory: "/work/legacy", kind: "managed" }, "/checkout/a")).toBe(
      "Other",
    )
  })
})
