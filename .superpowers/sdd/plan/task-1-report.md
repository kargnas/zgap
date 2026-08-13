# Task 1 Report: zgap system metadata

## Status

DONE

## Requirements

- Added `readSystemInfo() -> Promise<{hostname, os_name, os_version, os_arch}>`.
- Added bounded hostname and OS metadata to the device authorization request as `system_info`.
- Used only Node standard-library `node:os`; no dependency or environment variable was added.

## TDD evidence

### RED

Command:

```text
bun test test/system-info.test.mjs test/zgap.test.mjs
```

Observed result:

```text
test/system-info.test.mjs could not pass because src/system-info.mjs did not exist.
The existing login test failed because the authorization payload did not contain system_info.
29 tests passed and 1 login test failed in the existing suite run.
Process exited with code 1.
```

The failures were caused by the missing requested behavior, not by a test syntax or import error.

### GREEN

Focused command:

```text
bun test test/system-info.test.mjs test/zgap.test.mjs
```

Observed result:

```text
35 pass
0 fail
Ran 35 tests across 2 files.
Process exited with code 0.
```

Full command:

```text
bun test
```

Observed result:

```text
80 pass
0 fail
Ran 80 tests across 8 files.
Process exited with code 0.
```

Additional check:

```text
git diff --check
```

This completed without output or errors.

## Files changed

- `src/system-info.mjs`: added OS metadata collection, platform-name normalization, control-character removal, and length bounds.
- `src/login.mjs`: collected system metadata once per login and sent it in the device authorization body.
- `test/system-info.test.mjs`: added metadata shape, normalization, bounds, and safety assertions.
- `test/zgap.test.mjs`: added authorization payload assertions for `system_info`.

## Self-review

- The implementation uses only `node:os` and keeps the existing login flow unchanged apart from the requested payload field.
- Metadata is collected once, so repeated token polling does not repeat host inspection.
- Hostname is capped at 255 characters; OS name and architecture are capped at 32; OS version is capped at 128.
- Control characters are removed and empty values become `unknown`.
- No fallback environment variable, dependency, persistence, deployment, or production mutation was added.
- Only the four task source/test files and this report are in scope; unrelated worktree content was preserved.

## Concerns

None identified for Task 1. The server-side validation and persistence work belongs to later tasks.
