import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createInstance } from "i18next";
import { BoxRenderable, TextAttributes, TextRenderable, createCliRenderer } from "@opentui/core";
import { DEFAULT_HOST, ORIGIN } from "../constants.mjs";

const LOCALES = ["en", "ko"];
const LOCALE_DIR = fileURLToPath(new URL("./locales/", import.meta.url));
const COMPACT_WIDTH = 60;
// This floor keeps the display responsive without letting an instant local checker flood the health endpoint.
const PROXY_REFRESH_MS = 250;

export async function checkProxyHealth({
  fetchImpl = fetch,
  now = () => performance.now(),
  origin = ORIGIN,
  signal,
  timeoutMs = 3_000,
} = {}) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const startedAt = now();
  try {
    const response = await fetchImpl(new URL("/health", origin), {
      method: "GET",
      signal: requestSignal,
    });
    await response.arrayBuffer();
    if (!response.ok) return { state: "unreachable" };
    return { state: "online", latencyMs: Math.round(now() - startedAt) };
  } catch {
    return { state: "unreachable" };
  }
}

function localeFor(language) {
  const normalized = (language || "en").toLowerCase();
  if (normalized.startsWith("ko")) return "ko";
  return "en";
}

export async function loadMenuTranslator(language = process.env.LANG) {
  const resources = {};
  await Promise.all(LOCALES.map(async (locale) => {
    const source = await readFile(path.join(LOCALE_DIR, `${locale}.json`), "utf8");
    resources[locale] = { translation: JSON.parse(source) };
  }));
  const instance = createInstance();
  await instance.init({
    lng: localeFor(language),
    fallbackLng: "en",
    resources,
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance);
}

function menuContent(credentialState, accountProfile, t, host) {
  if (credentialState === "signed-in") {
    return {
      status: accountProfile?.email ?? t("accountUnavailable"),
      statusColor: accountProfile ? "#86EFAC" : "#F87171",
      actions: [
        { name: "codex", label: t("codex"), description: t("codexDescription", { host }) },
        { name: "claude", label: t("claude"), description: t("claudeDescription", { host }) },
        { name: "omp", label: t("omp"), description: t("ompDescription", { host }) },
        { name: "sessions", label: t("sessions"), description: t("sessionsDescription") },
      ],
    };
  }
  if (credentialState === "expired") {
    return {
      status: t("sessionExpired"),
      statusColor: "#FCD34D",
      actions: [
        { name: "login", label: t("loginAgain"), description: t("loginAgainDescription") },
        { name: "sessions", label: t("sessions"), description: t("sessionsDescription") },
      ],
    };
  }
  if (credentialState === "signed-out") {
    return {
      status: t("notSignedIn"),
      statusColor: "#94A3B8",
      actions: [
        { name: "login", label: t("login"), description: t("loginDescription") },
        { name: "sessions", label: t("sessions"), description: t("sessionsDescription") },
      ],
    };
  }
  throw new Error(`Unknown credential state: ${credentialState}`);
}

export async function runStartMenu({
  rendererFactory = createCliRenderer,
  actions = {},
  credentialState = "signed-out",
  host = DEFAULT_HOST,
  language = process.env.LANG,
  now = Date.now,
  origin = ORIGIN,
  proxyHealthCheck = checkProxyHealth,
  updateChecker,
  accountProfile,
  dangerousMode = false,
  onDangerousModeChange = async () => { throw new Error("Missing dangerous mode persistence handler."); },
} = {}) {
  let renderer;
  let keyHandler;
  let resizeHandler;
  const proxyAbortController = new AbortController();
  const updateAbortController = new AbortController();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    proxyAbortController.abort();
    updateAbortController.abort();
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
    const content = menuContent(credentialState, accountProfile, t, host);
    let settled = false;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const finish = async (action) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolveResult(await action());
      } catch (error) {
        rejectResult(error);
      }
    };
    let selectedIndex = 0;
    let dangerousModeEnabled = dangerousMode;
    let modeChangePending = false;
    const runSelectedAction = () => {
      const selected = content.actions[selectedIndex];
      const action = actions[selected.name];
      if (!action) {
        void finish(async () => { throw new Error(`Missing menu action: ${selected.name}`); });
        return;
      }
      void finish(action);
    };

    const root = new BoxRenderable(renderer, {
      backgroundColor: "#000000",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
    });
    const topBar = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
    });
    const brand = new BoxRenderable(renderer, {
      flexDirection: "column",
      paddingLeft: 1,
    });
    const title = new TextRenderable(renderer, {
      content: t("title"),
      fg: "#67E8F9",
      attributes: TextAttributes.BOLD,
      selectable: true,
    });
    const tagline = new TextRenderable(renderer, {
      content: t("tagline", { host }),
      fg: "#64748B",
      selectable: true,
    });
    const status = new TextRenderable(renderer, {
      content: `● ${content.status}`,
      fg: content.statusColor,
      attributes: TextAttributes.BOLD,
      selectable: true,
    });
    const proxyStatus = new TextRenderable(renderer, {
      content: `● ${t("proxyChecking")}`,
      fg: "#64748B",
      selectable: true,
    });
    const statusArea = new BoxRenderable(renderer, {
      flexDirection: "column",
      alignItems: "flex-end",
      paddingRight: 1,
    });
    brand.add(title);
    brand.add(tagline);
    statusArea.add(status);
    statusArea.add(proxyStatus);
    topBar.add(brand);
    topBar.add(statusArea);

    const updateStatus = new TextRenderable(renderer, {
      content: "",
      fg: "#67E8F9",
      selectable: true,
    });
    const infoArea = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      paddingTop: 1,
    });
    infoArea.add(updateStatus);

    const centerArea = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    });
    const modeArea = new BoxRenderable(renderer, {
      width: "100%",
      height: 2,
      flexDirection: "column",
      alignItems: "center",
    });
    const modeRail = new TextRenderable(renderer, {
      content: "",
      attributes: TextAttributes.BOLD,
      selectable: true,
    });
    const modeHint = new TextRenderable(renderer, {
      content: t("dangerousModeSelectHint"),
      fg: "#64748B",
      selectable: true,
    });
    modeArea.add(modeRail);
    modeArea.add(modeHint);
    const actionRow = new BoxRenderable(renderer, {
      width: "70%",
      height: content.actions.length > 1 ? (content.actions.length * 4 + (content.actions.length > 2 ? 0 : 1)) : 4,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "stretch",
      gap: content.actions.length > 2 ? 0 : (content.actions.length > 1 ? 1 : 0),
    });
    const actionGrid = content.actions.length >= 4;
    // Compact single-row cards drop the Enter suffix so all agent labels fit narrow terminals.
    const fullLabels = content.actions.map((item) => `${item.label}  ↵`);
    const compactLabels = content.actions.map((item) => item.label);
    const actionCards = content.actions.map((item, index) => {
      const card = new BoxRenderable(renderer, {
        width: "100%",
        height: 4,
        flexDirection: "column",
        justifyContent: "center",
        border: true,
        borderStyle: "rounded",
        borderColor: "#475569",
        paddingX: 1,
      });
      const label = new TextRenderable(renderer, {
        content: fullLabels[index],
        fg: "#F8FAFC",
        attributes: TextAttributes.BOLD,
        selectable: true,
      });
      const description = new TextRenderable(renderer, {
        content: item.description,
        fg: "#94A3B8",
        selectable: true,
      });
      card.add(label);
      card.add(description);
      actionRow.add(card);
      return { card, label, description };
    });
    centerArea.add(modeArea);
    centerArea.add(actionRow);

    const bottomBar = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "row",
      justifyContent: "space-between",
    });
    const ready = new TextRenderable(renderer, {
      content: `zgap / ${t("ready")}`,
      fg: "#64748B",
      selectable: true,
    });
    const hint = new TextRenderable(renderer, {
      content: t("hint"),
      fg: "#64748B",
      selectable: true,
    });
    bottomBar.add(ready);
    bottomBar.add(hint);
    root.add(topBar);
    root.add(infoArea);
    root.add(centerArea);
    root.add(bottomBar);
    renderer.root.add(root);

    const applyResponsiveLayout = (width, height = renderer.height) => {
      const compact = width <= COMPACT_WIDTH || height <= 12;
      root.paddingTop = compact ? 0 : 1;
      root.paddingBottom = compact ? 0 : 1;
      topBar.flexDirection = compact ? "column" : "row";
      topBar.height = compact ? 3 : "auto";
      topBar.justifyContent = compact ? "flex-start" : "space-between";
      brand.width = compact ? "100%" : "auto";
      brand.paddingLeft = compact ? 0 : 1;
      tagline.visible = !compact;
      statusArea.width = compact ? "100%" : "auto";
      statusArea.alignItems = compact ? "flex-start" : "flex-end";
      statusArea.paddingRight = compact ? 0 : 1;
      centerArea.alignItems = compact ? "stretch" : "center";
      modeArea.height = compact ? 1 : 2;
      modeHint.visible = !compact;
      // With 4+ agent cards the stacked column no longer fits a 24-row terminal
      // next to the mode rail, so non-compact layouts wrap cards in two columns too.
      const grid = compact ? content.actions.length > 1 : actionGrid;
      actionRow.flexDirection = grid ? "row" : "column";
      actionRow.flexWrap = grid ? "wrap" : "nowrap";
      actionRow.width = compact ? "100%" : (actionGrid ? "88%" : "70%");
      actionRow.height = compact ? 3 : (actionGrid ? 8 : (content.actions.length > 1 ? (content.actions.length * 4 + (content.actions.length > 2 ? 0 : 1)) : 4));
      actionRow.gap = compact ? 0 : (actionGrid ? 1 : (content.actions.length > 2 ? 0 : (content.actions.length > 1 ? 1 : 0)));
      actionCards.forEach(({ card, label, description }, index) => {
        card.width = grid ? (compact ? `${Math.floor(100 / content.actions.length)}%` : "48%") : "100%";
        card.height = compact ? 3 : 4;
        card.paddingX = compact ? 0 : 1;
        description.visible = !compact;
        label.content = compact ? compactLabels[index] : fullLabels[index];
      });
      bottomBar.justifyContent = compact ? "flex-start" : "space-between";
      ready.visible = !compact;
      hint.content = compact ? t("compactHint") : t("hint");
      infoArea.paddingTop = compact ? 0 : 1;
      // Short terminals have no spare row after status, mode, actions, and the quit hint.
      infoArea.visible = updateStatus.content !== "" && !compact;
    };
    // Terminal resize keeps the primary action and quit instruction visible instead of clipping long locale strings.
    resizeHandler = (width, height) => applyResponsiveLayout(width, height);
    applyResponsiveLayout(renderer.width, renderer.height);
    const updateSelection = () => {
      actionCards.forEach(({ card, label }, index) => {
        const selected = index === selectedIndex;
        card.backgroundColor = selected ? "#0B171D" : "#000000";
        card.borderColor = selected ? "#67E8F9" : "#475569";
        label.fg = selected ? "#F8FAFC" : "#94A3B8";
      });
    };
    const updateDangerousMode = (saveFailed = false) => {
      const track = dangerousModeEnabled ? "○━━━━━━━━━━━━●" : "●━━━━━━━━━━━━○";
      modeRail.content = `${t("dangerousModeSafe")}  ${track}  ${t("dangerousModeYolo")}`;
      modeRail.fg = dangerousModeEnabled ? "#F87171" : "#86EFAC";
      modeHint.content = saveFailed ? t("dangerousModeSaveFailed") : t("dangerousModeSelectHint");
      modeHint.fg = saveFailed ? "#F87171" : "#64748B";
    };
    const setDangerousMode = async (enabled) => {
      if (modeChangePending || enabled === dangerousModeEnabled) return;
      modeChangePending = true;
      try {
        await onDangerousModeChange(enabled);
        if (cleaned) return;
        dangerousModeEnabled = enabled;
        updateDangerousMode();
      } catch {
        if (!cleaned) updateDangerousMode(true);
      } finally {
        modeChangePending = false;
      }
    };
    updateSelection();
    updateDangerousMode();
    renderer.on("resize", resizeHandler);
    const updateProxyStatus = async () => {
      while (!cleaned) {
        let health;
        try {
          health = await proxyHealthCheck({ origin, signal: proxyAbortController.signal });
        } catch {
          health = { state: "unreachable" };
        }
        if (cleaned) return;
        if (health?.state === "online" && Number.isFinite(health.latencyMs)) {
          proxyStatus.content = `● ${t("proxyOnline", { latency: health.latencyMs })}`;
          proxyStatus.fg = "#67E8F9";
        } else {
          proxyStatus.content = `● ${t("proxyUnreachable")}`;
          proxyStatus.fg = "#F87171";
        }
        try {
          await delay(PROXY_REFRESH_MS, undefined, { signal: proxyAbortController.signal });
        } catch {
          return;
        }
      }
    };
    void updateProxyStatus();
    if (updateChecker !== undefined) {
      Promise.resolve()
        .then(() => updateChecker({ signal: updateAbortController.signal }))
        .then((update) => {
          if (cleaned || update?.state === "skipped" || update?.state === "current") return;
          if (update?.state === "updated" && update.commitDate) {
            const date = new Date(update.commitDate);
            if (!Number.isNaN(date.valueOf())) {
              updateStatus.content = t("updatedVersion", {
                date: new Intl.DateTimeFormat(localeFor(language), {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                }).format(date),
              });
              infoArea.visible = renderer.width > COMPACT_WIDTH && renderer.height > 12;
              return;
            }
          }
          updateStatus.content = t("updateFailed");
          updateStatus.fg = "#F87171";
          infoArea.visible = renderer.width > COMPACT_WIDTH && renderer.height > 12;
        }).catch(() => {
          if (cleaned) return;
          updateStatus.content = t("updateFailed");
          updateStatus.fg = "#F87171";
          infoArea.visible = renderer.width > COMPACT_WIDTH && renderer.height > 12;
        });
    }

    let lastCtrlC = null;
    let lastEscape = null;
    keyHandler = (event) => {
      if (settled || event.eventType !== "press") return;
      const timestamp = now();
      if (event.ctrl && event.name === "c") {
        if (lastCtrlC !== null && timestamp - lastCtrlC <= 1_000) {
          void finish(async () => 130);
        } else {
          lastCtrlC = timestamp;
        }
        return;
      }
      if (event.name === "escape") {
        if (lastEscape !== null && timestamp - lastEscape <= 1_000) {
          void finish(async () => 130);
        } else {
          lastEscape = timestamp;
        }
        return;
      }
      if (
        !event.ctrl && !event.meta && !event.shift
        && (event.name === "left" || event.name === "right")
      ) {
        void setDangerousMode(event.name === "right");
        return;
      }
      if (modeChangePending) return;
      if (content.actions.length > 1 && (event.name === "up" || event.name === "down")) {
        const delta = event.name === "down" ? 1 : -1;
        selectedIndex = Math.max(0, Math.min(content.actions.length - 1, selectedIndex + delta));
        updateSelection();
        return;
      }
      if (event.name === "return" || event.name === "enter" || event.name === "linefeed") {
        runSelectedAction();
      }
    };
    renderer.keyInput.on("keypress", keyHandler);
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}
