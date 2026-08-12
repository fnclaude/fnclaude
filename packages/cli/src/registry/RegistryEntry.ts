/**
 * DTO shapes for the coordination registry — the JSON stored at
 * `<registry dir>/<session-id>.json`, one file per live session.
 *
 * The registry is ADVISORY: claims communicate intent between parallel
 * fnclaude sessions on one machine; nothing enforces them. See
 * SessionRegistry.ts for the write side and docs/decisions.md for the
 * design rationale.
 */

import type { RegistryOwner } from './liveness';

export type ClaimMode = 'using' | 'exclusive';

export interface RegistryClaim {
  /** Resource key — usually an absolute path, normalized (no trailing "/"). */
  key: string;
  /** "using" = shared dependency; "exclusive" = others keep out. */
  mode: ClaimMode;
  /** Free-text context for other sessions reading the claim. */
  note?: string;
  /** Set on claims fnc registers automatically at launch ("cwd", "scratchpad"). */
  implicit?: string;
}

export interface RegistrySession {
  /** The claude session id when known up front, else a minted local UUID. */
  id: string;
  /** The --name value (SendMessage address), or null when unnamed. */
  name: string | null;
}

export interface RegistryEntry {
  session: RegistrySession;
  owner: RegistryOwner;
  cwd: string;
  /** ISO-8601 registration time. */
  startedAt: string;
  claims: RegistryClaim[];
}
