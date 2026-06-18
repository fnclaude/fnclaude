#!/usr/bin/env bun
/**
 * Standalone entry point. Mounts the renderer and ignores the returned
 * handle — `mountRenderer()` with no props makes the App self-subscribe to
 * a live `claude --print` stream-json session. Keep this file thin: the
 * App (and `mountRenderer`) are the testable surface, the bin is just the
 * launcher that shares their code path.
 */

import { mountRenderer } from "./mount.tsx";

mountRenderer();
