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
import { discoverRepositoryScope, filterSessions, listSessions, loadSessionPreview, stripTerminalControls } from "../sessions.mjs";
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

function providerMenuText(providers, selectedIndex, activeProvider, width) {
  const maxWidth = Math.max(4, width - 8);
  return new StyledText(providers.flatMap((provider, index) => {
    const selected = index === selectedIndex;
    const active = provider === activeProvider;
    const label = provider === "all" ? "All" : displayText(provider);
    const background = selected ? COLORS.amberBackground : undefined;
    return [
      ...(index > 0 ? [chunk("\n", COLORS.text)] : []),
      chunk(selected ? "› " : "  ", COLORS.amber, background),
      chunk(active ? "● " : "  ", active ? COLORS.amber : COLORS.meta, background),
      chunk(truncateText(label, maxWidth), provider === "all" ? COLORS.text : providerColor(provider), background, selected),
    ];
  }));
}

function wrapPreviewText(value, maxWidth, maxLines) {
  let remaining = displayText(value);
  const lines = [];
  while (remaining && lines.length < maxLines) {
    if (Bun.stringWidth(remaining) <= maxWidth) {
      lines.push(remaining);
      remaining = "";
      break;
    }
    if (lines.length === maxLines - 1) {
      lines.push(truncateText(remaining, maxWidth));
      break;
    }
    let width = 0;
    let end = 0;
    let lastSpace = -1;
    for (const character of remaining) {
      const characterWidth = Bun.stringWidth(character);
      if (width + characterWidth > maxWidth) break;
      width += characterWidth;
      end += character.length;
      if (/\s/.test(character)) lastSpace = end;
    }
    const cut = lastSpace > Math.floor(end / 2) ? lastSpace : end;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return lines.length > 0 ? lines : ["—"];
}

function previewMinimumRows(indices) {
  let gaps = 0;
  for (let index = 1; index < indices.length; index += 1) {
    if (indices[index] - indices[index - 1] > 1) gaps += 1;
  }
  return indices.length * 2 + gaps;
}

function previewTurnIndices(turnCount, rowBudget) {
  if (turnCount <= 0) return [];
  if (turnCount * 2 <= rowBudget) return Array.from({ length: turnCount }, (_, index) => index);
  const visibleCount = Math.max(2, Math.floor((rowBudget - 1) / 2));
  const firstCount = Math.ceil(visibleCount / 2);
  const lastCount = Math.floor(visibleCount / 2);
  return [
    ...Array.from({ length: firstCount }, (_, index) => index),
    ...Array.from({ length: lastCount }, (_, index) => turnCount - lastCount + index),
  ];
}

function previewText(session, width, height, t) {
  const maxWidth = Math.max(8, width - 4);
  const turns = Array.isArray(session.preview?.turns) ? session.preview.turns.filter((turn) => turn?.user) : [];
  const chunks = [chunk(truncateText(displayText(session.title), maxWidth), COLORS.text, undefined, true)];
  if (turns.length === 0) {
    chunks.push(chunk(`\n${t("sessionsPreviewEmpty")}`, COLORS.meta));
    return new StyledText(chunks);
  }
  const rowBudget = Math.max(2, height - 5);
  const indices = previewTurnIndices(turns.length, rowBudget);
  let remainingRows = rowBudget - previewMinimumRows(indices);
  let previousIndex = null;
  for (const index of indices) {
    if (previousIndex !== null && index - previousIndex > 1) {
      chunks.push(chunk(`\n${t("sessionsPreviewOmitted", { count: index - previousIndex - 1 })}`, COLORS.meta, undefined, true));
    }
    const pair = turns[index];
    const userLines = wrapPreviewText(pair.user, maxWidth - 2, remainingRows > 0 ? 2 : 1);
    if (userLines.length > 1) remainingRows -= 1;
    const assistantLines = wrapPreviewText(pair.assistant || "—", maxWidth - 2, remainingRows > 0 ? 2 : 1);
    if (assistantLines.length > 1) remainingRows -= 1;
    chunks.push(
      chunk("\nU ", COLORS.amber, undefined, true),
      chunk(userLines[0], COLORS.text),
      ...(userLines.slice(1).flatMap((line) => [chunk("\n  ", COLORS.meta), chunk(line, COLORS.text)])),
      chunk("\nA ", COLORS.rose, undefined, true),
      chunk(assistantLines[0], COLORS.text),
      ...(assistantLines.slice(1).flatMap((line) => [chunk("\n  ", COLORS.meta), chunk(line, COLORS.text)])),
    );
    previousIndex = index;
  }
  return new StyledText(chunks);
}

export async function runSessionBrowser({
  rendererFactory = createCliRenderer,
  cwd = process.cwd(),
  onSelect = async () => 0,
  language = process.env.LANG,
  now = Date.now,
  clock = globalThis,
  discoverScope = discoverRepositoryScope,
  sessionLoader = ({ scope, roots }) => listSessions({
    cwd,
    scope,
    repositoryRoots: scope === "repo" ? roots : undefined,
  }),
  previewLoader = loadSessionPreview,
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
    let showProviderMenu = false;
    let showPreview = false;
    let previewLoading = false;
    let previewError = null;
    let previewGeneration = 0;
    let providerMenuIndex = 0;
    let providerViewportStart = 0;
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
      height: 1,
      selectable: true,
    });
    const filters = new TextRenderable(renderer, {
      content: "",
      fg: "#94A3B8",
      height: 1,
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
      maxHeight: 3,
      flexShrink: 0,
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
      const loading = state === "initializing" || state === "loading" || previewLoading;
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
      if (showProviderMenu) {
        const providers = availableProviders();
        providerMenuIndex = Math.max(0, Math.min(providerMenuIndex, providers.length - 1));
        const providerVisibleRows = Math.max(1, renderer.height - 4);
        if (providerMenuIndex < providerViewportStart) providerViewportStart = providerMenuIndex;
        if (providerMenuIndex >= providerViewportStart + providerVisibleRows) providerViewportStart = providerMenuIndex - providerVisibleRows + 1;
        providerViewportStart = Math.max(0, Math.min(providerViewportStart, Math.max(0, providers.length - providerVisibleRows)));
        title.content = t("sessionsProviderMenuTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        hint.content = t("sessionsProviderMenuHint");
        list.content = providerMenuText(providers.slice(providerViewportStart, providerViewportStart + providerVisibleRows), providerMenuIndex - providerViewportStart, provider, renderer.width);
        list.fg = COLORS.text;
        renderer.requestRender();
        return;
      }
      if (showPreview) {
        const values = filteredSessions();
        title.content = t("sessionsPreviewTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        hint.content = t("sessionsPreviewHint");
        list.content = previewLoading
          ? `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsPreviewLoading")}`
          : previewError
            ? `${t("sessionsPreviewLoadFailed")}: ${previewError.message}`
            : values[selectedIndex] ? previewText(values[selectedIndex], renderer.width, renderer.height, t) : "";
        list.fg = previewError ? "#F87171" : previewLoading ? COLORS.chip : COLORS.text;
        renderer.requestRender();
        return;
      }
      if (showHelp) {
        title.content = t("sessionsHelpTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        hint.content = "";
        list.content = t("sessionsHelp");
        list.fg = COLORS.text;
        renderer.requestRender();
        return;
      }
      title.content = t("sessionsTitle");
      title.visible = true;
      filters.visible = true;
      if (state === "initializing") {
        list.content = `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsInitializing")}`;
        list.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      if (state === "loading") {
        list.content = `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsLoading")}`;
        list.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      if (state === "error") {
        list.content = error?.message ? `${t("sessionsLoadFailed")}: ${error.message}` : t("sessionsLoadFailed");
        list.fg = "#F87171";
        renderer.requestRender();
        return;
      }
      const values = filteredSessions();
      keepSelection(values);
      if (values.length === 0) {
        list.content = scope === "repo" ? t("sessionsEmptyRepo") : t("sessionsEmptyAll");
        list.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      const count = visibleRows();
      list.content = joinStyledText(values.slice(viewportStart, viewportStart + count)
        .map((session, index) => rowText(session, viewportStart + index === selectedIndex, language, renderer.width, compact)));
      list.fg = "#E2E8F0";
      renderer.requestRender();
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
        if (!providers.includes(provider)) {
          provider = "all";
          providerMenuIndex = 0;
        }
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
        if (showPreview) {
          previewGeneration += 1;
          showPreview = false;
          render();
        } else if (showProviderMenu) {
          showProviderMenu = false;
          render();
        } else if (showHelp) {
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
        if (showPreview) {
          previewGeneration += 1;
          showPreview = false;
          render();
          return;
        }
        if (showProviderMenu) {
          showProviderMenu = false;
          render();
          return;
        }
        if (showHelp) {
          showHelp = false;
          render();
          return;
        }
        finish(0);
        return;
      }
      if (showPreview) {
        if (event.name === "space") {
          previewGeneration += 1;
          showPreview = false;
          render();
        }
        return;
      }
      if (showProviderMenu) {
        const providers = availableProviders();
        if (event.name === "p") {
          showProviderMenu = false;
          render();
        } else if (["up", "k"].includes(event.name)) {
          providerMenuIndex = Math.max(0, providerMenuIndex - 1);
          render();
        } else if (["down", "j"].includes(event.name)) {
          providerMenuIndex = Math.min(providers.length - 1, providerMenuIndex + 1);
          render();
        } else if (event.name === "home") {
          providerMenuIndex = 0;
          render();
        } else if (event.name === "end") {
          providerMenuIndex = providers.length - 1;
          render();
        } else if (event.name === "return") {
          provider = providers[providerMenuIndex] ?? "all";
          showProviderMenu = false;
          providerViewportStart = 0;
          selectedIndex = 0;
          viewportStart = 0;
          selectedKey = null;
          render();
        }
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
        const providers = availableProviders();
        providerMenuIndex = Math.max(0, providers.indexOf(provider));
        showProviderMenu = true;
        render();
        return;
      }
      if (event.name === "space") {
        const values = filteredSessions();
        const session = values[selectedIndex];
        if (!session) return;
        showPreview = true;
        previewError = null;
        if (Array.isArray(session.preview?.turns) && session.preview.turns.length > 0 || !session.previewLocator) {
          previewLoading = false;
          render();
          return;
        }
        previewLoading = true;
        const requestGeneration = ++previewGeneration;
        render();
        Promise.resolve(previewLoader(session)).then((preview) => {
          if (cleaned || requestGeneration !== previewGeneration) return;
          session.preview = preview;
          delete session.previewLocator;
          previewLoading = false;
          render();
        }, (previewLoadError) => {
          if (cleaned || requestGeneration !== previewGeneration) return;
          previewLoading = false;
          previewError = previewLoadError;
          render();
        });
        return;
      }
      if (event.name === "return") {
        const values = filteredSessions();
        const session = values[selectedIndex];
        if (!session) return;
        cleanup();
        Promise.resolve().then(() => onSelect(session)).then(resolveResult, rejectResult);
        return;
      }
      if (["up", "down", "j", "k", "pageup", "pagedown", "home", "end"].includes(event.name)) {
        const delta = event.name === "down" || event.name === "j" ? 1 : -1;
        if (event.name === "home") select(0);
        else if (event.name === "end") select(filteredSessions().length - 1);
        else if (["pageup", "pagedown"].includes(event.name)) {
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
