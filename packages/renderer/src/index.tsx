#!/usr/bin/env bun
/**
 * Entry point: mounts the App into Ink and lets slice A's subscription
 * stream events into it. Don't add behaviour here — keep this file thin
 * so the App is the testable surface.
 */

import { render } from "ink";
import { App } from "./App.tsx";

render(<App />);
