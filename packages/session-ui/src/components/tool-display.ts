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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}
