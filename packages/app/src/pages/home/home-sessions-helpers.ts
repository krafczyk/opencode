import { pathKey } from "@/utils/path-key"

/** Builds a directory-qualified key so identical session IDs in separate locations stay distinct. */
export function sessionSearchKey(session: { directory: string; id: string }) {
  return `${pathKey(session.directory)}:${session.id}`
}
