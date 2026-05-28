/**
 * Shared constants for the auto-name LLM call (§5.2).
 *
 * Both the Anthropic SDK fast-path (`sdk-llm.ts`) and the `claude -p`
 * subprocess fallback (in `main.ts`) drive the same model with the same
 * system prompt; extracting them here keeps the two paths in sync.
 */

export const AUTO_NAME_MODEL = 'claude-haiku-4-5';

export const AUTO_NAME_SYSTEM_PROMPT =
  "Generate a 1-3 word lowercase hyphen-separated label for this user's request. " +
  "Output ONLY the label — no punctuation, no quotes, no explanation, no leading 'Label:'. " +
  "Examples: 'fix-login-bug', 'add-dark-mode', 'refactor-auth'.";
