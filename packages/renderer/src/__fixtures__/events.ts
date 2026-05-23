/**
 * Hand-rolled fixture events for App.test.tsx + the stub subscription.
 *
 * Keep these small and focused — they only need to be expressive enough to
 * verify the renderer dispatch + filter repaint behaviour. Real captures
 * live in slice A's recordings.
 */

import type { ClaudeEvent } from "../types/events.ts";

export const fixtureSession: ClaudeEvent[] = [
  {
    type: "system",
    subtype: "init",
    session_id: "fixture-session",
    uuid: "u-system-1",
    cwd: "/tmp",
    model: "claude-opus-4-7",
    tools: ["Bash", "Read", "Edit", "Write", "Task"],
  },
  {
    type: "assistant",
    session_id: "fixture-session",
    uuid: "u-asst-1",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      content: [
        { type: "text", text: "Listing files now." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: { command: "ls -la", description: "List files" },
        },
      ],
    },
  },
  {
    type: "user",
    session_id: "fixture-session",
    uuid: "u-user-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "total 0\ndrwxr-xr-x 2 tom tom 60 May 19 04:59 .\n",
        },
      ],
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "fixture-session",
    uuid: "u-result-1",
    result: "Done.",
    num_turns: 1,
    duration_ms: 100,
    duration_api_ms: 50,
    total_cost_usd: 0.001,
  },
];
