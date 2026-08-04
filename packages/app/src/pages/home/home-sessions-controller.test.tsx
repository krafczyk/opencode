import { expect, test } from "bun:test"
import { sessionSearchKey } from "./home-sessions-helpers"

test("keeps same-project session search keys scoped to their exact directories", () => {
  expect(sessionSearchKey({ directory: "/checkout/a", id: "ses_1" })).toBe("/checkout/a:ses_1")
  expect(sessionSearchKey({ directory: "/checkout/b", id: "ses_1" })).toBe("/checkout/b:ses_1")
})
