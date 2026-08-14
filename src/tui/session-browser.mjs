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
import { convertCodexSessionProviders, discoverRepositoryScope, filterSessions, listSessions, loadSessionDetails, loadSessionPreview, stripTerminalControls } from "../sessions.mjs";
import { loadMenuTranslator } from "./menu.mjs";

const AGENTS = ["all", "codex", "claude"];
const COMPACT_WIDTH = 60;
const PREVIEW_RAIL_WIDTH = 22;
const EXACT_TIME_AFTER_MS = 3 * 60 * 60_000;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const COLORS = {
  amber: "#FBBF24",
  amberBackground: "#271708",
  rose: "#FB7185",
  blue: "#60A5FA",
  green: "#6EE7B7",
  text: "#E2E8F0",
  meta: "#64748B",
  chip: "#94A3B8",
};
const PROVIDER_COLORS = ["#6EE7B7", "#60A5FA", "#C084FC", "#2DD4BF", "#F472B6", "#A3E635"];

function nextValue(values, current) {
  return values[(Math.max(0, values.indexOf(current)) + 1) % values.length];
}

function timestampLabel(value, language, currentTime) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const age = currentTime - value;
  if (age >= EXACT_TIME_AFTER_MS) {
    const timestamp = new Date(value);
    const twoDigits = (part) => String(part).padStart(2, "0");
    const time = `${twoDigits(timestamp.getHours())}:${twoDigits(timestamp.getMinutes())}`;
    // Session dates follow the user's local day, including its midnight boundary.
    const today = new Date(currentTime);
    today.setHours(0, 0, 0, 0);
    if (value >= today.getTime()) return time;
    return `${timestamp.getFullYear()}-${twoDigits(timestamp.getMonth() + 1)}-${twoDigits(timestamp.getDate())} ${time}`;
  }
  const locale = language?.toLowerCase().startsWith("ko") ? "ko" : "en";
  const delta = value - currentTime;
  const absolute = Math.abs(delta);
  let unit = "second";
  let divisor = 1_000;
  if (absolute >= 365 * 86_400_000) [unit, divisor] = ["year", 365 * 86_400_000];
  else if (absolute >= 30 * 86_400_000) [unit, divisor] = ["month", 30 * 86_400_000];
  else if (absolute >= 86_400_000) [unit, divisor] = ["day", 86_400_000];
  else if (absolute >= 3_600_000) [unit, divisor] = ["hour", 3_600_000];
  else if (absolute >= 60_000) [unit, divisor] = ["minute", 60_000];
  const amount = Math.round(delta / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }).format(amount, unit);
}

function fileSizeLabel(value, language) {
  if (!Number.isFinite(value) || value < 0) return "";
  const locale = language?.toLowerCase().startsWith("ko") ? "ko" : "en";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit > 0 && size < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(size)} ${units[unit]}`;
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

export function resumeProviders(sessions) {
  const discovered = [...new Set(
    sessions
      .filter((session) => session.agent === "codex")
      .map((session) => session.provider)
      .filter(Boolean),
  )].sort();
  return [...new Set(["zgap", "openai", ...discovered])];
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

function rowText(session, detailsState, selected, language, width, compact, currentTime, t) {
  const agent = displayText(session.agent).toUpperCase();
  const provider = truncateText(displayText(session.provider), compact ? 12 : 24);
  const sourceWidth = Bun.stringWidth(agent) + (provider ? Bun.stringWidth(` · ${provider}`) : 0);
  const rowWidth = Math.max(1, width - 3);
  const metaPrefix = "  └ ";
  const time = timestampLabel(session.updatedAt, language, currentTime);
  const turnCount = Number.isSafeInteger(detailsState?.turnCount)
    ? compact ? `${detailsState.turnCount}t` : t("sessionsTurnCount", { count: detailsState.turnCount })
    : detailsState?.error ? t("sessionsDetailsUnavailable") : "…";
  const fileSize = Number.isFinite(detailsState?.fileSize) ? fileSizeLabel(detailsState.fileSize, language) : "…";
  const detailParts = [
    time && { text: time, color: COLORS.blue },
    turnCount && { text: turnCount, color: COLORS.amber },
    fileSize && { text: fileSize, color: COLORS.green },
  ].filter(Boolean);
  const details = [];
  let detailsWidth = 0;
  for (const part of detailParts) {
    const nextWidth = detailsWidth + (details.length ? 3 : 0) + Bun.stringWidth(part.text);
    if (nextWidth > rowWidth - Bun.stringWidth(metaPrefix) - 4) break;
    details.push(part);
    detailsWidth = nextWidth;
  }
  const locationLimit = Math.max(0, rowWidth - Bun.stringWidth(metaPrefix) - detailsWidth - (details.length ? 3 : 0));
  const location = locationLimit >= 4
    ? truncateText(displayText(path.basename(session.cwd) || session.cwd), locationLimit)
    : "";
  const metaParts = [location && { text: location, color: COLORS.meta }, ...details].filter(Boolean);
  const titleLimit = Math.max(4, rowWidth - sourceWidth - 6);
  const title = truncateText(displayText(session.title), titleLimit);
  const background = selected ? COLORS.amberBackground : undefined;
  const providerChunk = provider
    ? [
        chunk(" · ", COLORS.text, background),
        chunk(provider, providerColor(provider), background),
      ]
    : [];
  const firstLineWidth = 4 + sourceWidth + 2 + Bun.stringWidth(title);
  const metaLineWidth = Bun.stringWidth(metaPrefix)
    + metaParts.reduce((total, part) => total + Bun.stringWidth(part.text), 0)
    + Math.max(0, metaParts.length - 1) * 3;
  return new StyledText([
    chunk(selected ? "›" : " ", COLORS.amber, background),
    chunk(" ", COLORS.text, background),
    chunk(session.active ? "● " : "  ", session.active ? COLORS.green : COLORS.meta, background),
    chunk(agent, agentColor(agent), background, true),
    ...providerChunk,
    chunk("  ", COLORS.text, background),
    chunk(title, COLORS.text, background),
    chunk(" ".repeat(Math.max(0, rowWidth - firstLineWidth)), COLORS.text, background),
    chunk(`\n${metaPrefix}`, COLORS.meta, background),
    ...metaParts.flatMap((part, index) => [
      ...(index > 0 ? [chunk(" · ", COLORS.meta, background)] : []),
      chunk(part.text, part.color, background),
    ]),
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

function providerConvertText(providers, selectedIndex, count, width, t) {
  const menu = providerMenuText(providers, selectedIndex, "", width);
  return new StyledText([
    chunk(t("sessionsProviderConvertCount", { count }), COLORS.amber, undefined, true),
    chunk("\n\n", COLORS.text),
    ...menu.chunks,
  ]);
}

function previewProviderText(providers, selectedIndex, activeProvider, width, t, viewportStart = 0, visibleRows = providers.length) {
  const maxWidth = Math.max(4, width - 4);
  const lines = [chunk(t("sessionsPreviewProviderTitle"), COLORS.text, undefined, true)];
  const end = Math.min(providers.length, viewportStart + visibleRows);
  for (let index = viewportStart; index < end; index += 1) {
    const provider = providers[index];
    const selected = index === selectedIndex;
    const saved = provider === activeProvider;
    const background = selected ? COLORS.amberBackground : undefined;
    const suffix = saved ? ` · ${t("sessionsPreviewProviderSaved")}` : "";
    lines.push(
      chunk("\n", COLORS.text, background),
      chunk(selected ? "› " : "  ", COLORS.amber, background),
      chunk(truncateText(displayText(provider), Math.max(1, maxWidth - Bun.stringWidth(suffix))), providerColor(provider), background, selected),
      chunk(suffix, saved ? COLORS.green : COLORS.text, background),
    );
  }
  return new StyledText(lines);
}

function previewProviderCompactText(providers, selectedIndex, activeProvider, width, t) {
  const provider = providers[selectedIndex] ?? "zgap";
  const saved = activeProvider ? ` · ${t("sessionsPreviewProviderSaved")}: ${displayText(activeProvider)}` : "";
  return new StyledText([
    chunk(truncateText(t("sessionsPreviewProviderCompact", {
      current: selectedIndex + 1,
      count: providers.length,
      provider: displayText(provider),
    }) + saved, Math.max(4, width)), COLORS.text, "#071018", true),
  ]);
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

function previewText(session, width, height, t, { compact = false } = {}) {
  const maxWidth = Math.max(8, width - 4);
  const turns = Array.isArray(session.preview?.turns) ? session.preview.turns.filter((turn) => turn?.user) : [];
  const chunks = compact && turns.length > 0
    ? []
    : [chunk(truncateText(displayText(session.title), maxWidth), COLORS.text, undefined, true)];
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
      chunks.push(chunk(`${chunks.length ? "\n" : ""}${t("sessionsPreviewOmitted", { count: index - previousIndex - 1 })}`, COLORS.meta, undefined, true));
    }
    const pair = turns[index];
    const userLines = wrapPreviewText(pair.user, maxWidth - 2, remainingRows > 0 ? 2 : 1);
    if (userLines.length > 1) remainingRows -= 1;
    const assistantLines = wrapPreviewText(pair.assistant || "—", maxWidth - 2, remainingRows > 0 ? 2 : 1);
    if (assistantLines.length > 1) remainingRows -= 1;
    chunks.push(
      chunk(`${chunks.length ? "\n" : ""}U `, COLORS.amber, undefined, true),
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
  detailsLoader = loadSessionDetails,
  sessionFilter = filterSessions,
  providerConverter = convertCodexSessionProviders,
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
    const detailCache = new WeakMap();
    const detailRequests = new WeakMap();
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
    let previewProviders = [];
    let previewProviderIndex = 0;
    let previewProviderViewportStart = 0;
    let previewBodyCompact = null;
    let providerMenuIndex = 0;
    let providerViewportStart = 0;
    let showProviderConvert = false;
    let providerConvertSource = "";
    let providerConvertTargets = [];
    let providerConvertIndex = 0;
    let providerConvertViewportStart = 0;
    let providerConvertSessions = [];
    let providerConvertLoading = false;
    let providerConvertError = null;
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
    const previewBody = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      visible: false,
    });
    const previewContent = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      selectable: true,
    });
    const previewRail = new TextRenderable(renderer, {
      content: "",
      width: PREVIEW_RAIL_WIDTH,
      flexShrink: 0,
      bg: "#071018",
      selectable: true,
    });
    previewBody.add(previewContent);
    previewBody.add(previewRail);
    root.add(title);
    root.add(filters);
    root.add(list);
    root.add(previewBody);
    root.add(hint);
    renderer.root.add(root);

    const visibleRows = () => Math.max(1, Math.floor((renderer.height - 6) / 2));
    const setPreviewOrder = (compact) => {
      if (previewBodyCompact === compact) return;
      previewBody.remove(previewContent);
      previewBody.remove(previewRail);
      if (compact) {
        previewBody.add(previewRail);
        previewBody.add(previewContent);
      } else {
        previewBody.add(previewContent);
        previewBody.add(previewRail);
      }
      previewBodyCompact = compact;
    };
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
      const loading = state === "initializing" || state === "loading" || previewLoading || providerConvertLoading;
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
      if (showProviderConvert) {
        providerConvertIndex = Math.max(0, Math.min(providerConvertIndex, providerConvertTargets.length - 1));
        const providerConvertVisibleRows = Math.max(1, renderer.height - 6);
        if (providerConvertIndex < providerConvertViewportStart) providerConvertViewportStart = providerConvertIndex;
        if (providerConvertIndex >= providerConvertViewportStart + providerConvertVisibleRows) {
          providerConvertViewportStart = providerConvertIndex - providerConvertVisibleRows + 1;
        }
        providerConvertViewportStart = Math.max(0, Math.min(
          providerConvertViewportStart,
          Math.max(0, providerConvertTargets.length - providerConvertVisibleRows),
        ));
        title.content = t("sessionsProviderConvertTitle", { source: displayText(providerConvertSource) });
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        previewBody.visible = false;
        list.visible = true;
        hint.maxHeight = 3;
        hint.content = providerConvertLoading
          ? `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsProviderConverting", { count: providerConvertSessions.length })}`
          : providerConvertError
            ? `${t("sessionsProviderConvertFailed")}: ${providerConvertError.message}`
            : t("sessionsProviderConvertHint");
        list.content = providerConvertText(
          providerConvertTargets.slice(providerConvertViewportStart, providerConvertViewportStart + providerConvertVisibleRows),
          providerConvertIndex - providerConvertViewportStart,
          providerConvertSessions.length,
          renderer.width,
          t,
        );
        list.fg = providerConvertError ? "#F87171" : COLORS.text;
        renderer.requestRender();
        return;
      }
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
        const session = values[selectedIndex];
        const previewSession = session && detailCache.get(session)?.preview
          ? { ...session, preview: detailCache.get(session).preview }
          : session;
        const codexPreview = session?.agent === "codex";
        setPreviewOrder(compact);
        previewBody.visible = true;
        previewBody.flexDirection = compact ? "column" : "row";
        previewContent.visible = true;
        previewRail.visible = codexPreview;
        previewRail.width = compact ? "100%" : PREVIEW_RAIL_WIDTH;
        previewRail.height = compact ? 1 : "100%";
        title.content = t("sessionsPreviewTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        hint.maxHeight = compact ? 1 : 3;
        hint.content = notice || (codexPreview ? t("sessionsPreviewCodexHint") : t("sessionsPreviewHint"));
        list.visible = false;
        const previewProviderVisibleRows = Math.max(1, renderer.height - 6);
        if (codexPreview && !compact) {
          if (previewProviderIndex < previewProviderViewportStart) previewProviderViewportStart = previewProviderIndex;
          if (previewProviderIndex >= previewProviderViewportStart + previewProviderVisibleRows) {
            previewProviderViewportStart = previewProviderIndex - previewProviderVisibleRows + 1;
          }
          previewProviderViewportStart = Math.max(0, Math.min(
            previewProviderViewportStart,
            Math.max(0, previewProviders.length - previewProviderVisibleRows),
          ));
        }
        previewRail.content = codexPreview
          ? compact
            ? previewProviderCompactText(previewProviders, previewProviderIndex, session.provider, renderer.width, t)
            : previewProviderText(previewProviders, previewProviderIndex, session.provider, PREVIEW_RAIL_WIDTH, t, previewProviderViewportStart, previewProviderVisibleRows)
          : "";
        previewContent.content = previewLoading
          ? `${SPINNER_FRAMES[spinnerIndex]} ${t("sessionsPreviewLoading")}`
          : previewError
            ? `${t("sessionsPreviewLoadFailed")}: ${previewError.message}`
            : previewSession
              ? previewText(previewSession, compact ? renderer.width : renderer.width - PREVIEW_RAIL_WIDTH, renderer.height, t, { compact })
              : "";
        previewContent.fg = previewError ? "#F87171" : previewLoading ? COLORS.chip : COLORS.text;
        renderer.requestRender();
        return;
      }
      previewBody.visible = false;
      list.visible = true;
      hint.maxHeight = 3;
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
      const visibleSessions = values.slice(viewportStart, viewportStart + count);
      list.content = joinStyledText(visibleSessions
        .map((session, index) => rowText(session, detailCache.get(session), viewportStart + index === selectedIndex, language, renderer.width, compact, now(), t)));
      list.fg = "#E2E8F0";
      renderer.requestRender();
      for (const session of visibleSessions) {
        if (detailCache.has(session) || detailRequests.has(session)) continue;
        const request = Promise.resolve(detailsLoader(session)).then((details) => {
          detailCache.set(session, {
            turnCount: Number.isSafeInteger(details?.turnCount) ? details.turnCount : 0,
            fileSize: Number.isFinite(details?.fileSize) ? details.fileSize : 0,
            preview: details?.preview,
          });
          if (!cleaned) render();
        }, () => {
          detailCache.set(session, { error: true });
          if (!cleaned) render();
        });
        detailRequests.set(session, request);
      }
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
        if (showProviderConvert) {
          if (providerConvertLoading) return;
          showProviderConvert = false;
          providerConvertError = null;
          render();
        } else if (showPreview) {
          previewGeneration += 1;
          showPreview = false;
          render();
        } else if (showProviderMenu) {
          showProviderMenu = false;
          render();
        } else if (showHelp) {
          showHelp = false;
          render();
        } else finish(0);
        return;
      }
      clearNotice();
      if (event.name === "?") {
        showHelp = !showHelp;
        render();
        return;
      }
      if (event.name === "backspace") {
        if (showProviderConvert) {
          if (providerConvertLoading) return;
          showProviderConvert = false;
          providerConvertError = null;
          render();
          return;
        }
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
      if (showProviderConvert) {
        if (providerConvertLoading) return;
        if (["up", "k"].includes(event.name)) {
          providerConvertIndex = Math.max(0, providerConvertIndex - 1);
          render();
        } else if (["down", "j"].includes(event.name)) {
          providerConvertIndex = Math.min(providerConvertTargets.length - 1, providerConvertIndex + 1);
          render();
        } else if (event.name === "home") {
          providerConvertIndex = 0;
          render();
        } else if (event.name === "end") {
          providerConvertIndex = providerConvertTargets.length - 1;
          render();
        } else if (event.name === "return") {
          const targetProvider = providerConvertTargets[providerConvertIndex];
          if (!targetProvider || providerConvertSessions.length === 0) return;
          const convertedSessions = [...providerConvertSessions];
          providerConvertLoading = true;
          providerConvertError = null;
          render();
          Promise.resolve()
            .then(() => providerConverter(convertedSessions, targetProvider))
            .then((convertedCount) => {
              if (cleaned) return;
              if (convertedCount !== convertedSessions.length) {
                throw new Error(`Converted ${convertedCount} of ${convertedSessions.length} sessions`);
              }
              for (const session of convertedSessions) session.provider = targetProvider;
              provider = targetProvider;
              showProviderConvert = false;
              showProviderMenu = false;
              providerConvertLoading = false;
              providerConvertError = null;
              providerViewportStart = 0;
              selectedIndex = 0;
              viewportStart = 0;
              selectedKey = null;
              showNotice(t("sessionsProviderConverted", { count: convertedCount, provider: displayText(targetProvider) }));
            })
            .catch((convertError) => {
              if (cleaned) return;
              providerConvertLoading = false;
              providerConvertError = convertError;
              render();
            });
        }
        return;
      }
      if (showPreview) {
        if (event.name === "space") {
          previewGeneration += 1;
          showPreview = false;
          render();
        }
        const session = filteredSessions()[selectedIndex];
        if (session?.agent === "codex") {
          if (["up", "k"].includes(event.name)) previewProviderIndex = Math.max(0, previewProviderIndex - 1);
          else if (["down", "j"].includes(event.name)) previewProviderIndex = Math.min(previewProviders.length - 1, previewProviderIndex + 1);
          else if (event.name === "home") previewProviderIndex = 0;
          else if (event.name === "end") previewProviderIndex = previewProviders.length - 1;
          else if (event.name === "return") {
            if (session.active) {
              showNotice(t("sessionsActiveResumeBlocked"));
              return;
            }
            cleanup();
            Promise.resolve()
              .then(() => onSelect(session, { provider: previewProviders[previewProviderIndex] ?? "zgap" }))
              .then(resolveResult, rejectResult);
            return;
          }
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
        } else if (event.name === "c") {
          const sourceProvider = providers[providerMenuIndex];
          if (!sourceProvider || sourceProvider === "all") return;
          providerConvertSessions = sessionFilter(sessions, { scope, roots, agent, provider: sourceProvider });
          if (providerConvertSessions.length === 0) return;
          providerConvertSource = sourceProvider;
          providerConvertTargets = resumeProviders(sessions).filter((candidate) => candidate !== sourceProvider);
          providerConvertIndex = 0;
          providerConvertViewportStart = 0;
          providerConvertError = null;
          showProviderConvert = true;
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
        previewProviders = session.agent === "codex" ? resumeProviders(sessions) : [];
        previewProviderIndex = Math.max(0, previewProviders.indexOf(session.provider ?? "zgap"));
        previewProviderViewportStart = 0;
        if (Array.isArray(detailCache.get(session)?.preview?.turns)
          || Array.isArray(session.preview?.turns) && session.preview.turns.length > 0
          || !session.previewLocator) {
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
        if (session.active) {
          showNotice(t("sessionsActiveResumeBlocked"));
          return;
        }
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
