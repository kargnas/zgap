import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const TITLE_LIMIT = 120;
const ANSI_SEQUENCE = /(?:\u001B\][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C))|\u001B\\|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

export function stripTerminalControls(value) {
  return String(value ?? "")
    .replace(ANSI_SEQUENCE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function formatSessionTitle(value) {
  return stripTerminalControls(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_LIMIT);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (["input_text", "output_text", "text"].includes(part.type)) return part.text ?? "";
    return !part.type ? part.text ?? "" : "";
  }).join(" ");
}

function emptyPreview() {
  return { turns: [] };
}

function normalizePreview(value) {
  const normalizePair = (pair) => {
    if (!pair || typeof pair !== "object") return null;
    const user = formatSessionTitle(pair.user);
    if (!user) return null;
    const assistant = formatSessionTitle(pair.assistant);
    return { user, assistant: assistant || null };
  };
  return { turns: (Array.isArray(value?.turns) ? value.turns : []).map(normalizePair).filter(Boolean) };
}

function conversationMessage(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : event;
  if (event?.type === "response_item" && payload?.type === "message") {
    return { role: payload.role, text: contentText(payload.content) };
  }
  if ((event?.type === "user" || event?.type === "assistant") && event.message?.role) {
    return { role: event.message.role, text: contentText(event.message.content) };
  }
  return null;
}

function isInjectedUserContext(value) {
  const text = String(value ?? "").trimStart();
  return text.startsWith("# AGENTS.md instructions for ")
    || text.startsWith("<codex_internal_context")
    || text.startsWith("<skill>");
}

async function readConversationPreview(pathname) {
  const turns = [];
  let pending = null;
  const lines = createInterface({ input: createReadStream(pathname, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = conversationMessage(event);
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    const text = formatSessionTitle(message.text);
    if (!text || message.role === "user" && isClaudeCommandMetadata(text)) continue;
    if (message.role === "user" && isInjectedUserContext(text)) {
      if (pending?.assistant) {
        turns.push(pending);
        pending = null;
      }
      continue;
    }
    if (message.role === "user") {
      if (pending?.assistant) turns.push(pending);
      pending = { user: text, assistant: null };
    } else if (pending) {
      pending.assistant = text;
    }
  }
  if (pending && (pending.assistant || turns.length === 0)) turns.push(pending);
  return normalizePreview({ turns });
}

function isClaudeCommandMetadata(value) {
  return /^\s*<(?:command-name|local-command-caveat|local-command-stdout)>/.test(value);
}

function normalizeRecord(record, agent) {
  if (!record || typeof record !== "object") return null;
  const id = record.id ?? record.sessionId;
  const cwd = record.cwd ?? record.projectPath;
  if (typeof id !== "string" || !id || typeof cwd !== "string" || !cwd) return null;
  const rawFirstPrompt = record.first_user_message ?? record.firstPrompt;
  const firstPrompt = isInjectedUserContext(rawFirstPrompt) ? "" : rawFirstPrompt;
  const promptTitle = formatSessionTitle(firstPrompt) === "No prompt" ? "" : formatSessionTitle(firstPrompt);
  const savedTitle = formatSessionTitle(record.aiTitle ?? record.ai_title ?? record.title);
  const title = (savedTitle === "No prompt" ? "" : savedTitle) || promptTitle || formatSessionTitle(id);
  const normalized = {
    agent,
    provider: agent === "codex" ? (typeof record.model_provider === "string" ? record.model_provider : null) : null,
    id,
    cwd: path.resolve(cwd),
    title,
    preview: normalizePreview(record.preview),
    updatedAt: asNumber(record.updatedAt ?? record.updated_at ?? record.modified ?? record.fileMtime ?? record.timestamp),
  };
  if (!hasConversationPreview(normalized.preview) && typeof record.previewPath === "string" && record.previewPath) {
    normalized.previewLocator = { type: "jsonl", path: path.resolve(record.previewPath) };
  }
  return normalized;
}

function contains(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function inRoots(target, roots) {
  return roots.some((root) => contains(path.resolve(root), target));
}

async function gitOutput(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

export async function discoverRepositoryScope(cwd = process.cwd(), options = {}) {
  const current = path.resolve(cwd);
  if (Array.isArray(options.repositoryRoots)) return options.repositoryRoots.map((root) => path.resolve(root));
  const commonDir = (await gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], current)).trim();
  if (!commonDir) return [current];
  const output = await gitOutput(["worktree", "list", "--porcelain"], current);
  const roots = [];
  for (const block of output.split(/\n\n+/)) {
    const match = block.match(/^worktree (.+)$/m);
    if (match) roots.push(path.resolve(match[1]));
  }
  return roots.length ? [...new Set(roots)] : [current];
}

async function readJson(pathname) {
  return JSON.parse(await readFile(pathname, "utf8"));
}

async function readHeadTail(pathname, maxBytes = MAX_SCAN_BYTES) {
  const handle = await open(pathname, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return [buffer.toString("utf8")];
    }
    const half = Math.floor(maxBytes / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(maxBytes - half);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tail, 0, tail.length, size - tail.length);
    return [head.toString("utf8"), tail.toString("utf8")];
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text) {
  return text.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function readBoundedJsonl(pathname, agent) {
  try {
    const [head, tail = ""] = await readHeadTail(pathname);
    const events = [...parseJsonLines(head), ...(tail ? parseJsonLines(tail) : [])];
    const fileStat = await stat(pathname).catch(() => ({ mtimeMs: 0 }));
    const fallbackId = path.basename(pathname, ".jsonl");
    const result = { id: fallbackId, agent, fileMtime: fileStat.mtimeMs, firstPrompt: "", aiTitle: "", preview: emptyPreview(), previewPath: pathname };
    for (const event of events) {
      const payload = event?.payload && typeof event.payload === "object" ? event.payload : event;
      if (event?.type === "session_meta") Object.assign(result, payload);
      if (typeof event?.cwd === "string") result.cwd ||= event.cwd;
      if (typeof event?.projectPath === "string") result.cwd ||= event.projectPath;
      if (typeof event?.sessionId === "string") result.id = event.sessionId;
      if (event?.type === "ai-title") result.aiTitle = event.aiTitle || result.aiTitle;
      if (event?.type === "custom-title") result.aiTitle = event.customTitle || event.title || result.aiTitle;
      if (event?.type === "response_item" && payload?.type === "message" && payload.role === "user") {
        const prompt = contentText(payload.content);
        if (!isInjectedUserContext(prompt)) result.firstPrompt ||= prompt;
      }
      if (event?.type === "user" && event.message?.role === "user") {
        const prompt = contentText(event.message.content);
        if (!isClaudeCommandMetadata(prompt)) result.firstPrompt ||= prompt;
      }
      if (event?.isSidechain || event?.sessionId && event?.isSidechain) result.isSidechain = true;
      result.updatedAt = Math.max(result.updatedAt ?? 0, asNumber(event.timestamp ?? payload.timestamp ?? event.modified));
    }
    if (result.isSidechain || pathname.includes(`${path.sep}subagents${path.sep}`)) return null;
    return normalizeRecord(result, agent);
  } catch {
    return null;
  }
}

async function walkJsonl(directory, { skipSubagents = false } = {}) {
  const output = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipSubagents || entry.name !== "subagents") output.push(...await walkJsonl(fullPath, { skipSubagents }));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(fullPath);
    }
  }
  return output;
}

async function readCodexDefault(codexHome) {
  const databasePath = path.join(codexHome, "state_5.sqlite");
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(databasePath, { readonly: true });
    try {
      const rows = db.query("SELECT id, model_provider, cwd, title, first_user_message, preview, rollout_path, updated_at, updated_at_ms FROM threads WHERE (TRIM(COALESCE(title, '')) <> '' AND TRIM(title) <> 'No prompt') OR TRIM(COALESCE(first_user_message, '')) <> '' OR TRIM(COALESCE(preview, '')) <> '' ORDER BY updated_at_ms DESC, updated_at DESC").all();
      for (const row of rows) {
        row.updated_at = row.updated_at_ms || row.updated_at;
        row.previewPath = row.rollout_path;
      }
      return rows;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function readActiveSessionPaths(runLsof = execFileAsync) {
  let stdout = "";
  try {
    ({ stdout } = await runLsof("lsof", ["-Fn", "-c", "codex", "-c", "claude"], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 3_000,
    }));
  } catch (error) {
    // lsof can return 1 for an unmatched command selector while still reporting other matches.
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
  }
  return new Set(stdout.split("\n")
    .filter((line) => line.startsWith("n") && line.endsWith(".jsonl"))
    .map((line) => path.resolve(line.slice(1))));
}

export async function convertCodexSessionProviders(selectedSessions, targetProvider, options = {}) {
  const target = typeof targetProvider === "string" ? targetProvider.trim() : "";
  if (!target) throw new Error("Target provider is required");
  const values = Array.isArray(selectedSessions) ? selectedSessions : [];
  if (values.some((session) => session?.agent !== "codex" || typeof session.id !== "string" || !session.id || typeof session.provider !== "string" || !session.provider)) {
    throw new Error("Only saved Codex sessions can be converted");
  }
  const sessionsById = new Map(values.map((session) => [session.id, session]));
  if (sessionsById.size === 0) return 0;
  const sourceProviders = new Set([...sessionsById.values()].map((session) => session.provider));
  if (sourceProviders.size !== 1) throw new Error("Sessions must share one source provider");
  const [source] = sourceProviders;
  if (source === target) throw new Error("Target provider must differ from source provider");

  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const databasePath = path.join(codexHome, "state_5.sqlite");
  // Bun SQLite creates a missing database, so verify the Codex index exists before opening it for writes.
  await stat(databasePath);
  const { Database } = await import("bun:sqlite");
  const db = new Database(databasePath);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    const update = db.query("UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?");
    // One stale row aborts the transaction so the visible batch is never partially converted.
    db.transaction(() => {
      for (const id of sessionsById.keys()) {
        if (update.run(target, id, source).changes !== 1) {
          throw new Error(`Session provider changed before conversion: ${id}`);
        }
      }
    })();
    return sessionsById.size;
  } finally {
    db.close();
  }
}

async function readCodexFallback(codexHome, onRecords) {
  const paths = [];
  for (const directory of [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")]) paths.push(...await walkJsonl(directory));
  const output = [];
  for (const pathname of paths) {
    const record = await readBoundedJsonl(pathname, "codex");
    if (record) {
      output.push(record);
      onRecords?.(output);
    }
  }
  return output;
}

export async function loadSessionPreview(session) {
  const pathname = session?.previewLocator?.type === "jsonl" ? session.previewLocator.path : "";
  return pathname ? readConversationPreview(pathname) : normalizePreview(session?.preview);
}

export async function loadSessionDetails(session) {
  const pathname = session?.previewLocator?.type === "jsonl" ? session.previewLocator.path : "";
  if (!pathname) {
    const preview = normalizePreview(session?.preview);
    return {
      turnCount: preview.turns.length,
      fileSize: 0,
      preview,
    };
  }
  const [preview, fileStat] = await Promise.all([
    readConversationPreview(pathname),
    stat(pathname),
  ]);
  return { turnCount: preview.turns.length, fileSize: fileStat.size, preview };
}

function hasConversationPreview(preview) {
  return Array.isArray(preview?.turns) && preview.turns.length > 0;
}

function claudeProjectPrefixes(roots) {
  return roots.map((root) => path.resolve(root).replaceAll(path.sep, "-"));
}

async function readClaudeDefault(claudeHome, roots = [], onRecords) {
  const projectsDir = path.join(claudeHome, "projects");
  let projects;
  try { projects = await readdir(projectsDir, { withFileTypes: true }); } catch { return []; }
  const byId = new Map();
  const prefixes = claudeProjectPrefixes(roots);
  for (const project of projects.filter((entry) => entry.isDirectory()
    && (prefixes.length === 0 || prefixes.some((prefix) => entry.name === prefix || entry.name.startsWith(`${prefix}-`))))) {
    const directory = path.join(projectsDir, project.name);
    try {
      const index = await readJson(path.join(directory, "sessions-index.json"));
      for (const entry of Array.isArray(index?.entries) ? index.entries : []) {
        if (!entry.isSidechain) {
          const normalized = normalizeRecord(entry, "claude");
          if (normalized) byId.set(normalized.id, normalized);
        }
      }
      onRecords?.([...byId.values()]);
    } catch { /* JSONL remains authoritative when the index is absent or malformed. */ }
    for (const pathname of await walkJsonl(directory, { skipSubagents: true })) {
      const record = await readBoundedJsonl(pathname, "claude");
      if (!record) continue;
      const previous = byId.get(record.id);
      byId.set(record.id, previous ? {
        ...previous,
        cwd: record.cwd,
        title: record.title !== record.id ? record.title : previous.title,
        preview: hasConversationPreview(record.preview) ? record.preview : previous.preview,
        ...(record.previewLocator ? { previewLocator: record.previewLocator } : {}),
        updatedAt: Math.max(previous.updatedAt, record.updatedAt),
      } : record);
      onRecords?.([...byId.values()]);
    }
  }
  return [...byId.values()];
}

export function filterSessions(sessions, filters = {}) {
  return sessions.filter((session) =>
    (filters.scope !== "repo" || inRoots(session.cwd, filters.roots ?? []))
    && (!filters.agent || filters.agent === "all" || session.agent === filters.agent)
    && (!filters.provider || filters.provider === "all" || session.provider === filters.provider));
}

export async function listSessions(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const allScope = options.all || options.scope === "all";
  const roots = allScope ? [] : await discoverRepositoryScope(cwd, options);
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const claudeHome = options.claudeHome ?? path.join(os.homedir(), ".claude");
  let codexRecords = [];
  let claudeRecords = [];
  let activePaths = new Set();
  // Partial emits reuse normalized objects so the TUI's per-session detail cache stays warm across updates.
  const normalizedCache = new WeakMap();
  const normalizeAny = (record, agent) => {
    if (!record || typeof record !== "object") return null;
    if (record.agent === agent && typeof record.provider !== "undefined") return record;
    if (!normalizedCache.has(record)) normalizedCache.set(record, normalizeRecord(record, agent));
    return normalizedCache.get(record);
  };
  const assemble = () => {
    const values = [...codexRecords.map((record) => normalizeAny(record, "codex")).filter(Boolean), ...claudeRecords.map((record) => normalizeAny(record, "claude")).filter(Boolean)];
    const visible = values.filter((session) => allScope || roots.some((root) => contains(root, session.cwd)));
    const normalizedActivePaths = new Set([...activePaths].map((pathname) => path.resolve(pathname)));
    for (const session of visible) {
      const pathname = session.previewLocator?.type === "jsonl" ? session.previewLocator.path : "";
      if (pathname && normalizedActivePaths.has(path.resolve(pathname))) session.active = true;
    }
    return visible.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  };
  // Empty partials carry no information the loading state doesn't already show, so only non-empty lists are emitted.
  const emitNow = () => {
    if (!options.onUpdate) return;
    const assembled = assemble();
    if (assembled.length > 0) options.onUpdate(assembled);
  };
  let lastEmit = 0;
  // ponytail: time-throttled per-record emits; each source-completion emitNow and the final return carry the trailing records.
  const emitThrottled = () => {
    if (!options.onUpdate) return;
    const timestamp = Date.now();
    if (timestamp - lastEmit < 80) return;
    lastEmit = timestamp;
    emitNow();
  };
  // The three sources are independent IO; running them in parallel keeps a slow lsof or JSONL walk from blocking the list.
  await Promise.all([
    (async () => {
      try { codexRecords = options.readCodex ? await options.readCodex() : await readCodexDefault(codexHome); } catch { codexRecords = []; }
      if (!options.readCodex && codexRecords.length === 0) {
        codexRecords = await readCodexFallback(codexHome, (records) => { codexRecords = records; emitThrottled(); });
      }
      emitNow();
    })(),
    (async () => {
      try {
        claudeRecords = options.readClaude
          ? await options.readClaude()
          : await readClaudeDefault(claudeHome, allScope ? [] : roots, (records) => { claudeRecords = records; emitThrottled(); });
      } catch { claudeRecords = []; }
      emitNow();
    })(),
    (async () => {
      try {
        activePaths = options.readActiveSessionPaths
          ? await options.readActiveSessionPaths()
          : options.readCodex || options.readClaude || options.codexHome || options.claudeHome
            ? new Set()
            : await readActiveSessionPaths();
      } catch {
        activePaths = new Set();
      }
      emitNow();
    })(),
  ]);
  return assemble();
}
