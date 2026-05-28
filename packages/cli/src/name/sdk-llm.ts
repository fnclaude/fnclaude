/**
 * Anthropic SDK fast-path for auto-naming (§5.2).
 *
 * When ANTHROPIC_API_KEY is set, the launcher calls the API directly via
 * the official SDK instead of shelling out to `claude -p`. Same model
 * (haiku) + same system prompt as the subprocess path, but skips the
 * cold-start overhead of spawning the claude binary, parsing its config,
 * etc. — typically saves multiple seconds.
 *
 * No timeout handling here; `autoName` wraps the call with Promise.race
 * for that, and the SDK has its own retry/backoff machinery on transient
 * errors. We just need to return the text (or throw — autoName treats
 * either error or empty output as "fall back to heuristic").
 */

import Anthropic from '@anthropic-ai/sdk';

import { AUTO_NAME_SYSTEM_PROMPT, AUTO_NAME_MODEL } from './llm-prompt.ts';

export async function sdkLlmCall(prompt: string): Promise<string> {
  // SDK picks ANTHROPIC_API_KEY up from process.env by default. Letting it
  // do so (rather than passing apiKey explicitly) keeps the env-var name
  // the single source of truth and matches the way every other Anthropic
  // tool documents it.
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: AUTO_NAME_MODEL,
    max_tokens: 64,
    system: AUTO_NAME_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });
  // The response is an array of content blocks; auto-name's prompt steers
  // the model to a one-line label so we expect exactly one text block.
  // Concatenate any text blocks defensively in case the model emits more
  // than one — sanitizeLLMOutput downstream will collapse whitespace
  // and clip to 3 segments either way.
  let out = '';
  for (const block of msg.content) {
    if (block.type === 'text') out += block.text;
  }
  return out;
}
