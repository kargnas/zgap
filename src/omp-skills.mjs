import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOmpExecutable } from "./omp.mjs";

export async function discoverOmpSkills({
  cwd = process.cwd(),
  env = process.env,
  ompResolver = resolveOmpExecutable,
  importer = (specifier) => import(specifier),
} = {}) {
  const ompPath = await ompResolver({ cwd, env });
  const packageRoot = path.resolve(path.dirname(ompPath), "..");
  // OMP owns skill-source precedence and filtering, so its read-only loader keeps this list identical to a real launch.
  const [settingsModule, skillsModule] = await Promise.all([
    importer(pathToFileURL(path.join(packageRoot, "src", "config", "settings.ts")).href),
    importer(pathToFileURL(path.join(packageRoot, "src", "extensibility", "skills.ts")).href),
  ]);
  const settings = await settingsModule.Settings.loadReadOnly({ cwd });
  const result = await skillsModule.loadSkills({
    cwd,
    ...settings.getGroup("skills"),
    disabledExtensions: settings.get("disabledExtensions") ?? [],
  });
  return result.skills.map(({ name, source }) => ({ name, source }));
}
