import { z } from "zod"

/** A native prompt input part produced from plugin tool prompt text. */
export type ToolPromptPart =
  | { readonly id?: string; readonly type: "text"; readonly text: string }
  | {
      readonly id?: string
      readonly type: "file"
      readonly mime: string
      readonly filename?: string
      readonly url: string
      readonly source?: unknown
    }
  | { readonly id?: string; readonly type: "agent"; readonly name: string; readonly source?: unknown }
  | {
      readonly id?: string
      readonly type: "subtask"
      readonly prompt: string
      readonly description: string
      readonly agent: string
      readonly model?: { readonly providerID: string; readonly modelID: string }
      readonly command?: string
    }

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
  /**
   * Resolves native file and agent references in prompt text for the current
   * project. Returns host-owned prompt parts and rejects when resolution fails.
   */
  resolvePromptParts?(template: string): Promise<ReadonlyArray<ToolPromptPart>>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
