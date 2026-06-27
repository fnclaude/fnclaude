import { highlight } from "cli-highlight";

/**
 * Syntax-highlight `code` using cli-highlight and return an ANSI-coloured string.
 * Falls back to the original code string when `lang` is missing/unknown or if
 * cli-highlight throws for any reason.
 */
export function highlightCode(code: string, lang?: string): string {
  if (!lang) return code;
  try {
    return highlight(code, { language: lang, ignoreIllegals: true });
  } catch {
    return code;
  }
}
