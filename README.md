# Agents Office 🏢

A visual office for AI teamwork. Explore a scripted Demo, or connect your AI through Claude / ChatGPT account authorization with browser-owned credentials. Select a folder in your browser to let teammates work on files on your own computer.

像素风 AI 办公室：默认先体验 Demo；正式模式使用「模型与登录」授权，Token 保存在用户浏览器 localStorage。为减少运行成本，两个模式均禁用文件上传。

![Agents Office hosted Demo with labeled sample replies and disabled uploads](docs/screenshots/aws-public-demo.jpg)

## Two modes

| Mode | Behavior | AI usage |
| --- | --- | --- |
| **Demo — default** | Automatic clothing-shop scenario: scripted user/PM discussion, revisions and approval, three parallel assignments, individual reports and a final PM summary. Start once and watch. | No provider calls or model tokens. |
| **Live — your AI** | Browser-owned Claude / ChatGPT account credentials. PM can delegate up to three teammate tasks and summarize their proposals. | Uses that visitor's account allowance. A team workflow can make multiple requests. |

Project folders belong to the visitor's browser, not the server. The app does not run the AI CLI inside a visitor-supplied server path or stage a server copy of the project. Upload controls remain disabled, and `/upload` rejects requests before reading their bodies. File operations for an explicitly selected project use the browser connection described below.

**Live Demo:** [Agents Office](https://d396om3j4lmtlb.cloudfront.net). The password-free release was [deployed and verified](https://github.com/catflyx520/agents-office/actions/runs/39339228277) on October 19, 2026 (America/Los_Angeles). It opens in Demo; visitors can switch to Live mode to connect their AI. See the [deployment guide](docs/AWS-DEPLOYMENT.md) for operation and checks.

## Run locally

Install Node.js 24, then:

```sh
git clone https://github.com/catflyx520/agents-office.git
cd agents-office
npm install
npm start
```

Open **http://localhost:3000**. Demo needs no account or `.env`. Select **Live** or **Models & sign-in**, select a provider, and use **Connect / Authorize** followed by **Open authorization page (new tab)**. The existing dialog is retained, but OAuth code exchange is now handled in memory by the application instead of a CLI login that caches credentials on the server. Submit the Claude one-time code in the same field. Codex uses OpenAI's dynamic open-source client registration: a local callback completes automatically; if the final `127.0.0.1` address cannot open (for example on hosted pages), copy that complete callback URL from the address bar into the same field. This uses OAuth tokens, not an API-key form. Provider acceptance of this changed authorization integration has not been tested.

`npm install` includes the pinned official CLIs (Claude Code 2.1.304 and Codex 0.163.0), so the public runtime does not depend on an older global installation. After pulling this change, run `npm install` and restart the local server. **中文 / English** changes the interface language.

`npm ci` is also available for a clean installation of the exact dependency versions in the lockfile.

### Automatic shop Demo

Click **Start shop sample** once. The entire scenario then plays automatically: the sample user's opening request, PM's questions, six rounds of scripted replies and proposal revisions, the final API/task list, and the sample user's approval. Replies are explicitly labeled as sample dialogue, not actions taken by the viewer. No replies, continuation clicks or approval clicks are required. The story covers guest checkout, SKU variants, cart controls, stock failures, shipping, duplicate submissions, layouts and price changes.

After PM presents the API, JSON examples, money/error conventions and BE-01 / FE-01 / MOB-01 assignments, the sample user's final approval is shown as part of the story and work starts automatically. Demo does not create a manual plan-confirmation gate, regardless of the office's execution mode. Live-mode confirmation behavior is unchanged.

PM dispatches all three tasks together. Each teammate's three progress updates and detailed report automatically appear in the same PM scenario transcript, labeled by role, and remain in that teammate's own chat too. No role switching is needed to watch the whole story. Teammates execute their own assignments without a discussion between them. PM summarizes only after all three reports finish. The banner shows progress and offers Replay after completion or cancellation. No shop APIs, project changes or tests described in the story are executed.

### Project Folder, System Prompt and Live Logs

In **Team → Edit**, click **Choose folder** and select a project on your own computer, then save the teammate. Set the folder for PM and the teammates who need file access; they can share a folder or select separate repositories. Cancelling the editor leaves the previous selection active. Folder names are stored in your browser's localStorage; supported directory handles are stored in browser IndexedDB. No absolute server path is accepted as a project directory. The browser may require you to click **Allow access** again after refresh.

In Live mode, the AI can list, read, write and edit authorized text files using the `browser_workspace` file tools. The backend forwards each operation to the owning browser, which performs it only within the selected directory. Only requested file contents pass through the backend to the AI; choosing a folder never uploads the entire project, and the app does not save a server project copy. CLI built-in filesystem/shell tools are disabled, and CLI cwd is a new isolated directory for that task, removed after the process exits. This mode cannot run terminal commands or tests on the visitor's computer. Browsers without directory read/write support use a read-only directory picker; those selections must be chosen again after refresh. Demo never invokes file tools.

**Authentication storage has changed.** Access/refresh/ID tokens and their expiry are saved only in this browser's localStorage under `vo_ai_auth_v1:claude` and `vo_ai_auth_v1:codex`. Immediately before each AI call, the backend requests the selected teammate's provider credential from that browser. The browser sends only its access token, expiry and revision over the office connection. The backend passes that access token to the call's CLI child environment, never to a credential JSON file or a reusable account cache. Claude receives `CLAUDE_CODE_OAUTH_TOKEN`; Codex uses the documented Responses provider environment-token configuration with ephemeral credential storage. The temporary credential reference is released after each call and child-process cleanup, before the next dependent task or PM summary. Parallel calls have separate request IDs and credential lifetimes; a pending plan retains no token.

The backend no longer issues a recovery cookie or retains a local workspace for 24 hours. The browser owns chat history, teammate settings, model choices, mode and pending plans, and sends the required values with each AI/Demo request. On completion, cancellation or failure, the request object, temporary contexts, teammate configuration, plan/results, file bridges and CLI credentials are released. There is no history/settings/account cache to restore from the server. PKCE/state/nonce exist only while a sign-in is in progress, and refresh tokens exist on the backend only during that exchange. Refreshing the page cancels an unfinished task/sign-in; completed credentials and saved conversations reload from browser storage. Signing out clears only that provider's local credential and cancels active work; it does not erase saved conversations or remotely revoke the provider grant.

The four default roles have editable **System Prompts** in the same form. Built-in PM, Backend, Frontend and Mobile prompts follow **中文 / English** in both the editor and actual AI requests. Custom prompts and unsaved custom draft text keep their original wording when the interface language changes. These instructions are included in direct replies, delegated work and the PM summary; Claude receives them through `--append-system-prompt`, and Codex through `developer_instructions`. **Live Logs opens by default** and shows the effective prompt, project directory, tool activity and completion. Demo remains scripted and never touches project files.

Local `npm start` binds to `127.0.0.1`; `NODE_ENV=production` (including the AWS Docker image) binds to all interfaces. In both cases, file access is through the visitor's browser permission, never a server project directory. Restart the local server after backend changes, then refresh the page.

## Browser-owned chat and settings

| Data | Browser storage |
| --- | --- |
| Real conversations | Existing `vo_office_history` localStorage key |
| Scripted Demo transcript | `vo_office_demo_history_v1` localStorage key |
| Teammates, prompts, mode, provider default, office name | `vo_office_settings_v1` localStorage key |
| Pending confirmation plan | `vo_office_plan_v1` localStorage key |
| Compact summaries, covered-message boundary and compact log | `vo_office_compact_v1` localStorage key |
| Model preferences | Existing `vo_agent_models_v1` localStorage key |
| Credentials | Existing `vo_ai_auth_v1:claude` / `vo_ai_auth_v1:codex` localStorage keys |
| Usage | Existing `vo_token_usage_v1:<id>` localStorage records |
| Folder names/IDs and handles | Existing localStorage metadata plus browser IndexedDB handles |

Existing `vo_office_history` records are preserved. Sent messages and completed replies are saved; streaming text is flushed at intervals and on page hide/disconnect. Reload restores from localStorage, without a backend snapshot. Demo and Live use separate chat keys so a scripted example is never included as real AI context. Pending plans and edited teammate configurations also survive reload. Browser permission for folder handles is rechecked rather than trusted from saved flags.

For each real question, the browser flushes its current conversation to localStorage, reads the relevant recent messages (up to eight per teammate), excludes the just-saved current question to avoid duplication, and sends those messages with the current teammate settings. The backend appends the new question and applies the existing context limits. Fresh conversations do not send earlier thread history. The appropriate browser token is requested separately just before each AI call, including delegated work and the PM summary. Results stream back to the owning browser for local saving. Confirming a plan sends the browser's saved plan; the backend validates it again and retains no pending closure between requests.

The application's request logs are not written on the backend. Both proxy templates have access logging off and suppress request error logging, which can contain callback URLs. These are local configuration changes only; no AWS configuration or old remote logs have been changed or deleted.

### Manual Compact

The original 🗜️ button is available above a Live conversation with saved messages. It reads the current conversation from `vo_office_history` and summarizes it using that teammate's selected model and browser credential. The confirmation shows the selected model and number of AI calls before proceeding. Longer histories are split into chronological segments, each merged with the previous summary; each bounded segment is a separate request, and actual provider usage is recorded normally. Compact has no file tools and does not require choosing a Project Folder.

The complete conversation stays in `vo_office_history`. Only after all segments succeed does the browser commit the full summary, covered-message ID, new logical session ID and compact log to `vo_office_compact_v1`. Later questions send the summary plus recent messages after that boundary, rather than re-sending the covered conversation. Refresh reloads both the chat and summary locally. Fresh conversation requests ignore the previous compact memory. Cancelled, failed or unsaved compaction leaves the previous summary intact. Compact progress messages are excluded from AI context. Summaries are rendered as text in the compact log. The backend retains no summary or compact session after a request ends; only the browser coordinates segments. Console inspection uses `[Office Compact]` without printing conversation text or tokens.

## One model per teammate

In **Team → Edit**, one model dropdown groups the choices under **Claude** and **GPT / Codex**. Each teammate has one `modelProvider` and one `modelId`. Direct replies, delegated tasks and the PM's final summary use that teammate's selection and matching browser credential. The header and team list show the selected model. Both provider credential states remain visible above the office, independently of the teammate currently selected. The provider radio in Models & sign-in only sets the default for **new** teammates; it no longer switches the execution provider of existing teammates or clears their chats.

Choices are saved in browser localStorage under `vo_agent_models_v1` and restored as settings metadata for teammates in the current roster after reconnect/server restart. The app waits for restoration before accepting Live messages. When migrating an old teammate with separate Claude/Codex fields, it keeps the model belonging to the previously preferred provider; existing supported aliases keep their original values. Old unsupported IDs are shown with a reselect notice and blocked from execution, without silently replacing them. A missing login or a provider rejection fails visibly; the app does not retry using another provider/model. Task scheduling and the existing two-CLI-process limit are unchanged.

The public catalog is shared by the browser and backend at `client/data/models.json` (updated **2026-10-20**): Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5; GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna. Both groups retain **Account default**, selected by the official CLI. The public list excludes retired/hidden models; Codex entries must also exist in the pinned native CLI catalog. A listed model is not a claim that a particular account can use it. Sources: [Claude Code model configuration](https://code.claude.com/docs/en/model-config), [Claude model IDs](https://platform.claude.com/docs/en/models/overview), [Codex models](https://learn.chatgpt.com/docs/models).

Filter **browser Console** for **`[Office Models]`** to see `agentId`, `provider`, `requestedModel`, `actualModel`, stage and request ID. Live Logs shows requested and actual models separately. Actual models come only from provider-response metadata exposed by the CLI (Claude assistant/result fields or explicit Codex response model fields). Missing metadata displays **Provider did not report a model**, even when a specific model was requested. The command-line argument is never presented as confirmed actual metadata. Per-user model/auth inspection events go only to the owning browser; the backend does not write them to its logs.

## Inspect credential flow in Console

Filter browser DevTools Console for **`[Office Auth]`** and **`[Office Storage]`**. Events include `storage_saved`, `storage_read`, `task_token_sent`, `backend_task_started`, `runtime_cleanup`, `backend_call_released`, `restored_from_localStorage`, `request_context_sent`, `backend_request_released` and `storage_cleared`. Only stage/provider, teammate/model, expiry, storage key, request ID and cleanup status are logged; tokens show `[REDACTED]`, and chat text, file contents and authorization codes/URLs are omitted. Cleanup checks credential-file existence without opening its contents. Unexpected native credential files return `SERVER_CREDENTIAL_CACHE_DETECTED` after removal; directory-removal failure returns `CREDENTIAL_CLEANUP_FAILED` and does not report successful data release. These are implementation diagnostics, not a completed security audit or proof of successful provider inference.

In DevTools **Application → Local Storage → the office origin**, tokens and saved conversations belong to that browser user. Localhost and CloudFront are different origins and do not share data. Clearing browser storage removes the local copy; there is no backend recovery copy. If localStorage writes fail, chat/settings show a warning that unsaved page data may be lost after refresh; tokens fail to save visibly. The app does not fall back to saving on the backend. Switching Demo/Live retains saved credentials and keeps real chat separate from the scripted Demo transcript.

This is a custom browser-token integration, not a claim of provider approval for third-party sign-in. In particular, Anthropic's third-party credential restrictions still apply; successful local token storage does not establish that Claude permits this hosted use. See [Claude authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use), [OpenAI registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), and [OpenAI OAuth token provider configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

## Visitor data

- **Token Usage uses the original cards, Today / Week / Total tabs, member/session rankings, model breakdown and cache details.** Each real CLI usage result is forwarded once with a unique ID. The browser saves usage metadata under `vo_token_usage_v1:<id>` in localStorage and computes the report locally; the hosted backend no longer retains a cumulative usage table. Refresh, Demo/Live switching, signing out and restarting the server do not delete saved usage. Today follows the browser's local date and Week starts on Monday. Separate keys prevent duplicate counting and concurrent-tab overwrite of another call's record.
- Usage records contain only the call ID, timestamp, teammate/session IDs, provider/model and reported token counts; they contain no prompts, project contents or login credentials. Missing provider fields show **—** and totals sum reported values only. The original count convention is retained: uncached input + cache creation + output, with cache reads separate; this is not a dollar bill. Claude's final per-model totals are counted once per independent CLI call; Codex cached input is separated from its reported input total. See [Claude usage reporting](https://code.claude.com/docs/en/agent-sdk/cost-tracking) and [Codex JSON output](https://learn.chatgpt.com/docs/non-interactive-mode).
- Only the **Office** usage board is shown; the iTerm board and its click entry have been removed. Only usage received by the browser is recorded. Demo adds no usage, and old machine CLI logs are not imported. Storage is specific to this browser profile and site origin: localhost and AWS do not share history, and clearing site storage removes it. If localStorage is blocked or full, the UI warns that unsaved records remain only in page memory and may be lost on refresh; there is no server-storage fallback.
- Both local and production runtimes use a request-only backend. The server has no cross-request chat history, visitor roster/settings, account-presence map or pending-plan closure. The browser supplies a current snapshot when work starts; only that active request uses it, and its data is released after child-process/file-bridge cleanup. Settings and history recovery require no server cookie. Replies and usage go only to the originating connection.
- Account authorization does not run a CLI login or read token files. Pending PKCE/state/nonce and callback routing are cleaned when that authorization completes, expires, fails or disconnects. OpenAI ID tokens are checked against issuer signing keys, audience, expiry and nonce. Inference uses an unmodified official CLI once per call, with an isolated runtime directory and session persistence disabled; cleanup runs after child exit on success, failure, timeout or cancellation. Stop the old server normally before using this version so its old in-memory sessions end. The current authentication/storage flow has not been browser-tested or exercised with real provider calls in this change.
- Disconnecting or refreshing aborts active calls and pending authorization; no idle workspace remains for reattachment. The browser reloads saved chat, settings and completed credentials from its own storage. Production retains the existing 15-minute idle connection timeout; localhost remains loopback-only. In-progress tasks are not resumed after refresh/server restart; completed browser data survives independently of the backend.
- The public runtime never reads the owner's model credentials, CLI logins, projects or saved local sessions. Provider URLs are fixed to official OpenAI / Anthropic endpoints.
- Requests have context/output limits, timeouts and a bounded number of concurrent provider calls. Token counts come from provider responses, not estimated dollar charges. Demo does not fabricate usage.

Inference disables CLI built-in filesystem/shell tools. Without a selected project, model tools remain disabled. With an authorized folder, only the per-request `browser_workspace` MCP server is exposed: Claude uses an empty built-in tool list and strict MCP config; Codex retains its disabled native tools and pinned catalogue, plus this explicit MCP connection. The loopback MCP endpoint uses a per-request capability and relays to the owning WebSocket/browser; it never opens project paths on the server. At most two official CLI processes run concurrently. Account login alone does not prove that a model request or paid usage has occurred. Official references: [Codex authentication](https://developers.openai.com/codex/auth/), [OpenAI Docs: app-server browser sign-in](https://developers.openai.com/codex/app-server/), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [hosting unmodified Claude Code](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products).

**Local changes awaiting owner feedback:** request-only backend, browser-owned chats/settings/plans/OAuth credentials, per-teammate models, browser folder/file tools, usage history, editable prompts and automatic shop Demo are local changes and have not been published to AWS. The deployed site is an earlier release. Validation for this storage change is static only: JavaScript syntax, identifier scope, module references and diff whitespace. Existing session/public/smoke fixtures were updated for browser-supplied snapshots, per-call credentials and no server history recovery; they have not been executed. The owner will perform functional testing; no browser, automated functional or paid-model test was run.

## Local entry points

Both `npm start` and `npm run start:local` now launch `server/publicServer.js`, using browser-owned data and local folder permissions. The old `server/index.js` and its single-user filesystem/session helpers remain as reference source only; they are not the npm/AWS website entry point and do not meet the current browser-only storage contract.

## Development and AWS

```sh
npm run check
npm test -- --runInBand
npm run prepare:hosting
```

The ARM64 CI check builds the public Docker image and verifies the real Nginx/WebSocket path, Demo workflow, upload rejection and visitor connection state without making paid AI calls. CLI checks use isolated loopback fixtures. The current local sign-in changes await owner testing; no new paid-model acceptance is claimed.

**Stack:** native JavaScript / DOM / SVG · Node.js 24 · Express · WebSocket · EC2 Docker · CloudFront. No frontend compilation step is required.

Source: `client/`, `server/`, `tests/`, `deployment/`. [AWS deployment and rollout](docs/AWS-DEPLOYMENT.md) includes the existing account resources, console step, rollback and costs.

## License

MIT
