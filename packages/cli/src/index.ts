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

// MCP wire protocol + parent-side listener + subprocess client.
export {
  ActionDone,
  ActionError,
  ActionPasteFlow,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  OpCopy,
  OpRestart,
  OpSpawn,
  OpSwitch,
  readRequest,
  readResponse,
  type Action,
  type Op,
  type Request,
  type Response,
} from './mcp/protocol.js';
export {
  SocketListener,
  type ClipboardResult,
  type SocketListenerDeps,
  type SpawnResult,
  type StartOptions as SocketListenerStartOptions,
} from './mcp/socketListener.js';
export {
  runMCPServer,
  type DialFn,
  type MCPServerOptions,
} from './mcp/client.js';
export {
  applyOverrides,
  preserveArgs,
  splitLeadingMagic,
  transferDenyBareOK,
  transferDenyFlags,
} from './args/preserve.js';
