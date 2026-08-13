#!/usr/bin/env bun

const startsTui = import.meta.main && process.argv.length === 2;
// Enter the TUI before loading dependencies so the previous prompt disappears as soon as Bun starts.
if (startsTui) process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "auth-token") {
    if (args.length !== 1) throw new Error("Invalid auth-token invocation.");
    // Claude Code gives startup helpers only a short window, so this path must not load the TUI and installer.
    const path = await import("node:path");
    const { resolveAccessToken } = await import("../src/credentials.mjs");
    process.stdout.write(await resolveAccessToken({ credentialFile: path.resolve(args[0]) }));
    return 0;
  }

  const { main } = await import("../src/cli.mjs");
  return main({
    argv: [command, ...args],
  });
}

if (import.meta.main) {
  run().then(
    (code) => { process.exitCode = code; },
    (error) => {
      if (startsTui) process.stdout.write("\x1b[?1049l");
      console.error(`zgap: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
