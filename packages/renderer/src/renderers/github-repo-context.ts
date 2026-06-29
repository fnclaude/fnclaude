import { createContext } from "react";
import type { GithubRepo } from "./github-autolink.ts";

/**
 * Repo context for GitHub autolinks. Provided by `mountRenderer` from the
 * launch cwd's origin remote; `undefined` (the default) means `#123`/`GH-123`/
 * bare-SHA refs stay plain, while `@mentions` and explicit `owner/repo#n`
 * still link (they need no context).
 */
export const GithubRepoContext = createContext<GithubRepo | undefined>(undefined);
