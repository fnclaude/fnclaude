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
  isInteractiveSession,
  loadPrompts,
  readPromptFile,
  readPromptFileSync,
  selectFragments,
  type FindPromptsDirResult,
  type LoadPromptsResult,
  type PromptSet,
  type ReadPromptFileResult,
} from './prompts.js';
export {
  applyWorktreeIntercept,
  defaultGitRunner,
  findWorktree,
  listWorktrees,
  type GitRunner,
  type WorktreeInfo,
} from './worktree.js';
export {
  buildArgv,
  buildFnclaudeMCPConfigJSON,
  nameInPassthrough,
  settingSourcesInPassthrough,
  tokenInPassthrough,
  withAppendedSystemPrompts,
} from './argv.js';

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
  type CopyRequest,
  type Op,
  type Request,
  type RequestOverrides,
  type Response,
  type RestartRequest,
  type SpawnRequest,
  type SwitchRequest,
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

// Help / version surfaces consumed by main.ts and friendly to import in
// embedding hosts that want to render their own help.
export { helpText, setVersion, version, wantsHelp, wantsVersion } from './help.js';

// Warning sink + flush. Test helpers (pendingWarnings, clearWarnings) are
// re-exported so harness code can introspect/reset between cases.
export { clearWarnings, flushWarnings, pendingWarnings, warn } from './warnings.js';

// noop dir seeding (noop fallback when fnclaude is invoked with no path).
export { NOOP_HANDOFF_TEMPLATE, defaultNoopDir, seedNoop } from './noop.js';

// Silent-relaunch primitives — execve on POSIX, spawn-and-exit on Windows.
export { silentRelaunch, silentRelaunchHandoff, spawnAndExit } from './silentRelaunch.js';

// Top-level run loop + entry point.
export { main, run, type RunDeps } from './main.js';

// PTY runner + shared helpers (ring buffer, cross-cwd detection,
// reconstructArgv, ensureCWD).
export {
  clearScreen,
  crossCwdRe,
  detectCrossCwd,
  ensureCWD,
  RING_BUFFER_SIZE,
  reconstructArgv,
  RingBuffer,
  runWithPTY,
  type CrossCwdMatch,
  type EnsureCWDHandle,
  type RunOptions,
  type RunResult,
} from './pty.js';
