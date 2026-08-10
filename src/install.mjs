import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const NPM_MIGRATION_WARNING = "zgap was installed with npm.\nRecommended migration:\n\nnpm uninstall -g zgap\nbun add -g zgap@latest";

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function bunGlobalPackageRoot(bunInstall) {
  return path.resolve(bunInstall, "install", "global", "node_modules", "zgap");
}

export function detectInstallation({
  entryPath,
  invokedPath = entryPath,
  modulePath = entryPath,
  bunGlobalBin,
  bunInstall = process.env.BUN_INSTALL || path.join(homedir(), ".bun"),
} = {}) {
  if (!invokedPath && !modulePath) return "unknown";
  const resolvedInvocation = invokedPath ? path.resolve(invokedPath) : null;
  const resolvedModule = modulePath ? path.resolve(modulePath) : resolvedInvocation;
  if (bunGlobalBin && resolvedInvocation && isInside(resolvedInvocation, path.resolve(bunGlobalBin))) return "bun";
  const bunRoot = bunGlobalPackageRoot(bunInstall);
  if (resolvedModule && isInside(resolvedModule, bunRoot)) return "bun";
  const npmPackageMarker = `${path.sep}node_modules${path.sep}zgap${path.sep}`;
  if (resolvedModule?.includes(npmPackageMarker)) return "npm";
  return "local";
}

export function resolveBunGlobalBin({ bunCommand = process.execPath } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bunCommand, ["pm", "bin", "-g"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const lines = output.trim().split(/\r?\n/).filter(Boolean);
      resolve(lines.at(-1) || null);
    });
  });
}

export function printNpmMigrationWarning(stderr = process.stderr) {
  stderr.write(`${NPM_MIGRATION_WARNING}\n`);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function updateGlobalInstall({
  installation = "unknown",
  run = runCommand,
  stderr = process.stderr,
  emitWarning = true,
} = {}) {
  if (installation === "npm") {
    if (emitWarning) printNpmMigrationWarning(stderr);
    return 1;
  }
  return run("bun", ["add", "-g", "zgap@latest"]);
}
