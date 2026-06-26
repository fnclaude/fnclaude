/**
 * Pure preparation for `git clone` / `gh repo clone`: given a resolved
 * RepoRef, compute (a) the URL to fetch from and (b) the on-disk path
 * to clone into per the user's `cloneTemplate`. No filesystem, no
 * network — the orchestrator runs these to plan a clone, then executes.
 *
 * Mirrors the bits of Go canonical's resolver.go that sit between
 * parseRepoRef and the eventual `exec gh repo clone` — specifically
 * the URL construction (resolver.go's `cloneURL`) and the
 * template-driven destination path (resolver.go around the
 * `expandCloneTemplate` call site).
 */

import { effectiveHost, hasResolvedOwner, type RepoRef } from './ref';
import { applyTemplate, cloneTemplateVars } from './template';
import { expandTilde } from '../path/resolve';

export function buildCloneUrl(ref: RepoRef): string {
  if (!hasResolvedOwner(ref)) {
    throw new Error(`buildCloneUrl: ref has no owner (original=${JSON.stringify(ref.original)})`);
  }
  if (ref.name === '') {
    throw new Error(`buildCloneUrl: ref has empty name (original=${JSON.stringify(ref.original)})`);
  }
  return `https://${effectiveHost(ref)}/${ref.owner}/${ref.name}.git`;
}

export interface ComputeCloneDestinationArgs {
  ref: RepoRef;
  template: string;
  hostAliases: Record<string, string>;
  home: string;
}

export type ComputeCloneDestinationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export function computeCloneDestination(args: ComputeCloneDestinationArgs): ComputeCloneDestinationResult {
  const { ref, template, hostAliases, home } = args;
  const vars = cloneTemplateVars(ref.name, ref.owner, effectiveHost(ref), hostAliases);
  const applied = applyTemplate(template, vars);
  if (!applied.ok) return applied;
  return { ok: true, path: expandTilde(applied.value, home) };
}
