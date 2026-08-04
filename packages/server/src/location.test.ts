import { describe, expect, test } from "bun:test"
import { requestLocationInfo } from "./location"

describe("requestLocationInfo", () => {
  test("rejects workspace-only explicit locations instead of pairing them with the process directory", () => {
    const location = requestLocationInfo({
      url: "http://localhost/api/session?location%5Bworkspace%5D=wrk_test",
      headers: {},
    })

    expect(location.explicit).toBeUndefined()
    expect(location.invalidWorkspaceOnly).toBe(true)
    expect(String(location.resolved.directory)).toBe(process.cwd())
  })

  test("keeps locationless requests on the compatibility fallback", () => {
    const location = requestLocationInfo({ url: "http://localhost/api/session", headers: {} })
    expect(location.explicit).toBeUndefined()
    expect(location.invalidWorkspaceOnly).toBeUndefined()
    expect(String(location.resolved.directory)).toBe(process.cwd())
  })

  test("retains a malformed encoded directory instead of falling back to the workspace or process directory", () => {
    const location = requestLocationInfo({
      url: "http://localhost/api/session",
      headers: { "x-opencode-directory": "%E0%A4%A" },
    })

    expect(String(location.explicit?.directory)).toBe("%E0%A4%A")
    expect(location.invalidWorkspaceOnly).toBeUndefined()
  })

  test("retains a workspace only when the request also supplies its directory", () => {
    const location = requestLocationInfo({
      url: "http://localhost/api/session?location%5Bdirectory%5D=%2Fworkspace&location%5Bworkspace%5D=wrk_test",
      headers: {},
    })
    expect(String(location.explicit?.directory)).toBe("/workspace")
    expect(String(location.explicit?.workspaceID)).toBe("wrk_test")
    expect(location.resolved === location.explicit).toBe(true)
  })
})
