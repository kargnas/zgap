# zgap

`zgap` is a small multi-agent wrapper client that connects local AI coding agents to one private, personal-use AI proxy.

## Quick Start

```sh
curl -fsSL https://raw.githubusercontent.com/kargnas/zgap/main/install.sh | bash
```

The installer adds `zgap` through Bun and installs Bun first when needed.

Sign in, then open the agent menu:

```sh
zgap login
zgap
```

The first proxy-backed command creates `config.yml` when it is missing. The file is stored at `$XDG_CONFIG_HOME/zgap/config.yml` when `XDG_CONFIG_HOME` is set, `%APPDATA%\zgap\config.yml` on Windows, and `~/.config/zgap/config.yml` otherwise. Its generated comments explain the `host` option; enter a hostname without a URL scheme, port, or path. An existing file is never replaced.

Codex, Claude Code, and OMP are currently supported. Existing local configuration and session history remain in their normal locations. `zgap omp` loads its provider override only in the launched OMP process: the server model catalog and context-window metadata populate the `openai-codex` and `anthropic` providers, their requests use the configured proxy, direct official usage checks for those providers are disabled, and a regular `omp` process remains unchanged. The standalone `zgap omp usage` command is rejected.

Existing OMP extensions continue to load in the zgap child. A required extension handshake aborts startup before a session can run if the proxy override cannot load. The child also skips OMP's first-run setup wizard via `OMP_SKIP_SETUP=1` because the proxy already supplies its providers and models; exporting `OMP_SKIP_SETUP` yourself takes precedence. It also receives `ZGAP_RUNTIME`, the script runtime that resolves the proxy access token, because OMP runs as a single-file executable whose own `process.execPath` cannot run the zgap CLI.

`zgap omp` supports launch and ACP sessions. Run OMP management commands such as `models`, `config`, and `plugin` with `omp` directly.

```text
zgap codex [args...]   Run Codex
zgap claude [args...]  Run Claude Code
zgap omp [args...]     Run OMP with process-local provider overrides
zgap sessions          Browse agent history
zgap --help            Show all commands
```

Use the arrow keys to move between start-menu actions and press Tab to switch between SAFE and YOLO modes for Codex, Claude Code, and OMP. The choice is saved locally and applies to new launches, direct commands, and resumed sessions. YOLO mode bypasses Codex approval and sandbox checks, Claude Code permission checks, and OMP tool-approval prompts.

Press `L` to toggle OMP LEAN mode. Enabling it opens a warning first; press Enter to confirm or Esc to cancel. Turning it off is immediate. The saved choice applies only to OMP launches. LEAN disables ambient extensions, rules, title generation, and all skills by default, and enables only the `read`, `bash`, `edit`, and `write` built-in tools. Session storage and LSP remain active. While the OMP card is selected with LEAN enabled, press Space to choose the skills that may load, `c` to clear every check, and Enter to save. The saved selection is restored on later launches, and an empty selection keeps all skills disabled. Pass OMP's own `--tools=...` or `--skills=...` option to `zgap omp` to replace the saved LEAN defaults for a launch.

## Development

```sh
bun install
bun test
```
