# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Virtual Office" — a 2D pixel-art game (Phaser 3) where each on-screen NPC is a real Claude Code agent. The player walks up to an NPC to chat with that agent, or talks to the **PM** agent which decomposes a request into tasks, delegates them to other agents (visualized as the PM walking over and handing off work), and runs them as actual `claude` CLI subprocesses against real project directories.

UI strings and agent system prompts are in Chinese; code and identifiers are in English.

## Commands

```bash
npm start        # start Express + WebSocket server on :3000 (serves client/ statically)
npm test         # run all Jest tests
npx jest tests/pmOrchestrator.test.js          # single test file
npx jest -t "scheduleTasks"                    # single test by name
```

There is no build step or linter. The client is plain ES modules loaded directly in the browser; Phaser is pulled from a CDN in `client/index.html`. Just reload the browser after editing client code.

## Architecture

**Three layers, connected by a single WebSocket:**

1. **Browser (Phaser game)** — `client/src/`. `main.js` boots two scenes: `GameScene` (world, player movement, NPCs) and `UIScene` (chat panels, mode toggle, add-agent form). `WSClient` wraps the socket and re-dispatches each server message as a DOM `Event` whose `type` is the message's `type` field — scenes subscribe with `addEventListener('agent_move', ...)` etc.
2. **Node server** — `server/`. `index.js` wires Express (static client) + `ws.WebSocketServer`, seeds default agents on boot, and routes every socket message to `wsHandler.handleMessage`.
3. **Claude CLI subprocesses** — `claudeRunner.spawnAgent` shells out to the real `claude` binary in non-interactive mode (`-p`) with `--output-format stream-json`, parsing each stdout line into text/done/error chunks streamed back over the socket.

**Agents are markdown files, not a database.** `agentManager.js` stores each agent as `~/.virtual-office/agents/<id>.md` using `gray-matter`: YAML front-matter holds config (`name`, `emoji`, `role`, `workDir`, `tools`, `avatar`) and the markdown body is the `systemPrompt`. `loadAgent`/`saveAgent`/`listAgents`/`deleteAgent` are the only access path. Agent ids are validated against `/^[a-zA-Z0-9_-]+$/` (they become filenames). Defaults are seeded in `index.js#seedDefaultAgents` and only created if missing — editing those defaults requires deleting the `.md` files.

**The PM orchestration flow** (the heart of the system, in `pmOrchestrator.js` + `wsHandler.js`):
- A `chat` message to `agentId: 'pm'` is special-cased. The PM's system prompt is built fresh from the current agent roster (`buildPMSystemPrompt`) so it always knows the team.
- The PM is instructed to end its reply with a JSON block `{ plan, tasks: [{ agent, task, waitFor }] }`. `extractPMPlan` regex-scrapes that JSON from the streamed text.
- `scheduleTasks` topologically layers tasks into **waves** by their `waitFor` dependency (`null` = run immediately/parallel). Tasks with unresolvable/circular deps are dropped with a logged warning.
- `executePlan` runs waves sequentially; within a wave, `executeWave` spawns all agents in parallel (`Promise.all`). Before each wave, `animController.buildDelegationEvents` emits the `agent_move`/`agent_bubble`/`agent_status` events that drive the walk-over-and-delegate animation.

**Control mode** (`set_mode`, per-connection state in a `WeakMap`): `auto` executes the PM's plan immediately; `confirm` sends a `plan_preview` and waits for a `confirm_plan` message before executing. A `pmRunning` flag guards against concurrent PM requests on the same connection.

### WebSocket message protocol

Client → server: `chat` `{agentId, message}`, `set_mode` `{mode}`, `add_agent` `{config}`, `delete_agent` `{agentId}`, `confirm_plan`, `agents_list`.

Server → client: `agents_list` `{agents}`, `chat_chunk` `{agentId, text, done}` (streaming), `plan_preview` `{plan}`, `agent_move` `{agentId, toAgentId}`, `agent_bubble` `{agentId, text}`, `agent_status` `{agentId, status, result}`, `error` `{message}`.

When adding a new feature that spans the wire, you typically touch four places: a `case` in `wsHandler.handleMessage`, a `send`/`broadcast` call, a `WSClient` event listener in a scene, and the rendering in `GameScene`/`UIScene` or an entity (`Player`, `AgentNPC`).

## Important details

- **Single-user assumption.** Streaming `chat_chunk` output during plan execution is pushed to `[...wss.clients][0]` (the first connected client), while lifecycle events (`agent_status`, etc.) are broadcast to all. Multi-client support is not built.
- `CLAUDE_BIN` can override the `claude` binary path; otherwise the executable is resolved from `PATH`. `CODEX_BIN` does the same for Codex. `PORT` overrides 3000.
- Tests are pure-logic unit tests (`agentManager`, `claudeRunner` parsing/arg-building, `pmOrchestrator`, `animController`) — `testEnvironment: 'node'`, no DOM/Phaser/network. There are no client-side tests.
