import path from "node:path";
import {
  BoxRenderable,
  StyledText,
  TextAttributes,
  TextRenderable,
  bg,
  bold,
  fg,
  createCliRenderer,
} from "@opentui/core";
import { discoverRepositoryScope, filterSessions, listSessions, stripTerminalControls } from "../sessions.mjs";
import { loadMenuTranslator } from "./menu.mjs";

const AGENTS = ["all", "codex", "claude"];
const COMPACT_WIDTH = 60;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const COLORS = {
  amber: "#FBBF24",
  amberBackground: "#271708",
  rose: "#FB7185",
  text: "#E2E8F0",
  meta: "#64748B",
  chip: "#94A3B8",
};
const PROVIDER_COLORS = ["#6EE7B7", "#60A5FA", "#C084FC", "#2DD4BF", "#F472B6", "#A3E635"];

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

function providerColor(provider) {
  let hash = 0;
  for (const character of provider) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return PROVIDER_COLORS[hash % PROVIDER_COLORS.length];
}

function agentColor(agent) {
  if (agent === "CODEX") return COLORS.amber;
  if (agent === "CLAUDE") return COLORS.rose;
  return COLORS.text;
}

function chunk(text, color, background, isBold = false) {
  let value = String(text);
  if (color) value = fg(color)(value);
  if (background) value = bg(background)(value);
  if (isBold) value = bold(value);
  return value;
}

function rowText(session, selected, language, width, compact) {
  const agent = displayText(session.agent).toUpperCase();
  const provider = truncateText(displayText(session.provider), compact ? 12 : 24);
  const sourceWidth = Bun.stringWidth(agent) + (provider ? Bun.stringWidth(` · ${provider}`) : 0);
  const rowWidth = Math.max(1, width - 3);
  const metaPrefix = "  └ ";
  const location = truncateText(displayText(path.basename(session.cwd) || session.cwd), rowWidth - Bun.stringWidth(metaPrefix));
  const time = timestampLabel(session.updatedAt, language);
  const meta = compact ? location : [location, time].filter(Boolean).join(" · ");
  const titleLimit = Math.max(4, rowWidth - sourceWidth - 4);
  const title = truncateText(displayText(session.title), titleLimit);
  const background = selected ? COLORS.amberBackground : undefined;
  const providerChunk = provider
    ? [
        chunk(" · ", COLORS.text, background),
        chunk(provider, providerColor(provider), background),
      ]
    : [];
  const firstLineWidth = 2 + sourceWidth + 2 + Bun.stringWidth(title);
  const metaLineWidth = Bun.stringWidth(metaPrefix) + Bun.stringWidth(meta);
  return new StyledText([
    chunk(selected ? "›" : " ", COLORS.amber, background),
    chunk(" ", COLORS.text, background),
    chunk(agent, agentColor(agent), background, true),
    ...providerChunk,
    chunk("  ", COLORS.text, background),
    chunk(title, COLORS.text, background),
    chunk(" ".repeat(Math.max(0, rowWidth - firstLineWidth)), COLORS.text, background),
    chunk(`\n${metaPrefix}`, COLORS.meta, background),
    chunk(meta, COLORS.meta, background),
    chunk(" ".repeat(Math.max(0, rowWidth - metaLineWidth)), COLORS.meta, background),
  ]);
}

function joinStyledText(values, separator = "\n") {
  return new StyledText(values.flatMap((value, index) => [
    ...(index > 0 ? [chunk(separator, COLORS.text)] : []),
    ...value.chunks,
  ]));
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
  let noticeTimer = null;
  const abortController = new AbortController();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    abortController.abort();
    if (spinnerTimer !== null) clock.clearInterval(spinnerTimer);
    spinnerTimer = null;
    if (noticeTimer !== null) (clock.clearTimeout ?? globalThis.clearTimeout)(noticeTimer);
    noticeTimer = null;
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
    let showHelp = false;
    let notice = "";

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

    const visibleRows = () => Math.max(1, Math.floor((renderer.height - 6) / 2));
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
      const compact = renderer.width <= COMPACT_WIDTH;
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
      filters.content = new StyledText([
        chunk(`[s ${scope}]`, COLORS.amber, undefined, true),
        chunk(" ", COLORS.chip),
        chunk(`[a ${agent}]`, COLORS.chip),
        chunk(" ", COLORS.chip),
        chunk(`[p ${truncateText(displayText(provider), compact ? 12 : 24)}]`, COLORS.chip),
      ]);
      hint.content = notice || (compact ? t("sessionsCompactHint") : t("sessionsHint"));
      if (showHelp) {
        title.content = t("sessionsHelpTitle");
        filters.content = "";
        filters.visible = true;
        hint.content = "";
        list.content = t("sessionsHelp");
        list.fg = COLORS.text;
        return;
      }
      title.content = t("sessionsTitle");
      filters.visible = true;
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
      list.content = joinStyledText(values.slice(viewportStart, viewportStart + count)
        .map((session, index) => rowText(session, viewportStart + index === selectedIndex, language, renderer.width, compact)));
      list.fg = "#E2E8F0";
    };

    const clearNotice = () => {
      notice = "";
      if (noticeTimer !== null) (clock.clearTimeout ?? globalThis.clearTimeout)(noticeTimer);
      noticeTimer = null;
    };
    const showNotice = (message) => {
      clearNotice();
      notice = message;
      render();
      noticeTimer = (clock.setTimeout ?? globalThis.setTimeout)(() => {
        noticeTimer = null;
        notice = "";
        if (!cleaned) render();
      }, 1_000);
    };
    const select = (index) => {
      const values = filteredSessions();
      selectedIndex = Math.max(0, Math.min(Math.max(0, values.length - 1), index));
      selectedKey = values[selectedIndex] ? sessionKey(values[selectedIndex]) : null;
      render();
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
        else {
          lastCtrlC = timestamp;
          showNotice(t("sessionsCtrlCExitPrompt"));
        }
        return;
      }
      if (event.name === "escape") {
        if (showHelp) {
          showHelp = false;
          render();
        } else if (lastEscape !== null && timestamp - lastEscape <= 1_000) finish(130);
        else {
          lastEscape = timestamp;
          showNotice(t("sessionsEscapeExitPrompt"));
        }
        return;
      }
      clearNotice();
      if (event.name === "?") {
        showHelp = !showHelp;
        render();
        return;
      }
      if (event.name === "backspace") {
        if (showHelp) {
          showHelp = false;
          render();
          return;
        }
        finish(0);
        return;
      }
      if (showHelp) return;
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
      if (["up", "down", "j", "k", "pageup", "pagedown", "space", "home", "end"].includes(event.name)) {
        const delta = event.name === "down" || event.name === "j" ? 1 : -1;
        if (event.name === "home") select(0);
        else if (event.name === "end") select(filteredSessions().length - 1);
        else if (["pageup", "pagedown", "space"].includes(event.name)) {
          const direction = event.name === "pageup" ? -1 : 1;
          select(selectedIndex + direction * visibleRows());
        } else select(selectedIndex + delta);
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
