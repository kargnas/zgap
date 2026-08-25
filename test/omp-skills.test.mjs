import assert from "node:assert/strict";
import { test } from "./harness.mjs";

test("OMP 스킬 탐색은 설치된 OMP 설정과 탐색기를 그대로 사용한다", async () => {
  const { discoverOmpSkills } = await import("../src/omp-skills.mjs");
  const calls = [];

  const skills = await discoverOmpSkills({
    cwd: "/workspace/project",
    ompResolver: async (options) => {
      calls.push(["resolve", options]);
      return "/opt/omp/dist/cli.js";
    },
    importer: async (specifier) => {
      calls.push(["import", specifier]);
      if (specifier.endsWith("/src/config/settings.ts")) {
        return {
          Settings: {
            loadReadOnly: async (options) => {
              calls.push(["settings", options]);
              return {
                getGroup: (key) => {
                  assert.equal(key, "skills");
                  return { ignoredSkills: ["private-*"] };
                },
                get: (key) => {
                  assert.equal(key, "disabledExtensions");
                  return ["skill:disabled"];
                },
              };
            },
          },
        };
      }
      if (specifier.endsWith("/src/extensibility/skills.ts")) {
        return {
          loadSkills: async (options) => {
            calls.push(["skills", options]);
            return {
              skills: [
                { name: "git", description: "Git workflow", source: "codex:user" },
                { name: "playwright", description: "Browser", source: "agents:user" },
              ],
            };
          },
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });

  assert.deepEqual(skills, [
    { name: "git", source: "codex:user" },
    { name: "playwright", source: "agents:user" },
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === "settings" || kind === "skills"), [
    ["settings", { cwd: "/workspace/project" }],
    ["skills", {
      cwd: "/workspace/project",
      ignoredSkills: ["private-*"],
      disabledExtensions: ["skill:disabled"],
    }],
  ]);
});
