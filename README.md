# Codex Connector

This Gety custom connector indexes local Codex session JSONL logs as searchable
markdown documents.

## Scope

- Creates one `codex:session` document per Codex JSONL session file.
- Uses the session summary as the title when available, otherwise falls back to
  the first user prompt.
- Adds a short session block with workspace roots and model when available.
- Indexes user messages and Codex final answers.
- Skips prompt-only sessions that do not have a Codex final answer.
- Renders Codex as `Codex`, not `Assistant`.
- Separates conversation rounds with `---`.
- Never indexes tool outputs.
- Can include brief tool call summaries through a config checkbox. This is off
  by default.
- Can include archived sessions through a config checkbox. This is on by
  default.
- Scans all candidate logs during the first poll, yielding real document updates
  as each indexable session is parsed.
- On later polls, lists and stats candidate logs, but only parses files whose
  mtime or size changed.
- Tracks lightweight file fingerprints in connector state so changed files,
  removed files, and config changes can update only the affected session docs.

The connector does not expose a session directory config. It resolves the Codex
home directory from the current platform:

- `CODEX_HOME` if the environment variable is set.
- Windows: `%USERPROFILE%\.codex`, then `%HOMEDRIVE%%HOMEPATH%\.codex`.
- Linux/macOS: `$HOME/.codex`.

It scans `sessions/` and, when enabled, `archived_sessions/` under that Codex
home directory.

Normal incremental polls do not reread unchanged JSONL content. They compare the
current file list with the stored fingerprints and remove previously indexed
sessions when their source file disappears.

## Files

- `manifest.json` declares the connector metadata, config form, and
  `dist/main.js` runtime entry.
- `assets/codex-color.svg` is the connector icon shown in Gety.
- `src/index.ts` contains the connector poll/state logic.
- `src/codex_log.ts` contains Codex JSONL scanning, parsing, and markdown
  rendering.
- `dist/main.js` is the committed build output loaded by Gety.
- `dist/main.js.map` is committed to make debugging the bundled entry easier.
- `dev/gety-connector-sdk/mod.ts` is a local development shim so `deno check`
  and the build script do not require the Gety SDK to be installed.
- `src/gen/manifest.d.ts` is generated from `manifest.json` by
  `deno task generate`, `deno task check`, or `deno task build`.

## Build

```bash
deno task verify
deno task build
```

The build keeps `@gety-ai/connector-sdk` external. Gety supplies the real SDK at
runtime through its import map.

`deno task verify` formats code, applies safe lint fixes, runs type checking,
then builds. `deno task build` only regenerates `dist/main.js` and
`dist/main.js.map` for fast local iteration.

## Test

```bash
deno task test
deno task verify
```

Unit tests use Deno's built-in test runner and cover JSONL parsing, markdown
rendering, platform path resolution, and state transitions. They do not read
your real Codex history.

## Live Runner

```bash
cp .env.example .env
deno task runner -- --reset-state
```

`dev/runner.ts` is a generic local runner for the Gety connector runtime
contract. It reads `manifest.json`, imports the manifest `entry` (`dist/main.js`
by default), builds config values from `.env`, injects `config`, `lastState`,
and `signal`, then runs `onLoad()` and `poll()`. Each poll cycle creates a fresh
connector instance and runs `onLoad()`, matching Gety's one-shot Deno runner
lifecycle.

Config environment variables are derived from manifest field IDs:

- `GETY_CONFIG_INCLUDE_TOOL_CALLS` or `INCLUDE_TOOL_CALLS`
- `GETY_CONFIG_INCLUDE_ARCHIVED_SESSIONS` or `INCLUDE_ARCHIVED_SESSIONS`

Runner output is written outside git:

```text
dev/runs/<timestamp>/
  summary.json
  state.before.json
  state.after.json
  updates.json
  deletes.json
  docs/
    0001-<doc_type>__<doc_id>.md
    0001-<doc_type>__<doc_id>.json
```

The persistent runner state lives at `dev/.runner/state.json`, so repeated runs
exercise incremental sync. Use `--reset-state` to start from an empty state.
Optional flags:

```bash
deno task runner -- --polls 3 --interval 60
deno task runner -- --state dev/.runner/codex-state.json --out-dir dev/runs
```

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from local folder and select this repository.
3. Configure whether tool call summaries and archived sessions should be
   indexed.
4. Wait for the first poll to finish, then search for a Codex session title or
   prompt.

After changing files under `src/`, run `deno task build`, then use Restart in
Gety to load the new `dist/main.js`.
