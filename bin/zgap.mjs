#!/usr/bin/env bun

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "auth-token") {
    if (args.length !== 1) throw new Error("Invalid auth-token invocation.");
    // Claude Code gives startup helpers only a short window, so this path must not load the TUI and installer.
    const { resolveAccessToken } = await import("../src/credentials.mjs");
    process.stdout.write(await resolveAccessToken({ credentialFile: path.resolve(args[0]) }));
    return 0;
  }

  const { main } = await import("../src/cli.mjs");
  return main({
    argv: [command, ...args],
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  run().then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`zgap: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
