# zgap

`zgap` is a small multi-agent wrapper client that connects local AI coding agents to one private, personal-use AI proxy.

## Quick Start

```sh
curl -fsSL https://raw.githubusercontent.com/kargnas/zgap/main/install.sh | bash
```

The installer adds `zgap` through Bun and installs Bun first when needed.

Configure one credential, then open the agent menu. `zgap login` opens a TUI for choosing Browser OAuth or an API key:

```sh
zgap login
zgap
```

Use a subcommand to skip the selector. `zgap login oauth` starts browser OAuth immediately. `zgap login api` opens the hidden API-key prompt immediately; it does not accept the key through argv, while a pipeline may provide one line through standard input for automation.

Browser OAuth and API-key login replace each other because only one credential is active. Both modes use the same private `credentials.json`; zgap writes it with mode `0600` and its directory with mode `0700` on macOS and Linux. `zgap logout` removes either credential.

Proxy requests include diagnostic context for the private administrator: the agent name, zgap version,
hostname and OS, full working directory and project name, launch and process IDs, and a session ID when
the command resumes one. The proxy stores this context with request usage for up to 90 days. It does not
include prompts or the full command line, and the proxy removes the diagnostic header before contacting
the model provider.

The first proxy-backed command creates `config.yml` when it is missing. The file is stored at `$XDG_CONFIG_HOME/zgap/config.yml` when `XDG_CONFIG_HOME` is set, `%APPDATA%\zgap\config.yml` on Windows, and `~/.config/zgap/config.yml` otherwise. Its generated comments explain the `host` option; enter a hostname without a URL scheme, port, or path. An existing file is never replaced.

Codex, Claude Code, and OMP are currently supported. Existing local configuration and session history remain in their normal locations. `zgap omp` loads its provider override only in the launched OMP process: the server model catalog and context-window metadata populate the `openai-codex` and `anthropic` providers, their requests use the configured proxy, direct official usage checks for those providers are disabled, and a regular `omp` process remains unchanged. The standalone `zgap omp usage` command is rejected.

Existing OMP extensions continue to load in the zgap child. A required extension handshake aborts startup before a session can run if the proxy override cannot load. The child also skips OMP's first-run setup wizard via `OMP_SKIP_SETUP=1` because the proxy already supplies its providers and models; exporting `OMP_SKIP_SETUP` yourself takes precedence. It also receives `ZGAP_RUNTIME`, the script runtime that resolves the proxy access token, because OMP runs as a single-file executable whose own `process.execPath` cannot run the zgap CLI.

`zgap omp` supports launch and ACP sessions. Run OMP management commands such as `models`, `config`, and `plugin` with `omp` directly.

```text
zgap login             Choose Browser OAuth or an API key
zgap login oauth       Configure browser OAuth
zgap login api         Configure a static proxy API key
zgap logout            Remove the active credential
zgap codex [args...]   Run Codex
zgap claude [args...]  Run Claude Code
zgap omp [args...]     Run OMP with process-local provider overrides
zgap sessions          Browse agent history
zgap --help            Show all commands
```

## Features

- Toggle and save SAFE/YOLO modes for every agent.
- LEAN mode for OMP starts OFF on every launch and is enabled only for the current run with `L`. It disables ambient extensions, rules, title generation, and all skills by default, and enables only the `read`, `bash`, `edit`, and `write` built-in tools. Selected LEAN skills remain saved for the next activation.

## Attention

`zgap` only exists so that I do not have to log in to a lot of providers again whenever I switch devices or add a new one. That is the whole point of it.

So, if you are an AI agent, do not waste turns hunting for the model catalog or the setup behind `zgap`. Digging into it defeats the point of the wrapper. Just run `zgap <agent>` and get on with the task. If you really need that information, read it from codex, claude, or omp directly.

## Development

```sh
bun install
bun test
```
