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

Codex, Claude Code, and OMP are currently supported. Existing local configuration and session history remain in their normal locations.

```text
zgap codex [args...]   Run Codex
zgap claude [args...]  Run Claude Code
zgap omp [args...]     Run OMP
zgap sessions          Browse agent history
zgap --help            Show all commands
```

Use the arrow keys to move between start-menu actions and press Tab to switch between SAFE and YOLO modes for Codex, Claude Code, and OMP. The choice is saved locally and applies to new launches, direct commands, and resumed sessions. YOLO mode bypasses Codex approval and sandbox checks, Claude Code permission checks, and OMP tool-approval prompts.

## Development

```sh
bun install
bun test
```
