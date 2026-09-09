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
import cliSpinners from "cli-spinners";
import { CODEX_PROVIDER_ID } from "../constants.mjs";
import { convertCodexSessionProviders, discoverRepositoryScope, filterSessions, listSessions, loadSessionDetails, loadSessionPreview, readCodexNativeProvider, stripTerminalControls } from "../sessions.mjs";
import { loadMenuTranslator } from "./menu.mjs";

const AGENTS = ["all", "codex", "claude", "omp"];
const SCOPES = ["directory", "repo", "parent", "all"];
const SORTS = ["newest", "oldest"];
const COMPACT_WIDTH = 60;
const EXACT_TIME_AFTER_MS = 3 * 60 * 60_000;
const CONVERTED_MARK_MS = 3_000;
const ORBIT_SPINNER = {
  frames: ["● · · ·", "· ● · ·", "· · ● ·", "· · · ●", "· · ● ·", "· ● · ·"],
  interval: 90,
};
const ACTIVE_SESSION_SPINNER = cliSpinners.circleHalves;
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

function knownCodexProviders(sessions) {
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
  if (agent === "OMP") return COLORS.blue;
  return COLORS.text;
}

function chunk(text, color, background, isBold = false) {
  let value = String(text);
  if (color) value = fg(color)(value);
  if (background) value = bg(background)(value);
  if (isBold) value = bold(value);
  return value;
}

function rowText(session, detailsState, selected, language, width, compact, currentTime, t, activeMarker, checkState) {
  const agent = displayText(session.agent).toUpperCase();
  const provider = truncateText(displayText(session.provider), compact ? 12 : 24);
  const sourceWidth = Bun.stringWidth(agent) + (provider ? Bun.stringWidth(` · ${provider}`) : 0);
  const rowWidth = Math.max(1, width - 3);
  const metaPrefix = "  └ ";
  const assistantPrefix = "        A ";
  const time = timestampLabel(session.updatedAt, language, currentTime);
  const turnCount = Number.isSafeInteger(detailsState?.turnCount)
    ? compact ? `${detailsState.turnCount}t` : t("resumeTurnCount", { count: detailsState.turnCount })
    : detailsState?.error ? t("resumeDetailsUnavailable") : "…";
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
  const checkbox = checkState === "converted" ? "[✓] " : checkState === "checked" ? "[x] " : checkState === "unchecked" ? "[ ] " : "    ";
  const checkboxColor = checkState === "converted" || checkState === "checked" ? COLORS.green : COLORS.meta;
  const titleLimit = Math.max(4, rowWidth - sourceWidth - 10);
  const title = truncateText(displayText(session.title), titleLimit);
  const assistant = detailsState?.error ? "—" : detailsState
    ? displayText(detailsState.latestAssistantLine || "—")
    : "…";
  const assistantText = truncateText(assistant, Math.max(1, rowWidth - Bun.stringWidth(assistantPrefix)));
  const background = selected ? COLORS.amberBackground : undefined;
  const providerChunk = provider
    ? [
        chunk(" · ", COLORS.text, background),
        chunk(provider, providerColor(provider), background),
      ]
    : [];
  const firstLineWidth = 8 + sourceWidth + 2 + Bun.stringWidth(title);
  const metaLineWidth = Bun.stringWidth(metaPrefix)
    + metaParts.reduce((total, part) => total + Bun.stringWidth(part.text), 0)
    + Math.max(0, metaParts.length - 1) * 3;
  return new StyledText([
    chunk(selected ? "›" : " ", COLORS.amber, background),
    chunk(" ", COLORS.text, background),
    chunk(session.active ? `${activeMarker} ` : "  ", session.active ? COLORS.green : COLORS.meta, background),
    chunk(checkbox, checkboxColor, background),
    chunk(agent, agentColor(agent), background, true),
    ...providerChunk,
    chunk("  ", COLORS.text, background),
    chunk(title, COLORS.text, background),
    chunk(" ".repeat(Math.max(0, rowWidth - firstLineWidth)), COLORS.text, background),
    chunk("\n", COLORS.text, background),
    chunk(assistantPrefix, COLORS.chip, background),
    chunk(assistantText, COLORS.chip, background),
    chunk(" ".repeat(Math.max(0, rowWidth - Bun.stringWidth(assistantPrefix) - Bun.stringWidth(assistantText))), COLORS.chip, background),
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

function convertMenuChunks(targets, selectedIndex, width, viewportStart, visibleRows) {
  const maxWidth = Math.max(4, width - 8);
  const chunks = [];
  const end = Math.min(targets.length, viewportStart + visibleRows);
  for (let index = viewportStart; index < end; index += 1) {
    const target = targets[index];
    const selected = index === selectedIndex;
    const background = selected ? COLORS.amberBackground : undefined;
    chunks.push(
      ...(chunks.length ? [chunk("\n", COLORS.text)] : []),
      chunk(selected ? "› " : "  ", COLORS.amber, background),
      chunk(truncateText(displayText(target), maxWidth), providerColor(target), background, selected),
    );
  }
  return chunks;
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
    chunks.push(chunk(`\n${t("resumePreviewEmpty")}`, COLORS.meta));
    return new StyledText(chunks);
  }
  const rowBudget = Math.max(2, height - 5);
  const indices = previewTurnIndices(turns.length, rowBudget);
  let remainingRows = rowBudget - previewMinimumRows(indices);
  let previousIndex = null;
  for (const index of indices) {
    if (previousIndex !== null && index - previousIndex > 1) {
      chunks.push(chunk(`${chunks.length ? "\n" : ""}${t("resumePreviewOmitted", { count: index - previousIndex - 1 })}`, COLORS.meta, undefined, true));
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
  sessionLoader = ({ scope, roots, onUpdate }) => listSessions({
    cwd,
    scope,
    repositoryRoots: scope === "all" ? undefined : roots,
    onUpdate,
  }),
  previewLoader = loadSessionPreview,
  detailsLoader = loadSessionDetails,
  sessionFilter = filterSessions,
  providerConverter = convertCodexSessionProviders,
  nativeProviderReader = readCodexNativeProvider,
} = {}) {
  let renderer;
  let keyHandler;
  let resizeHandler;
  let settled = false;
  let cleaned = false;
  let generation = 0;
  let spinnerIndex = 0;
  let spinnerTimer = null;
  let spinnerMode = null;
  let noticeTimer = null;
  let convertMarkTimer = null;
  let activeResumeKey = null;
  let activeResumeTimer = null;
  const abortController = new AbortController();
  const clearTimer = (timer) => (clock.clearTimeout ?? globalThis.clearTimeout)(timer);
  const startTimer = (callback, milliseconds) => (clock.setTimeout ?? globalThis.setTimeout)(callback, milliseconds);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    abortController.abort();
    if (spinnerTimer !== null) clock.clearInterval(spinnerTimer);
    spinnerTimer = null;
    spinnerMode = null;
    if (noticeTimer !== null) clearTimer(noticeTimer);
    noticeTimer = null;
    if (convertMarkTimer !== null) clearTimer(convertMarkTimer);
    convertMarkTimer = null;
    if (activeResumeTimer !== null) clearTimer(activeResumeTimer);
    activeResumeTimer = null;
    activeResumeKey = null;
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
    let sort = "newest";
    let pendingScope = scope;
    let pendingAgent = agent;
    let pendingProvider = provider;
    let pendingSort = sort;
    let filterFocus = -1;
    let selectedIndex = 0;
    let selectedKey = null;
    // Partial scans can insert newer sessions above the first partial row, so untouched initial focus stays position-based.
    let preserveSelectionIdentity = false;
    let viewportStart = 0;
    let showHelp = false;
    let showPreview = false;
    let showResumeChoice = false;
    let resumeChoiceIndex = 0;
    let nativeProvider = null;
    let nativeProviderError = null;
    let resumeConverting = false;
    let resumeConvertError = null;
    let previewLoading = false;
    let previewError = null;
    let previewGeneration = 0;
    let showConvert = false;
    let convertTargets = [];
    let convertIndex = 0;
    let convertViewport = 0;
    let convertSessions = [];
    let convertReturnSession = null;
    let convertLoading = false;
    let convertError = null;
    const checked = new Set();
    let recentlyConverted = new Set();
    // A scan still in flight returns records read before the conversion, so the new provider is
    // replayed onto every later batch until a refresh reads it back from disk.
    const convertedProviders = new Map();
    let notice = "";

    const root = new BoxRenderable(renderer, {
      backgroundColor: "#000000",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
    });
    const title = new TextRenderable(renderer, {
      content: t("resumeTitle"),
      fg: "#67E8F9",
      attributes: TextAttributes.BOLD,
      height: 1,
      selectable: true,
    });
    const filters = new TextRenderable(renderer, {
      content: "",
      fg: "#94A3B8",
      height: 4,
      selectable: true,
    });
    const divider = new TextRenderable(renderer, {
      content: "",
      fg: COLORS.meta,
      height: 1,
      flexShrink: 0,
      selectable: true,
    });
    const list = new TextRenderable(renderer, {
      content: "",
      fg: "#E2E8F0",
      flexGrow: 1,
      selectable: true,
    });
    const previewContent = new TextRenderable(renderer, {
      content: "",
      flexGrow: 1,
      visible: false,
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
    root.add(divider);
    root.add(list);
    root.add(previewContent);
    root.add(hint);
    renderer.root.add(root);

    const visibleRows = () => {
      const measured = Number(list.height);
      if (Number.isFinite(measured) && measured > 0) return Math.max(1, Math.floor((measured + 1) / 4));
      const outerPaddingRows = renderer.height <= 12 ? 0 : 2;
      const titleRows = 1;
      const filterRows = 5;
      const footerRows = renderer.width <= COMPACT_WIDTH ? 1 : 2;
      return Math.max(1, Math.floor((renderer.height - outerPaddingRows - titleRows - filterRows - footerRows + 1) / 4));
    };
    const providerChoices = () => {
      const counts = new Map();
      // Loading and partial scans must not change applied filters or the current keyboard candidate.
      if (provider !== "all") counts.set(provider, 0);
      if (pendingProvider !== "all") counts.set(pendingProvider, 0);
      for (const session of sessionFilter(sessions, { scope, cwd, roots, agent: "all", provider: "all" })) {
        if (session.agent !== "codex" || !session.provider) continue;
        counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
      }
      return [{ value: "all", count: 0 }, ...[...counts.entries()]
        .sort((first, second) => first[0].localeCompare(second[0]))
        .map(([value, count]) => ({ value, count }))];
    };
    const checkStateFor = (session) => (session.agent === "codex" && session.provider
      ? recentlyConverted.has(session.id) ? "converted" : checked.has(session.id) ? "checked" : "unchecked"
      : null);
    const filteredSessions = () => {
      const values = [...sessionFilter(sessions, { scope, cwd, roots, agent, provider })];
      return values.sort((first, second) => {
        const time = sort === "oldest" ? first.updatedAt - second.updatedAt : second.updatedAt - first.updatedAt;
        return time || String(first.id).localeCompare(String(second.id));
      });
    };
    const keepSelection = (values) => {
      if (preserveSelectionIdentity && selectedKey) {
        const restored = values.findIndex((session) => sessionKey(session) === selectedKey);
        if (restored >= 0) selectedIndex = restored;
      }
      selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, values.length - 1)));
      selectedKey = preserveSelectionIdentity && values[selectedIndex] ? sessionKey(values[selectedIndex]) : null;
      const count = visibleRows();
      if (selectedIndex < viewportStart) viewportStart = selectedIndex;
      if (selectedIndex >= viewportStart + count) viewportStart = selectedIndex - count + 1;
      viewportStart = Math.max(0, Math.min(viewportStart, Math.max(0, values.length - count)));
    };
    const render = () => {
      if (cleaned) return;
      const compact = renderer.width <= COMPACT_WIDTH;
      const loading = state === "initializing" || state === "loading" || previewLoading || convertLoading || resumeConverting;
      const mainListVisible = !showConvert && !showPreview && !showHelp && !showResumeChoice;
      // Short terminals keep a session visible below the four filter rows and their divider.
      root.paddingTop = mainListVisible && renderer.height <= 12 ? 0 : 1;
      root.paddingBottom = mainListVisible && renderer.height <= 12 ? 0 : 1;
      divider.visible = mainListVisible;
      divider.content = "─".repeat(Math.max(1, renderer.width - 2));
      const activeSessions = state === "ready" && mainListVisible ? filteredSessions() : [];
      const nextSpinnerMode = loading
        ? "loading"
        : activeSessions.some((session) => session.active)
          ? "active"
          : null;
      if (nextSpinnerMode !== spinnerMode) {
        if (spinnerTimer !== null) clock.clearInterval(spinnerTimer);
        spinnerTimer = null;
        spinnerMode = nextSpinnerMode;
        spinnerIndex = 0;
      }
      if (spinnerMode !== null && spinnerTimer === null) {
        const spinner = spinnerMode === "active" ? ACTIVE_SESSION_SPINNER : ORBIT_SPINNER;
        spinnerTimer = clock.setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % spinner.frames.length;
          if (!cleaned) render();
        }, spinner.interval);
      }
      const providerValues = providerChoices();
      const scopeLabel = (value) => t({
        directory: "resumeScopeDirectory",
        repo: "resumeScopeRepo",
        parent: "resumeScopeParent",
        all: "resumeScopeAll",
      }[value]);
      const agentLabel = (value) => value === "all" ? t("resumeAll") : value.toUpperCase();
      const sortLabel = (value) => t(value === "oldest" ? "resumeSortOldest" : "resumeSortNewest");
      const choiceRow = (label, choices, current, rowIndex, format = String) => {
        const focused = filterFocus === rowIndex;
        const index = Math.max(0, choices.findIndex((choice) => choice.value === current));
        const appliedValue = [scope, agent, provider, sort][rowIndex];
        const prefix = `${label}: `;
        const available = Math.max(1, renderer.width - 2 - Bun.stringWidth(prefix));
        const rawText = (choice) => `${choice.value === appliedValue ? "●" : "○"} ${format(choice)}${choice.count ? ` (${choice.count})` : ""}`;
        const optionText = (choice) => focused && choice.value === current ? `[${rawText(choice)}]` : rawText(choice);
        const textWidth = (values, first, last) => Bun.stringWidth(first) + Bun.stringWidth(last) + values.reduce((total, value, position) => total + Bun.stringWidth(value) + (position ? 2 : 0), 0);
        let start = index;
        let end = index + 1;
        if (!compact) {
          while (start > 0 || end < choices.length) {
            const left = start > 0 ? rawText(choices[start - 1]) : null;
            const right = end < choices.length ? rawText(choices[end]) : null;
            const nextStart = left && (!right || index - start <= end - index) ? start - 1 : start;
            const nextEnd = nextStart === start && right ? end + 1 : end;
            const nextValues = choices.slice(nextStart, nextEnd).map(optionText);
            const nextFirst = nextStart > 0 ? "‹ " : "";
            const nextLast = nextEnd < choices.length ? " ›" : "";
            if (textWidth(nextValues, nextFirst, nextLast) > available) break;
            start = nextStart;
            end = nextEnd;
          }
        }
        const first = start > 0 ? "‹ " : "";
        const last = end < choices.length ? " ›" : "";
        const visible = choices.slice(start, end);
        const labelBudget = Math.max(1, available - Bun.stringWidth(first) - Bun.stringWidth(last));
        const values = visible.map((choice) => {
          const selected = choice.value === current;
          const applied = choice.value === appliedValue;
          // A lone long option still reserves space for the cursor brackets and edge indicators.
          const labelText = visible.length === 1
            ? truncateText(rawText(choice), Math.max(1, labelBudget - (focused && selected ? 2 : 0)))
            : rawText(choice);
          const text = focused && selected ? `[${labelText}]` : labelText;
          return chunk(text, focused && selected ? COLORS.amber : applied ? COLORS.green : COLORS.chip, undefined, focused && selected);
        });
        return [chunk(`${label}: `, COLORS.text, undefined, focused), chunk(first, COLORS.meta), ...values.flatMap((value, i) => [...(i ? [chunk("  ", COLORS.meta)] : []), value]), chunk(last, COLORS.meta)];
      };
      const scopeChoices = SCOPES.map((value) => ({ value }));
      const agentChoices = AGENTS.map((value) => ({ value }));
      const sortChoices = SORTS.map((value) => ({ value }));
      filters.content = new StyledText([
        ...choiceRow(t("resumeFilterScope"), scopeChoices, pendingScope, 0, (choice) => scopeLabel(choice.value)), chunk("\n", COLORS.text),
        ...choiceRow(t("resumeFilterAgent"), agentChoices, pendingAgent, 1, (choice) => agentLabel(choice.value)), chunk("\n", COLORS.text),
        ...choiceRow(t("resumeFilterProvider"), providerValues, pendingProvider, 2, (choice) => choice.value === "all" ? t("resumeAll") : displayText(choice.value)), chunk("\n", COLORS.text),
        ...choiceRow(t("resumeFilterSort"), sortChoices, pendingSort, 3, (choice) => sortLabel(choice.value)),
      ]);
      hint.content = notice || (filterFocus >= 0
        ? compact ? t("resumeFilterCompactHint") : `${t("resumeFilterHint")} · ${t(`resumeScope${pendingScope[0].toUpperCase()}${pendingScope.slice(1)}Description`)}`
        : checked.size > 0
        ? t("resumeSelectionHint", { count: checked.size })
        : compact ? t("resumeCompactHint") : t("resumeHint"));
      if (showResumeChoice) {
        title.content = t("resumeChoiceTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        previewContent.visible = false;
        list.visible = true;
        hint.content = notice || t("resumeChoiceHint");
        const session = filteredSessions()[selectedIndex];
        const choices = [
          [t("resumeChoiceProxy"), COLORS.amber],
          [t("resumeChoiceLocal"), COLORS.green],
        ];
        const [note, noteColor] = resumeChoiceNote(session);
        list.content = new StyledText([
          chunk(session ? `${displayText(session.agent).toUpperCase()}  ${truncateText(displayText(session.title), Math.max(4, renderer.width - 12))}` : "", COLORS.chip),
          chunk("\n\n", COLORS.text),
          ...choices.flatMap(([label, color], index) => {
            const selected = index === resumeChoiceIndex;
            const background = selected ? COLORS.amberBackground : undefined;
            return [
              ...(index > 0 ? [chunk("\n", COLORS.text)] : []),
              chunk(selected ? "› " : "  ", COLORS.amber, background),
              chunk(label, color, background, selected),
              // The note sits directly under the highlighted row so it reads as that choice's outcome.
              ...(selected ? [chunk("\n    ", COLORS.text), chunk(truncateText(note, Math.max(4, renderer.width - 8)), noteColor)] : []),
            ];
          }),
        ]);
        renderer.requestRender();
        return;
      }
      if (showConvert) {
        convertIndex = Math.max(0, Math.min(convertIndex, convertTargets.length - 1));
        const convertVisibleRows = Math.max(1, renderer.height - 8);
        if (convertIndex < convertViewport) convertViewport = convertIndex;
        if (convertIndex >= convertViewport + convertVisibleRows) convertViewport = convertIndex - convertVisibleRows + 1;
        convertViewport = Math.max(0, Math.min(convertViewport, Math.max(0, convertTargets.length - convertVisibleRows)));
        const target = convertTargets[convertIndex];
        const changeCount = target ? convertSessions.filter((session) => session.provider !== target).length : 0;
        title.content = t("resumeConvertTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        previewContent.visible = false;
        list.visible = true;
        hint.maxHeight = 3;
        hint.content = convertLoading
          ? `${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeProviderConverting", { count: changeCount })}`
          : convertError
            ? `${t("resumeProviderConvertFailed")}: ${convertError.message}`
            : t("resumeProviderConvertHint");
        list.content = new StyledText([
          chunk(changeCount === convertSessions.length
            ? t("resumeProviderConvertCount", { count: changeCount })
            : t("resumeProviderConvertPartial", { count: changeCount, total: convertSessions.length }), COLORS.amber, undefined, true),
          chunk("\n\n", COLORS.text),
          ...convertMenuChunks(convertTargets, convertIndex, renderer.width, convertViewport, convertVisibleRows),
        ]);
        list.fg = convertError ? "#F87171" : COLORS.text;
        renderer.requestRender();
        return;
      }
      if (showPreview) {
        const values = filteredSessions();
        const session = values[selectedIndex];
        const previewSession = session && detailCache.get(session)?.preview
          ? { ...session, preview: detailCache.get(session).preview }
          : session;
        previewContent.visible = true;
        title.content = t("resumePreviewTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        hint.maxHeight = compact ? 1 : 3;
        hint.content = notice || t("resumePreviewHint");
        list.visible = false;
        previewContent.content = previewLoading
          ? `${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumePreviewLoading")}`
          : previewError
            ? `${t("resumePreviewLoadFailed")}: ${previewError.message}`
            : previewSession
              ? previewText(previewSession, renderer.width, renderer.height, t, { compact })
              : "";
        previewContent.fg = previewError ? "#F87171" : previewLoading ? COLORS.chip : COLORS.text;
        renderer.requestRender();
        return;
      }
      previewContent.visible = false;
      list.visible = true;
      hint.maxHeight = 3;
      if (showHelp) {
        title.content = t("resumeHelpTitle");
        title.visible = true;
        filters.content = "";
        filters.visible = false;
        hint.content = "";
        list.content = t("resumeHelp");
        list.fg = COLORS.text;
        renderer.requestRender();
        return;
      }
      title.content = t("resumeTitle");
      title.visible = true;
      filters.visible = true;
      if (state === "initializing") {
        list.content = `${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeInitializing")}`;
        list.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      if (state === "loading") {
        if (sessions.length === 0) {
          list.content = `${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeLoading")}`;
          list.fg = "#94A3B8";
          renderer.requestRender();
          return;
        }
        // Partial results render as the normal list; the hint keeps the spinner so the scan visibly continues.
        // A live check count outranks the spinner, since the list itself already shows loading is unfinished.
        if (checked.size === 0) hint.content = notice || `${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeLoading")}`;
      }
      if (state === "error") {
        list.content = error?.message ? `${t("resumeLoadFailed")}: ${error.message}` : t("resumeLoadFailed");
        list.fg = "#F87171";
        renderer.requestRender();
        return;
      }
      const values = filteredSessions();
      keepSelection(values);
      if (values.length === 0) {
        list.content = state === "loading"
          ? `${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeLoading")}`
          : t("resumeEmptyFiltered");
        list.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      const count = visibleRows();
      const visibleSessions = values.slice(viewportStart, viewportStart + count);
      const rows = visibleSessions.map((session, index) => rowText(session, detailCache.get(session), viewportStart + index === selectedIndex, language, renderer.width, compact, now(), t, spinnerMode === "active" ? ACTIVE_SESSION_SPINNER.frames[spinnerIndex] : ACTIVE_SESSION_SPINNER.frames[0], checkStateFor(session)));
      list.content = new StyledText(rows.flatMap((row, index) => [
        ...(index > 0 ? [chunk(`\n  ${"·".repeat(Math.max(1, renderer.width - 5))}\n`, COLORS.meta)] : []),
        ...row.chunks,
      ]));
      list.fg = "#E2E8F0";
      renderer.requestRender();
      for (const session of visibleSessions) {
        if (detailCache.has(session) || detailRequests.has(session)) continue;
        const request = Promise.resolve(detailsLoader(session)).then((details) => {
          detailCache.set(session, {
            turnCount: Number.isSafeInteger(details?.turnCount) ? details.turnCount : 0,
            fileSize: Number.isFinite(details?.fileSize) ? details.fileSize : 0,
            latestAssistantLine: typeof details?.latestAssistantLine === "string" ? details.latestAssistantLine : null,
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
      if (noticeTimer !== null) clearTimer(noticeTimer);
      noticeTimer = null;
    };
    const showNotice = (message, durationMs = 3_000) => {
      clearNotice();
      notice = message;
      render();
      noticeTimer = startTimer(() => {
        noticeTimer = null;
        notice = "";
        if (!cleaned) render();
      }, durationMs);
    };
    const clearActiveResume = () => {
      if (activeResumeTimer !== null) clearTimer(activeResumeTimer);
      activeResumeTimer = null;
      activeResumeKey = null;
    };
    // Only Codex sessions with an indexed provider can be rewritten; the c key uses the same rule.
    const convertible = (session) => checkStateFor(session) !== null;
    const resumeTarget = (native) => (native ? nativeProvider : CODEX_PROVIDER_ID);
    const resumeChoiceNote = (session) => {
      if (!session) return ["", COLORS.meta];
      const native = resumeChoiceIndex === 1;
      if (resumeConvertError) return [`${t("resumeProviderConvertFailed")}: ${resumeConvertError.message}`, "#F87171"];
      if (resumeConverting) return [`${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeChoiceConverting", { provider: resumeTarget(native) })}`, COLORS.meta];
      if (native && session.agent !== "codex") return [t("resumeChoiceNoteNative", { agent: t(session.agent) }), COLORS.meta];
      if (native && nativeProviderError) return [t("resumeChoiceNoteError", { message: nativeProviderError.message }), "#F87171"];
      if (native && !nativeProvider) return [`${ORBIT_SPINNER.frames[spinnerIndex]} ${t("resumeChoiceNoteLoading")}`, COLORS.meta];
      const target = resumeTarget(native);
      if (convertible(session) && session.provider !== target) {
        return [t("resumeChoiceNoteConvert", { from: displayText(session.provider), provider: target }), COLORS.amber];
      }
      return [t("resumeChoiceNoteProvider", { provider: target }), COLORS.meta];
    };
    const resume = (session) => {
      const key = sessionKey(session);
      if (session.active && activeResumeKey !== key) {
        clearActiveResume();
        activeResumeKey = key;
        activeResumeTimer = startTimer(clearActiveResume, 1_000);
        showNotice(t("resumeActiveResumeConfirm"), 1_000);
        return;
      }
      showResumeChoice = true;
      resumeChoiceIndex = 0;
      resumeConvertError = null;
      // The config can change between resumes, so the native provider is read every time the choice opens.
      nativeProvider = null;
      nativeProviderError = null;
      Promise.resolve()
        .then(() => nativeProviderReader())
        .then((value) => { nativeProvider = value; }, (error) => { nativeProviderError = error; })
        .then(() => { if (!cleaned && showResumeChoice) render(); });
      render();
    };
    const launch = (session, native) => {
      showResumeChoice = false;
      clearActiveResume();
      cleanup();
      Promise.resolve().then(() => onSelect(session, { native })).then(resolveResult, rejectResult);
    };
    const select = (index) => {
      const values = filteredSessions();
      preserveSelectionIdentity = true;
      selectedIndex = Math.max(0, Math.min(Math.max(0, values.length - 1), index));
      selectedKey = values[selectedIndex] ? sessionKey(values[selectedIndex]) : null;
      render();
    };
    const applyConverted = (values) => {
      if (convertedProviders.size === 0) return values;
      for (const session of values) {
        const provider = convertedProviders.get(session.id);
        if (provider && session.agent === "codex") session.provider = provider;
      }
      return values;
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
        const onUpdate = (partial) => {
          if (cleaned || currentGeneration !== generation || !Array.isArray(partial)) return;
          sessions = applyConverted(partial);
          render();
        };
        const loaded = await sessionLoader({ cwd, roots, scope: requestedScope, signal: abortController.signal, onUpdate });
        if (cleaned || currentGeneration !== generation) return;
        sessions = applyConverted(Array.isArray(loaded) ? loaded : []);
        sessionCache.set(requestedScope, sessions);
        state = "ready";
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
      if (event.name !== "return") clearActiveResume();
      if (event.ctrl && event.name === "c") {
        if (lastCtrlC !== null && timestamp - lastCtrlC <= 1_000) finish(130);
        else {
          lastCtrlC = timestamp;
          showNotice(t("resumeCtrlCExitPrompt"), 1_000);
        }
        return;
      }
      if (event.name === "tab" && (event.ctrl || event.meta || event.option || event.super || event.hyper)) return;
      if (event.name === "escape" || event.name === "backspace") {
        if (showHelp) {
          showHelp = false;
          render();
          return;
        }
        if (filterFocus >= 0) {
          pendingScope = scope;
          pendingAgent = agent;
          pendingProvider = provider;
          pendingSort = sort;
          filterFocus = -1;
          render();
          return;
        }
        if (showResumeChoice) {
          if (resumeConverting) return;
          showResumeChoice = false;
          resumeConvertError = null;
          render();
        } else if (showConvert) {
          if (convertLoading) return;
          showConvert = false;
          convertError = null;
          render();
        } else if (showPreview) {
          previewGeneration += 1;
          showPreview = false;
          render();
        } else if (checked.size > 0) {
          checked.clear();
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
      if (showConvert) {
        if (convertLoading) return;
        if (["up", "k"].includes(event.name)) {
          convertIndex = Math.max(0, convertIndex - 1);
          render();
        } else if (["down", "j"].includes(event.name)) {
          convertIndex = Math.min(convertTargets.length - 1, convertIndex + 1);
          render();
        } else if (event.name === "home") {
          convertIndex = 0;
          render();
        } else if (event.name === "end") {
          convertIndex = convertTargets.length - 1;
          render();
        } else if (event.name === "return") {
          const target = convertTargets[convertIndex];
          if (!target) return;
          const toConvert = convertSessions.filter((session) => session.provider !== target);
          if (toConvert.length === 0) return;
          convertLoading = true;
          convertError = null;
          render();
          Promise.resolve()
            .then(() => providerConverter(toConvert, target))
            .then((convertedCount) => {
              if (cleaned) return;
              if (convertedCount !== toConvert.length) {
                throw new Error(`Converted ${convertedCount} of ${toConvert.length} sessions`);
              }
              for (const session of toConvert) {
                session.provider = target;
                convertedProviders.set(session.id, target);
              }
              // Other scopes cache pre-conversion snapshots, so drop them to force a reload.
              for (const cachedScope of [...sessionCache.keys()]) {
                if (cachedScope !== scope) sessionCache.delete(cachedScope);
              }
              checked.clear();
              recentlyConverted = new Set(toConvert.map((session) => session.id));
              if (convertMarkTimer !== null) clearTimer(convertMarkTimer);
              convertMarkTimer = startTimer(() => {
                convertMarkTimer = null;
                recentlyConverted = new Set();
                if (!cleaned) render();
              }, CONVERTED_MARK_MS);
              provider = "all";
              pendingProvider = "all";
              showConvert = false;
              convertLoading = false;
              convertError = null;
              // Sessions mutated above, so recompute the key now to land the cursor back on the same row.
              if (convertReturnSession) {
                preserveSelectionIdentity = true;
                selectedKey = sessionKey(convertReturnSession);
              } else {
                selectedKey = null;
              }
              convertReturnSession = null;
              showNotice(t("resumeProviderConverted", { count: toConvert.length, provider: displayText(target) }));
            })
            .catch((conversionError) => {
              if (cleaned) return;
              convertLoading = false;
              convertError = conversionError;
              render();
            });
        }
        return;
      }
      if (showResumeChoice) {
        if (resumeConverting) return;
        if (["up", "k"].includes(event.name)) {
          resumeChoiceIndex = 0;
          resumeConvertError = null;
          render();
        } else if (["down", "j"].includes(event.name)) {
          resumeChoiceIndex = 1;
          resumeConvertError = null;
          render();
        } else if (event.name === "return") {
          const session = filteredSessions()[selectedIndex];
          if (!session) return;
          const native = resumeChoiceIndex === 1;
          const target = resumeTarget(native);
          if (!convertible(session) || session.provider === target) {
            launch(session, native);
            return;
          }
          // Codex resolves the provider stored on the thread, so the row is rewritten before launch.
          if (!target) return;
          resumeConverting = true;
          resumeConvertError = null;
          render();
          Promise.resolve()
            .then(() => providerConverter([session], target))
            .then(() => {
              if (cleaned) return;
              session.provider = target;
              resumeConverting = false;
              launch(session, native);
            })
            .catch((conversionError) => {
              if (cleaned) return;
              resumeConverting = false;
              resumeConvertError = conversionError;
              render();
            });
        }
        return;
      }
      if (showPreview) {
        if (event.name === "left" || event.name === "escape" || event.name === "backspace") {
          previewGeneration += 1;
          showPreview = false;
          render();
          return;
        }
        if (event.name === "return") {
          const session = filteredSessions()[selectedIndex];
          if (session) resume(session);
        }
        return;
      }
      if (showHelp) return;
      if (filterFocus >= 0) {
        if (event.ctrl || event.meta || event.option || event.super || event.hyper) return;
        if (event.shift && event.name !== "tab") return;
        const rows = [
          { get: () => pendingScope, set: (value) => { pendingScope = value; }, values: SCOPES.map((value) => ({ value })) },
          { get: () => pendingAgent, set: (value) => { pendingAgent = value; }, values: AGENTS.map((value) => ({ value })) },
          { get: () => pendingProvider, set: (value) => { pendingProvider = value; }, values: providerChoices() },
          { get: () => pendingSort, set: (value) => { pendingSort = value; }, values: SORTS.map((value) => ({ value })) },
        ];
        const row = rows[filterFocus];
        if (!row) { filterFocus = 0; render(); return; }
        if (event.name === "tab") {
          if (event.shift) {
            filterFocus = filterFocus === 0 ? -1 : filterFocus - 1;
          } else {
            filterFocus = filterFocus === rows.length - 1 ? -1 : filterFocus + 1;
          }
          pendingScope = scope;
          pendingAgent = agent;
          pendingProvider = provider;
          pendingSort = sort;
          render();
          return;
        }
        if ((event.name === "up" || event.name === "down") && !event.shift) {
          filterFocus = event.name === "up" ? (filterFocus + rows.length - 1) % rows.length : (filterFocus + 1) % rows.length;
          pendingScope = scope;
          pendingAgent = agent;
          pendingProvider = provider;
          pendingSort = sort;
          render();
          return;
        }
        if ((event.name === "left" || event.name === "right") && !event.shift) {
          const values = row.values;
          const current = Math.max(0, values.findIndex((choice) => choice.value === row.get()));
          const delta = event.name === "right" ? 1 : -1;
          row.set(values[Math.max(0, Math.min(values.length - 1, current + delta))]?.value ?? row.get());
          render();
          return;
        }
        if (event.name === "return") {
          const scopeChanged = filterFocus === 0 && pendingScope !== scope;
          const agentChanged = filterFocus === 1 && pendingAgent !== agent;
          const providerChanged = filterFocus === 2 && pendingProvider !== provider;
          const sortChanged = filterFocus === 3 && pendingSort !== sort;
          const changed = scopeChanged || agentChanged || providerChanged || sortChanged;
          if (filterFocus === 0) scope = pendingScope;
          if (filterFocus === 1) agent = pendingAgent;
          if (filterFocus === 2) provider = pendingProvider;
          if (filterFocus === 3) sort = pendingSort;
          filterFocus = -1;
          if (changed) {
            selectedIndex = 0;
            viewportStart = 0;
            selectedKey = null;
          }
          if (scopeChanged) checked.clear();
          pendingScope = scope;
          pendingAgent = agent;
          pendingProvider = provider;
          pendingSort = sort;
          if (scopeChanged && state !== "initializing") void load(scope);
          else render();
          return;
        }
        return;
      }
      if (event.name === "r") {
        sessionCache.delete(scope);
        // A refresh rereads the database, which now owns the converted providers.
        convertedProviders.clear();
        void load(scope, { refresh: true });
        return;
      }
      if (event.name === "tab") {
        filterFocus = event.shift ? 3 : 0;
        pendingScope = scope;
        pendingAgent = agent;
        pendingProvider = provider;
        pendingSort = sort;
        render();
        return;
      }
      // Partial results are complete session records, so navigation and resume work while the scan finishes.
      if (state !== "ready" && !(state === "loading" && sessions.length > 0)) return;
      if (event.name === "space") {
        const session = filteredSessions()[selectedIndex];
        if (!session) return;
        if (checkStateFor(session) === null) {
          showNotice(t("resumeNotConvertible"));
          return;
        }
        if (!checked.delete(session.id)) checked.add(session.id);
        render();
        return;
      }
      if (event.name === "c") {
        const chosen = sessions.filter((session) => session.agent === "codex" && session.provider && checked.has(session.id));
        if (chosen.length === 0) {
          showNotice(t("resumeNoSelection"));
          return;
        }
        convertSessions = chosen;
        // Keep the row object, not its key: conversion rewrites provider and sessionKey embeds it.
        convertReturnSession = filteredSessions()[selectedIndex] ?? null;
        convertTargets = knownCodexProviders(sessions).filter((target) => chosen.some((session) => session.provider !== target));
        convertIndex = 0;
        convertViewport = 0;
        convertError = null;
        showConvert = true;
        render();
        return;
      }
      if (event.name === "right") {
        const values = filteredSessions();
        const session = values[selectedIndex];
        if (!session) return;
        showPreview = true;
        previewError = null;
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
        resume(session);
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
