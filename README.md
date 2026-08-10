# zgap

`zgap` runs the official Codex CLI through `https://ai-proxy.zz.gg` after a browser OAuth login.

It uses the normal Codex home directory. Sessions created by Codex App, the native Codex CLI, and `zgap codex` stay in the same history.

## Requirements

- Node.js 20 or later
- [Codex CLI](https://developers.openai.com/codex/cli/)

## Install

```bash
npm install -g github:kargnas/zgap
```

## Sign in

```bash
zgap login
```

The command opens `ai-proxy.zz.gg` in your browser, completes OAuth with PKCE, and stores a device-bound access token and rotating refresh token at `~/.config/zgap/credentials.json` with mode `0600` on macOS and Linux. Access tokens last 24 hours; refresh tokens last 4 days.

It also adds a fixed `zgap` provider definition to `~/.codex/config.toml` so Codex App can reopen zgap sessions. It does not change the default `model_provider`; only `zgap codex` activates the proxy.

## Run Codex

```bash
zgap codex
zgap codex exec "Summarize this repository"
zgap codex resume --all
```

All arguments after `zgap codex` are passed to the installed `codex` command.

## Shared history

`zgap` does not create a separate `CODEX_HOME`, profile, model catalog, database, or session directory. It launches Codex with the user's default `~/.codex` state and selects the fixed `zgap` provider only for that process.

Tokens are not passed through argv or environment variables. Codex obtains an access token through the provider auth command, and `zgap` refreshes it before expiry. A successful refresh replaces both tokens, so the previous access and refresh tokens stop working immediately.

## Development

```bash
npm test
```

## License

MIT
