import { pathKey } from "@/utils/path-key"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { LocalProject } from "@/context/layout"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { sessionUpdatedAt } from "@/context/global-sync/session-trim"

/** Builds a directory-qualified key so identical session IDs in separate locations stay distinct. */
export function sessionSearchKey(session: { directory: string; id: string }) {
  return `${pathKey(session.directory)}:${session.id}`
}

/** A session paired with the exact project directory that owns its home-list entry. */
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

/** Builds home-list entries using exact directory membership before project compatibility metadata. */
export function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  const projects = input.projects()
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
    .flatMap((session) => {
      const project = projectForSession(session, projects, input.projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}
