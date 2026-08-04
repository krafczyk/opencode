import { pathKey } from "@/utils/path-key"

/** Directory classification and grouping metadata used by app project navigation. */
export type ProjectDirectoryRecord = {
  projectID?: string
  directory: string
  kind: "user" | "managed"
  strategy?: string
  sourceDirectory?: string
  fallbackDirectory?: string
}

type StoredProject = { directory: string; expanded: boolean }

/** Derives independently selectable roots and managed-copy children from authoritative directory records. */
export function presentProjectDirectories(entries: StoredProject[], records: ProjectDirectoryRecord[]) {
  const byDirectory = new Map(records.map((record) => [pathKey(record.directory), record]))
  const parents = new Map<string, string>()
  const children = new Map<string, ProjectDirectoryRecord[]>()

  for (const record of records) {
    if (record.kind !== "managed") continue
    const parent = record.sourceDirectory ?? record.fallbackDirectory
    if (!parent || pathKey(parent) === pathKey(record.directory)) continue
    const key = pathKey(parent)
    parents.set(pathKey(record.directory), parent)
    const existing = children.get(key) ?? []
    children.set(key, [...existing, record])
  }

  const roots: string[] = []
  const known = new Set<string>()
  for (const entry of entries) {
    const key = pathKey(entry.directory)
    if (parents.has(key) || known.has(key)) continue
    known.add(key)
    roots.push(entry.directory)
  }
  for (const parent of parents.values()) {
    const key = pathKey(parent)
    if (known.has(key)) continue
    known.add(key)
    roots.push(parent)
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
      const record = byDirectory.get(pathKey(directory))
      return record?.kind === "managed" ? record : undefined
    },
  }
}

/** Reports whether a directory record carries the server authority required for managed-copy removal. */
export function canRemoveManagedDirectory(record: ProjectDirectoryRecord | undefined) {
  return record?.kind === "managed" && !!record.strategy
}
