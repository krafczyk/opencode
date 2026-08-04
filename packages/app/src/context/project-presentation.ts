import { pathKey } from "@/utils/path-key"
import type { ProjectDirectories } from "@opencode-ai/sdk/v2/client"

/** Directory classification and grouping metadata used by app project navigation. */
export type ProjectDirectoryRecord = ProjectDirectories[number] & {
  projectID?: string
  fallbackDirectory?: string
}

/** Derives independently selectable roots and managed-copy children from authoritative directory records. */
export function presentProjectDirectories(
  entries: string[],
  records: ProjectDirectoryRecord[],
  pending: string[] = [],
) {
  const byDirectory = new Map(records.map((record) => [pathKey(record.directory), record]))
  const pendingKeys = new Set(pending.map(pathKey))
  const parents = new Map<string, string>()
  const children = new Map<string, ProjectDirectoryRecord[]>()

  for (const record of records) {
    if (record.kind !== "managed") continue
    if (pendingKeys.has(pathKey(record.directory))) continue
    const parent = record.sourceDirectory ?? record.fallbackDirectory
    if (!parent || pathKey(parent) === pathKey(record.directory)) continue
    const key = pathKey(parent)
    parents.set(pathKey(record.directory), parent)
    const existing = children.get(key)
    if (existing) existing.push(record)
    if (!existing) children.set(key, [record])
  }

  const roots: string[] = []
  const known = new Set<string>()
  for (const entry of entries) {
    const key = pathKey(entry)
    if (parents.has(key) || known.has(key)) continue
    known.add(key)
    roots.push(entry)
  }
  for (const parent of parents.values()) {
    const key = pathKey(parent)
    if (known.has(key)) continue
    known.add(key)
    roots.push(parent)
  }
  for (const directory of pending) {
    const key = pathKey(directory)
    if (known.has(key)) continue
    known.add(key)
    roots.push(directory)
  }

  return {
    roots,
    parent(directory: string) {
      return parents.get(pathKey(directory))
    },
    children(directory: string) {
      return children.get(pathKey(directory)) ?? []
    },
    managed(directory: string) {
      if (pendingKeys.has(pathKey(directory))) return
      const record = byDirectory.get(pathKey(directory))
      return record?.kind === "managed" ? record : undefined
    },
  }
}

/** Reports whether a directory record carries the server authority required for managed-copy removal. */
export function canRemoveManagedDirectory(record: ProjectDirectoryRecord | undefined) {
  return record?.kind === "managed" && !!record.strategy
}
