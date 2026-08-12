# zgap

`zgap` runs Codex and Claude Code through `https://ai-proxy.zz.gg` after browser OAuth login. It applies proxy routing only to the child process and keeps each CLI's normal local history.

## Requirements

- Bun
- Codex CLI available on `PATH`
- Claude Code available on `PATH` when running `zgap claude`

## Install

The installer uses the official Bun installer when Bun is not already available, then installs the latest global `zgap` package:

```sh
curl -fsSL https://raw.githubusercontent.com/kargnas/zgap/main/install.sh | bash
```

An existing npm installation prints the migration instructions. Run them exactly once before using `zgap update`:

```sh
npm uninstall -g zgap
bun add -g zgap@latest
```

For an npm-installed `zgap`, `zgap update` prints the migration instructions and stops without uninstalling or changing the npm installation. After migration, `zgap update` updates a Bun global installation with `bun add -g zgap@latest`.

## Start

Run `zgap` without arguments to open the OpenTUI start screen. The screen reads the local zgap credential state and shows the available actions:

- A valid refresh session shows **Signed in**, **CODEX**, and **Claude**.
- An expired refresh session shows **Session expired** and **Login again**.
- Missing or invalid credentials show **Not signed in** and **Login**.

Press Up or Down to move and Enter to continue. Press Ctrl+C twice or Esc twice within one second to quit. Text remains selectable for terminal copy.

While the screen is open, it continuously checks `https://ai-proxy.zz.gg/health` without delaying input. The screen replaces the displayed full-response time in milliseconds immediately, then starts the next check 250 milliseconds later. A failed response or the three-second timeout shows **Proxy unreachable** until the next successful check.

```sh
zgap
```

## Sign in

```sh
zgap login
```

The command opens `ai-proxy.zz.gg`, completes browser OAuth with PKCE, and stores the device-bound access and refresh token pair in `~/.config/zgap/credentials.json` (or the `XDG_CONFIG_HOME` equivalent). On macOS and Linux, the credential file and its directory use private permissions. Token rotation replaces the pair atomically before expiry.

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

## Direct commands

```text
zgap login             Sign in with ai-proxy.zz.gg
zgap logout            Sign out on this device
zgap codex [args...]   Run Codex through ai-proxy.zz.gg
zgap claude [args...]  Run Claude through ai-proxy.zz.gg
zgap update            Update the global zgap installation with Bun
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
