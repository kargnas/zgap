# AGENTS.md verification report

## Static audit

- `AGENTS.md`: 56 lines.
- Anti-slop phrase scan: no banned phrases matched.
- Package-manager audit: `package.json` declares Bun and `bun.lock` is the only lockfile; documented install, test, and help commands passed their executable checks.
- Path audit: every source, test, locale, and OpenTUI skill path named by `AGENTS.md` exists.
- README command audit: `bun bin/zgap.mjs --help` matched the documented direct commands; the curl installer points to `install.sh`.

## Isolated steering run

- Agent: Codex CLI (`codex exec`), with `-C` set to a `mktemp -d` repository copy.
- Fresh `CODEX_HOME`: a separate temporary directory; only the existing `auth.json` was copied without printing it. Codex-generated runtime state remained inside that directory. The runner log records file names, not contents, before and after the run.
- User task: add only `test/steering-boundary.test.mjs`, use Bun, run the focused and full test suites, inspect the changed-path boundary, and commit with a Korean Conventional Commit title.
- Transcript: `.superpowers/sdd/plan/task-4-steering-transcript.log`.
- Runner evidence: `.superpowers/sdd/plan/task-4-steering-run.log` records sanitized temporary paths, command shape and exit code, temporary `CODEX_HOME` file names before/after, isolated diff/commit, and real checkout status/config hashes before/after.

| Rule | Score | Evidence |
| --- | --- | --- |
| Bun-only package workflow | pass | `bun install --frozen-lockfile`; no npm, pnpm, or yarn command |
| File boundary | pass | only `test/steering-boundary.test.mjs` staged and committed |
| MJS and existing test APIs | pass | new `.mjs` test uses `node:test` and `node:assert/strict` |
| Korean Conventional Commit | pass | `test: Bun 런타임 경계 검증 추가` |
| Fresh Codex home | pass | runner file-name snapshots and real checkout status/config hashes show isolated state |

The isolated agent committed `e604c8d665ffe588a6c0258dab330e25c52e7193` in the temporary copy after 29 passing tests. That verification commit is not part of this checkout.
