# zgap

`zgap` is a small multi-agent wrapper client that connects local AI coding agents to one private, personal-use AI proxy.

## Quick Start

```sh
$ curl -fsSL https://raw.githubusercontent.com/kargnas/zgap/main/install.sh | bash
```

The installer adds `zgap` through Bun and installs Bun first when needed.

Sign in, then open the agent menu:

```sh
$ zgap login
$ zgap
```

Codex and Claude Code are currently supported. Existing local configuration and session history remain in their normal locations.

```text
zgap codex [args...]   Run Codex
zgap claude [args...]  Run Claude Code
zgap sessions          Browse agent history
zgap --help            Show all commands
```

## Proxy Host

The agent proxy defaults to `ai-proxy.zz.gg`. To use another hostname, create `~/.config/zgap/config.yml`:

```yaml
host: proxy.example.com
```

Use a hostname without `https://`, a port, or a path. Login, token refresh, the model catalog, Codex, Claude Code, and health checks all use this host.

## Development

```sh
bun install
bun test
```
