#!/usr/bin/env bun

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";
import { resolveBunGlobalBin } from "../src/install.mjs";

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  resolveBunGlobalBin().then((bunGlobalBin) => main({
    invokedPath: process.argv[1],
    modulePath,
    bunGlobalBin,
  })).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`zgap: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
