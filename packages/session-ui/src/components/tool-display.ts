export function toolDisplay(tool: string, metadata: Record<string, unknown> = {}) {
  if (tool === "task") return "task"
  const model = recordValue(metadata.model)
  if (
    stringValue(metadata.parentSessionId) &&
    stringValue(metadata.sessionId) &&
    stringValue(model?.providerID) &&
    stringValue(model?.modelID)
  )
    return "task"
  return "generic"
}

export function taskRoleName(role: unknown) {
  if (typeof role !== "string") return
  const name = role.split(".").at(-1)
  if (!name) return
  const words = name.split("-")
  if (words.some((word) => !word)) return
  return words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(" ")
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}
