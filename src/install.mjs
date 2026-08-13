import { spawn } from "node:child_process";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function updateGlobalInstall({
  run = runCommand,
} = {}) {
  return run("bun", ["add", "-g", "github:kargnas/zgap#main", "--force", "--no-cache"]);
}
