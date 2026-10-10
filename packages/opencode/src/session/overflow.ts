import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
const DEFAULT_COMPACTION_TOKEN_LIMIT = 180_000

/**
 * Returns the V1 automatic-compaction threshold for a model and configuration.
 * Context zero returns zero; otherwise the model's natural usable threshold is
 * capped at compaction.max_tokens (a positive integer, default 180,000) without
 * side effects. Lower model input/context limits still trigger compaction earlier.
 * Expects validated configuration and model metadata; no errors are intentionally thrown.
 *
 * @param input - The V1 configuration, provider model, and optional output override.
 * @returns The usable token threshold for automatic compaction.
 */
export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const natural = input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return Math.min(natural, input.cfg.compaction?.max_tokens ?? DEFAULT_COMPACTION_TOKEN_LIMIT)
}

/**
 * Checks whether reported V1 usage reaches the inclusive usable threshold.
 * Disabled auto-compaction and unknown context return false. A truthy total
 * takes precedence; otherwise input, output, and cache read/write are summed.
 * Expects validated inputs, has no side effects, and intentionally throws no errors.
 *
 * @param input - V1 configuration, reported usage, provider model, and optional output override.
 * @returns Whether automatic compaction is needed at this processing boundary.
 */
export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
