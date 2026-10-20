`codex-chat-models.json` is derived from the official Codex 0.163.0 catalogue:
https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/models-manager/models.json

It retains the published model metadata and replaces the instruction text with
this application's chat-only instructions. Shell, apply-patch, code-mode,
subagent and Node REPL metadata are disabled. `hostedCli.js` also disables other
tool families at invocation time. The CLI binaries themselves are unmodified.

Source license: Apache-2.0, included in `CODEX-CATALOG-LICENSE.txt`.
Keep the catalogue and the pinned Codex dependency in sync when upgrading.
