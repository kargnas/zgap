# zgap

`zgap` runs Codex and Claude Code through `https://ai-proxy.zz.gg` after browser OAuth login. It applies proxy routing only to the child process and keeps each CLI's normal local history.

## Requirements

- Bun
- Codex CLI available on `PATH`
- Claude Code available on `PATH` when running `zgap claude`

## Install

The installer uses the official Bun installer when Bun is not already available. If `unzip` is missing on an `apt-get` system, it installs that prerequisite first, then installs the latest `main` revision from GitHub:

```sh
curl -fsSL https://raw.githubusercontent.com/kargnas/zgap/main/install.sh | bash
```

To install directly with Bun:

```sh
bun add -g github:kargnas/zgap#main --force --no-cache
```

`zgap update` runs the same command so Bun resolves and reinstalls the current GitHub `main` revision instead of reusing a previously locked commit.

## Start

Run `zgap` without arguments to enter the OpenTUI start screen immediately while its dependencies load. The screen reads the local zgap credential state and shows the available actions:

- A valid refresh session shows the account email, **CODEX**, **Claude**, and **Sessions**.
- An expired refresh session shows **Session expired**, **Login again**, and **Sessions**.
- Missing or invalid credentials show **Not signed in**, **Login**, and **Sessions**.

For a signed-in session, the screen shows only the account email from the access token. zgap accepts only tokens with the `EdDSA`/`JWT` header, the fixed ai-proxy issuer and audience, numeric subject/session IDs, valid timestamps, and HTTPS proxy products. Signature verification is performed by the server; the client uses the validated payload for display only.

The start screen also checks GitHub `main` without delaying input. A Bun global installation updates itself in the background when the resolved commit differs from the installed Git commit, then shows the updated commit date. Source checkouts and linked development installations skip automatic updates.

Press Up or Down to move and Enter to continue. Press Ctrl+C twice or Esc twice within one second to quit. Text remains selectable for terminal copy.

While the screen is open, it continuously checks `https://ai-proxy.zz.gg/health` without delaying input. The screen replaces the displayed full-response time in milliseconds immediately, then starts the next check 250 milliseconds later. A failed response or the three-second timeout shows **Proxy unreachable** until the next successful check.

```sh
zgap
```

## Sign in

```sh
zgap login
```

The command requests a device authorization, sending a bounded hostname and OS name, version, and architecture so your console can identify the device. It prints the verification URL and user code, opens the complete verification URL in your browser, and polls until authorization completes. It stores the device-bound access and refresh token pair in `~/.config/zgap/credentials.json` (or the `XDG_CONFIG_HOME` equivalent). On macOS and Linux, the credential file and its directory use private permissions. Token rotation starts four hours before access expiry and replaces the pair atomically. A network or server failure keeps using the current token until 15 minutes before expiry, while a client error requires signing in again immediately.

## Sign out

```sh
zgap logout
```

The command removes the local zgap credential from this device. It waits for an active token rotation before deleting the final credential, and it does not change Codex history or configuration.

## Run Codex

```sh
zgap codex
zgap codex exec "Summarize this repository"
zgap codex resume --all
```

Arguments after `zgap codex` go directly to the installed Codex executable. The launch keeps the user's normal Codex history and supplies the zgap provider only to that child process.

The model catalog is assembled for each launch. zgap fetches the proxy catalog, reads the Codex bundled catalog, replaces proxy OpenAI entries with the bundled OpenAI entries, and keeps non-OpenAI proxy entries. The resulting catalog lives in a private temporary directory and is removed after the Codex process exits.

The process-local `model_catalog_json` override takes precedence over the same setting in `~/.codex/config.toml`. zgap does not read or modify that file.

## Run Claude Code

```sh
zgap claude
zgap claude -p "Summarize this repository"
zgap claude --resume
```

Arguments after `zgap claude` go directly to the installed Claude Code executable. zgap passes the proxy URL, model aliases, and a rotating `apiKeyHelper` through the child process and one inline `--settings` value. It does not modify `~/.claude/settings.json` or replace `CLAUDE_CONFIG_DIR`, so normal Claude Code history and customization remain available.

Claude Code uses the inline helper to obtain the current zgap access token and retries it after authentication failures. A user-supplied `--settings` option is rejected because Claude Code accepts only one effective inline settings object and replacing it would disable zgap authentication.

## Browse sessions

```sh
zgap sessions
```

The session browser reads the existing local Codex and Claude Code history without requiring a zgap login. By default, it shows sessions from the current Git repository and every linked worktree for the same repository. Outside a Git repository, the default scope is the current directory and its subdirectories.

Each row shows the agent, the saved Codex provider when available, the session title, its directory, update time, completed conversation turn count, and session file size. A green `●` marks a session JSONL currently open by Codex or Claude; Enter resume is blocked until that file is closed. Updates under three hours old use relative time. Older updates from today use local 24-hour time (`HH:mm`); updates before today's midnight use the exact local date and time (`YYYY-MM-DD HH:mm`). The visible rows load turn counts and file sizes in the background so opening the browser does not wait for every history file. If a saved title is unavailable, zgap shows the first user command, then the session ID. Claude history does not store a separate provider value, so zgap does not infer one.

Press `s` to switch between the repository and all directories, `a` to filter by agent, and `r` to refresh. Press `p` to open the dynamically discovered Codex provider filter, move with Up/Down or `j`/`k`, and apply with Enter. Highlight a concrete provider and press `c` to open bulk conversion. The target picker shows the exact number of matching Codex sessions in the current scope and agent filter; Enter changes their saved provider metadata in one transaction, while Esc or Backspace cancels. `All` remains filter-only. Move through sessions with Up/Down or `j`/`k`, page with Page Up/Page Down, and jump with Home/End. Press Space to preview user/assistant exchanges: the first and last exchanges are always kept, more surrounding turns appear when the terminal has room, and an omission marker shows how many turns were skipped. Each message uses up to two lines when space permits. Wide Codex previews show the conversation on the left and a provider rail on the right; compact terminals show one provider selector row above the conversation. Its candidates are `zgap`, built-in OpenAI (`openai`), and providers loaded from saved Codex sessions. Use Up/Down or `j`/`k` to choose a provider, then Enter resumes that session once through the selection. Space, Esc, or Backspace closes the preview and discards the selection; saved session metadata and its list label remain unchanged. Claude previews have no provider selector. Enter resumes the selected Codex or Claude session in its recorded directory. Press `?` for the complete key guide. Esc or Backspace returns to the start screen when the browser was opened there. Press Ctrl+C twice within one second to quit with exit code 130.

## Direct commands

```text
zgap login             Sign in with ai-proxy.zz.gg
zgap logout            Sign out on this device
zgap codex [args...]   Run Codex through ai-proxy.zz.gg
zgap claude [args...]  Run Claude through ai-proxy.zz.gg
zgap sessions          Browse Codex and Claude history
zgap update            Update zgap from GitHub main
zgap --help            Show command help
```

## Development

```sh
bun install
bun test
bun bin/zgap.mjs --help
```

Source modules use Bun's ESM-compatible `.mjs` entrypoints. OpenTUI locale resources are loaded from `src/tui/locales/` with English as the fallback locale.

## License

MIT
