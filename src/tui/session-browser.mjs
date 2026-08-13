import path from "node:path";
import { BoxRenderable, TextAttributes, TextRenderable, createCliRenderer } from "@opentui/core";
import { discoverRepositoryScope, filterSessions, listSessions, stripTerminalControls } from "../sessions.mjs";
import { loadMenuTranslator } from "./menu.mjs";

const AGENTS = ["all", "codex", "claude"];
const COMPACT_WIDTH = 60;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

function nextValue(values, current) {
  return values[(Math.max(0, values.indexOf(current)) + 1) % values.length];
}

function timestampLabel(value, language) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(language?.toLowerCase().startsWith("ko") ? "ko" : "en", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function sessionKey(session) {
  return `${session.agent}:${session.provider ?? ""}:${session.id}`;
}

function displayText(value) {
  return stripTerminalControls(value).trim();
}

function truncateText(value, maxWidth) {
  if (Bun.stringWidth(value) <= maxWidth) return value;
  let width = 1;
  let output = "";
  for (const character of value) {
    const characterWidth = Bun.stringWidth(character);
    if (width + characterWidth > maxWidth) break;
    output += character;
    width += characterWidth;
  }
  return `${output}…`;
}

function rowText(session, selected, language, width) {
  const agent = displayText(session.agent).toUpperCase();
  const provider = displayText(session.provider);
  const source = provider ? `${agent} · ${provider}` : agent;
  const location = displayText(path.basename(session.cwd) || session.cwd);
  const time = timestampLabel(session.updatedAt, language);
  const meta = [location, time].filter(Boolean).join(" · ");
  const titleLimit = Math.max(16, width - Bun.stringWidth(source) - 8);
  const title = truncateText(displayText(session.title), titleLimit);
  return `${selected ? "›" : " "} ${source}  ${title}\n+  ${meta}`;
}

export async function runSessionBrowser({
  rendererFactory = createCliRenderer,
  cwd = process.cwd(),
  language = process.env.LANG,
  now = Date.now,
  clock = globalThis,
  discoverScope = discoverRepositoryScope,
  sessionLoader = ({ scope, roots }) => listSessions({
    cwd,
    scope,
    repositoryRoots: scope === "repo" ? roots : undefined,
  }),
  sessionFilter = filterSessions,
} = {}) {
  let renderer;
  let keyHandler;
  let resizeHandler;
  let settled = false;
  let cleaned = false;
  let generation = 0;
  let spinnerIndex = 0;
  let spinnerTimer = null;
  const abortController = new AbortController();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    abortController.abort();
    if (spinnerTimer !== null) clock.clearInterval(spinnerTimer);
    spinnerTimer = null;
    if (renderer && keyHandler) renderer.keyInput.off("keypress", keyHandler);
    if (renderer && resizeHandler) renderer.off("resize", resizeHandler);
    renderer?.destroy();
  };

  try {
    const setup = await rendererFactory({
      backgroundColor: "#000000",
      screenMode: "alternate-screen",
      exitOnCtrlC: false,
      exitSignals: ["SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGBREAK", "SIGPIPE", "SIGBUS"],
      useMouse: true,
    });
    renderer = setup?.renderer ?? setup;
    const t = await loadMenuTranslator(language);
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(code);
    };

    let state = "initializing";
    let roots = [];
    let sessions = [];
    const sessionCache = new Map();
    let error = null;
    let scope = "repo";
    let agent = "all";
    let provider = "all";
    let selectedIndex = 0;
    let selectedKey = null;
    let viewportStart = 0;

    const root = new BoxRenderable(renderer, {
      backgroundColor: "#000000",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
    });
    const title = new TextRenderable(renderer, {
      content: t("sessionsTitle"),
      fg: "#67E8F9",
      attributes: TextAttributes.BOLD,
      selectable: true,
    });
    const filters = new TextRenderable(renderer, {
      content: "",
      fg: "#94A3B8",
      selectable: true,
    });
    const list = new TextRenderable(renderer, {
      content: "",
      fg: "#E2E8F0",
      flexGrow: 1,
      selectable: true,
    });
    const hint = new TextRenderable(renderer, {
      content: "",
      fg: "#64748B",
      selectable: true,
    });
    root.add(title);
    root.add(filters);
    root.add(list);
    root.add(hint);
    renderer.root.add(root);

    const visibleRows = () => Math.max(1, Math.floor((renderer.height - (renderer.width <= COMPACT_WIDTH ? 8 : 6)) / 2));
    const availableProviders = () => [
      "all",
      ...new Set(sessions.map((session) => session.provider).filter(Boolean).sort()),
    ];
    const filteredSessions = () => sessionFilter(sessions, { scope, roots, agent, provider });
    const keepSelection = (values) => {
      if (selectedKey) {
        const restored = values.findIndex((session) => sessionKey(session) === selectedKey);
        if (restored >= 0) selectedIndex = restored;
      }
      selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, values.length - 1)));
      selectedKey = values[selectedIndex] ? sessionKey(values[selectedIndex]) : null;
      const count = visibleRows();
      if (selectedIndex < viewportStart) viewportStart = selectedIndex;
      if (selectedIndex >= viewportStart + count) viewportStart = selectedIndex - count + 1;
      viewportStart = Math.max(0, Math.min(viewportStart, Math.max(0, values.length - count)));
    };
    const render = () => {
      const loading = state === "initializing" || state === "loading";
      if (loading && spinnerTimer === null) {
        // ASCII frames stay aligned in terminals that calculate emoji width differently.
        spinnerTimer = clock.setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
          if (!cleaned) render();
        }, 100);
      } else if (!loading && spinnerTimer !== null) {
        clock.clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      filters.content = [
        t("sessionsScope", { value: scope === "repo" ? t("sessionsCurrentRepo") : t("sessionsAllDirectories") }),
        t("sessionsAgent", { value: agent === "all" ? t("sessionsAll") : agent === "codex" ? "Codex" : t("claude") }),
        t("sessionsProvider", { value: provider === "all" ? t("sessionsAll") : displayText(provider) }),
      ].join("  ·  ");
      hint.content = renderer.width <= COMPACT_WIDTH ? t("sessionsCompactHint") : t("sessionsHint");
      if (state === "initializing") {
        list.content = `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsInitializing")}`;
        list.fg = "#94A3B8";
        return;
      }
      if (state === "loading") {
        list.content = `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsLoading")}`;
        list.fg = "#94A3B8";
        return;
      }
      if (state === "error") {
        list.content = error?.message ? `${t("sessionsLoadFailed")}: ${error.message}` : t("sessionsLoadFailed");
        list.fg = "#F87171";
        return;
      }
      const values = filteredSessions();
      keepSelection(values);
      if (values.length === 0) {
        list.content = scope === "repo" ? t("sessionsEmptyRepo") : t("sessionsEmptyAll");
        list.fg = "#94A3B8";
        return;
      }
      const count = visibleRows();
      list.content = values.slice(viewportStart, viewportStart + count)
        .map((session, index) => rowText(session, viewportStart + index === selectedIndex, language, renderer.width))
        .join("\n");
      list.fg = "#E2E8F0";
    };

    const load = async (requestedScope = scope, { refresh = false } = {}) => {
      const currentGeneration = ++generation;
      if (!refresh && sessionCache.has(requestedScope)) {
        sessions = sessionCache.get(requestedScope);
        state = "ready";
        render();
        return;
      }
      state = "loading";
      sessions = [];
      error = null;
      render();
      try {
        const loaded = await sessionLoader({ cwd, roots, scope: requestedScope, signal: abortController.signal });
        if (cleaned || currentGeneration !== generation) return;
        sessions = Array.isArray(loaded) ? loaded : [];
        sessionCache.set(requestedScope, sessions);
        state = "ready";
        const providers = availableProviders();
        if (!providers.includes(provider)) provider = "all";
        render();
      } catch (loadError) {
        if (cleaned || currentGeneration !== generation) return;
        state = "error";
        error = loadError;
        render();
      }
    };
    const initialize = async () => {
      render();
      try {
        const discovered = await discoverScope(cwd, { signal: abortController.signal });
        if (cleaned) return;
        roots = Array.isArray(discovered) ? discovered : discovered?.roots ?? [];
        await load(scope);
      } catch (scopeError) {
        if (cleaned) return;
        state = "error";
        error = scopeError;
        render();
      }
    };

    resizeHandler = () => render();
    renderer.on("resize", resizeHandler);
    let lastCtrlC = null;
    let lastEscape = null;
    keyHandler = (event) => {
      if (settled || event.eventType !== "press") return;
      const timestamp = now();
      if (event.ctrl && event.name === "c") {
        if (lastCtrlC !== null && timestamp - lastCtrlC <= 1_000) finish(130);
        else lastCtrlC = timestamp;
        return;
      }
      if (event.name === "escape") {
        if (lastEscape !== null && timestamp - lastEscape <= 1_000) finish(130);
        else lastEscape = timestamp;
        return;
      }
      if (event.name === "backspace") {
        finish(0);
        return;
      }
      if (event.name === "r") {
        sessionCache.delete(scope);
        void load(scope, { refresh: true });
        return;
      }
      if (event.name === "s") {
        scope = scope === "repo" ? "all" : "repo";
        selectedIndex = 0;
        viewportStart = 0;
        selectedKey = null;
        void load(scope);
        return;
      }
      if (state !== "ready") return;
      if (event.name === "a") {
        agent = nextValue(AGENTS, agent);
        selectedIndex = 0;
        viewportStart = 0;
        selectedKey = null;
        render();
        return;
      }
      if (event.name === "p") {
        provider = nextValue(availableProviders(), provider);
        selectedIndex = 0;
        viewportStart = 0;
        selectedKey = null;
        render();
        return;
      }
      if (["up", "down", "j", "k"].includes(event.name)) {
        const values = filteredSessions();
        const delta = event.name === "down" || event.name === "j" ? 1 : -1;
        selectedIndex = Math.max(0, Math.min(values.length - 1, selectedIndex + delta));
        selectedKey = values[selectedIndex] ? sessionKey(values[selectedIndex]) : null;
        render();
      }
    };
    renderer.keyInput.on("keypress", keyHandler);
    void initialize().catch((initializeError) => {
      if (!cleaned) rejectResult(initializeError);
    });
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}
