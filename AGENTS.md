# AGENTS.md

## Guardrail

- This is a public repository. Do not expose any identical information except the domain `ai-proxy.zz.gg`. Even in this domain, you can only expose these:
  - Login protocol
  - Identity, Usage Information
  - LLM protocols (like openai-compat, anthropic-compat and etc)

## Project Map

- `bin/zgap.mjs`: Bun executable entrypoint.
- `src/cli.mjs`: command dispatch, help, installation detection, and start screen wiring.
- `src/login.mjs` and `src/credentials.mjs`: browser OAuth and private credential storage.
- `src/catalog.mjs` and `src/codex.mjs`: Codex discovery, ephemeral catalog assembly, and launch arguments.
- `src/tui/`: OpenTUI start screen and locale resources.
- `test/`: Node test-runner suites executed by Bun.

## Commands

- Install with `bun install`; keep `bun.lock` as the only dependency lockfile.
- Run all tests with `bun test`.
- Run a focused suite with `bun test test/task3.test.mjs` or `bun test test/zgap.test.mjs`.
- Check the executable help with `bun bin/zgap.mjs --help`.
- Use Bun for package installation and scripts. Do not use npm, pnpm, or yarn to change dependencies or lockfiles.

## Runtime and Modules

- Use the Bun runtime declared by `package.json`; keep the executable shebang and `.mjs` ESM modules.
- Use `node:*` built-ins and existing dependencies before adding packages.
- Keep repository-owned defaults in source modules, not new environment variables.

## Ownership Boundaries

- Keep OAuth protocol and credential-file changes in `src/login.mjs` and `src/credentials.mjs`.
- Keep catalog validation, bundled-model reads, and temporary-file lifecycle in `src/catalog.mjs`.
- Keep Codex process arguments and child environment cleanup in `src/codex.mjs`.
- Keep menu rendering and keyboard handling in `src/tui/menu.mjs`; keep translations in `src/tui/locales/*.json`.

## OpenTUI

- Read `.agents/skills/opentui/SKILL.md` before changing `src/tui/`; use its linked docs for renderer, keyboard, and testing details.
- Preserve the alternate-screen renderer, selectable text, signal cleanup, and renderer destruction on selection, errors, and exit signals.
- Preserve the two-press Ctrl+C and Esc quit behavior within one second; a confirmed quit returns exit code 130.

## i18n

- Use `i18next` through the existing menu translator; do not add an object-based translation system.
- Add or edit locale JSON only under `src/tui/locales/`; keep English as the fallback and preserve the existing locale keys in every file.
- Keep user-facing menu copy in the locale resources rather than hard-coding new strings in render code.

## Codex Contract

- Keep `login` credential-only: write the zgap credential path and do not mutate the user's Codex configuration.
- Keep `zgap codex` configuration process-local: inject launch arguments, clear conflicting Codex environment variables, and remove the temporary catalog after the child exits.

## Self reviewing

- Run the TUI and see how it looks visually. Fix anything that looks weird or unpolished.

## Tests and Changes

- Add behavior coverage beside the relevant existing suite in `test/` and run the focused test before `bun test`.
- Preserve unrelated dirty files, `.agents/ai-tasks/**`, and plan files.
- Use Korean Conventional Commit titles for completed changes; stage only files belonging to the change.
