export const name = '@fnclaude/cli';

export {
  sanitizeName,
  sanitizeNamesInPassthrough,
  type SanitizeNamesResult,
} from './sanitize.js';
export {
  parseRepoRef,
  type RepoRef,
} from './repoRef.js';
export { expandTildePath } from './paths.js';
export {
  findPromptsDir,
  loadPrompts,
  readPromptFile,
  readPromptFileSync,
  type FindPromptsDirResult,
  type LoadPromptsResult,
  type PromptSet,
  type ReadPromptFileResult,
} from './prompts.js';
