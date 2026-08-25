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
const ORBIT_SPINNER = {
  frames: ["● · · ·", "· ● · ·", "· · ● ·", "· · · ●", "· · ● ·", "· ● · ·"],
  interval: 90,
};
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
  ompLeanMode = false,
  ompLeanSkills = [],
  onDangerousModeChange = async () => { throw new Error("Missing dangerous mode persistence handler."); },
  onOmpLeanModeChange = async () => { throw new Error("Missing OMP lean mode persistence handler."); },
  onOmpSkillsLoad = async () => { throw new Error("Missing OMP skill loader."); },
  onOmpLeanSkillsChange = async () => { throw new Error("Missing OMP lean skills persistence handler."); },
} = {}) {
  let renderer;
  let keyHandler;
  let resizeHandler;
  let skillSpinnerTimer = null;
  const proxyAbortController = new AbortController();
  const updateAbortController = new AbortController();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    proxyAbortController.abort();
    updateAbortController.abort();
    if (skillSpinnerTimer !== null) clearInterval(skillSpinnerTimer);
    skillSpinnerTimer = null;
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
    let ompLeanModeEnabled = ompLeanMode;
    let ompLeanSkillsEnabled = new Set(ompLeanSkills);
    let modeChangePending = false;
    let leanConfirmationVisible = false;
    let skillPickerVisible = false;
    let skillPickerState = "idle";
    let availableSkills = [];
    let pendingLeanSkills = new Set();
    let skillPickerIndex = 0;
    let skillPickerViewport = 0;
    let skillPickerError = null;
    let skillSpinnerIndex = 0;
    let skillPickerGeneration = 0;
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
    let actionColumns = 1;
    // Compact single-row cards drop the Enter suffix so all agent labels fit narrow terminals.
    const labelFor = (item, compact = false) => {
      const skillCount = ompLeanSkillsEnabled.size;
      const leanLabel = item.name === "omp" && ompLeanModeEnabled
        ? ` · LEAN${skillCount > 0 ? ` · ${skillCount}` : ""}`
        : "";
      return `${item.label}${leanLabel}${compact ? "" : "  ↵"}`;
    };
    const fullLabels = content.actions.map((item) => labelFor(item));
    const compactLabels = content.actions.map((item) => labelFor(item, true));
    const ompActionIndex = content.actions.findIndex((item) => item.name === "omp");
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
    const leanConfirmationOverlay = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "#000000",
      justifyContent: "center",
      alignItems: "center",
      visible: false,
    });
    const leanConfirmationDialog = new BoxRenderable(renderer, {
      width: 72,
      height: 8,
      backgroundColor: "#0B171D",
      border: true,
      borderStyle: "rounded",
      borderColor: "#FCD34D",
      flexDirection: "column",
      justifyContent: "center",
      paddingX: 2,
    });
    const leanConfirmationTitle = new TextRenderable(renderer, {
      content: t("ompLeanConfirmTitle"),
      fg: "#FCD34D",
      attributes: TextAttributes.BOLD,
      selectable: true,
    });
    const leanConfirmationWarning = new TextRenderable(renderer, {
      content: t("ompLeanConfirmWarning"),
      fg: "#F8FAFC",
      selectable: true,
    });
    const leanConfirmationDetails = new TextRenderable(renderer, {
      content: t("ompLeanConfirmDetails"),
      fg: "#94A3B8",
      selectable: true,
    });
    const leanConfirmationHint = new TextRenderable(renderer, {
      content: t("ompLeanConfirmHint"),
      fg: "#67E8F9",
      attributes: TextAttributes.BOLD,
      selectable: true,
    });
    leanConfirmationDialog.add(leanConfirmationTitle);
    leanConfirmationDialog.add(leanConfirmationWarning);
    leanConfirmationDialog.add(leanConfirmationDetails);
    leanConfirmationDialog.add(leanConfirmationHint);
    leanConfirmationOverlay.add(leanConfirmationDialog);
    const skillPickerOverlay = new BoxRenderable(renderer, {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "#000000",
      justifyContent: "center",
      alignItems: "center",
      visible: false,
    });
    const skillPickerDialog = new BoxRenderable(renderer, {
      width: 72,
      height: 20,
      backgroundColor: "#0B171D",
      border: true,
      borderStyle: "rounded",
      borderColor: "#67E8F9",
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
    });
    const skillPickerTitle = new TextRenderable(renderer, {
      content: t("ompLeanSkillsTitle"),
      fg: "#67E8F9",
      attributes: TextAttributes.BOLD,
      height: 1,
      flexShrink: 0,
      selectable: true,
    });
    const skillPickerList = new TextRenderable(renderer, {
      content: "",
      fg: "#E2E8F0",
      flexGrow: 1,
      selectable: true,
    });
    const skillPickerHint = new TextRenderable(renderer, {
      content: t("ompLeanSkillsHint"),
      fg: "#94A3B8",
      height: 1,
      maxHeight: 2,
      flexShrink: 0,
      selectable: true,
    });
    skillPickerDialog.add(skillPickerTitle);
    skillPickerDialog.add(skillPickerList);
    skillPickerDialog.add(skillPickerHint);
    skillPickerOverlay.add(skillPickerDialog);
    root.add(topBar);
    root.add(infoArea);
    root.add(centerArea);
    root.add(bottomBar);
    root.add(leanConfirmationOverlay);
    root.add(skillPickerOverlay);
    renderer.root.add(root);

    const updateMenuHint = () => {
      const compact = renderer.width <= COMPACT_WIDTH || renderer.height <= 12 || (actionGrid && (renderer.width <= 80 || renderer.height <= 18));
      const skillsShortcut = selectedIndex === ompActionIndex && ompLeanModeEnabled;
      hint.content = t(compact
        ? skillsShortcut ? "compactHintLean" : "compactHint"
        : skillsShortcut ? "hintLean" : "hint");
    };
    const applyResponsiveLayout = (width, height = renderer.height) => {
      // Four full cards need 81 columns and 19 rows before labels, descriptions, and the footer stop colliding.
      const compact = width <= COMPACT_WIDTH || height <= 12 || (actionGrid && (width <= 80 || height <= 18));
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
      actionColumns = grid ? (compact ? content.actions.length : 2) : 1;
      actionRow.flexDirection = grid ? "row" : "column";
      actionRow.flexWrap = grid ? "wrap" : "nowrap";
      actionRow.width = compact ? "100%" : (actionGrid ? "88%" : "70%");
      actionRow.height = compact ? 3 : (actionGrid ? 8 : (content.actions.length > 1 ? (content.actions.length * 4 + (content.actions.length > 2 ? 0 : 1)) : 4));
      actionRow.gap = compact ? 0 : (actionGrid ? 1 : (content.actions.length > 2 ? 0 : (content.actions.length > 1 ? 1 : 0)));
      actionCards.forEach(({ card, label, description }, index) => {
        // Intrinsic compact widths keep long labels from overwriting their right border at 40 columns.
        card.width = grid ? (compact ? "auto" : "48%") : "100%";
        card.flexGrow = compact ? 1 : 0;
        card.height = compact ? 3 : 4;
        card.paddingX = compact ? 0 : 1;
        description.visible = !compact;
        label.content = compact ? compactLabels[index] : fullLabels[index];
      });
      bottomBar.justifyContent = compact ? "flex-start" : "space-between";
      ready.visible = !compact;
      updateMenuHint();
      infoArea.paddingTop = compact ? 0 : 1;
      leanConfirmationDialog.width = compact ? "100%" : 72;
      leanConfirmationDialog.height = compact ? 9 : 8;
      leanConfirmationDetails.visible = !compact;
      skillPickerDialog.width = compact ? "100%" : Math.min(80, Math.max(40, width - 4));
      skillPickerDialog.height = compact ? "100%" : Math.min(20, Math.max(10, height - 4));
      skillPickerDialog.paddingX = compact ? 1 : 2;
      skillPickerDialog.paddingY = compact ? 0 : 1;
      skillPickerHint.height = compact ? 2 : 1;
      skillPickerHint.maxHeight = compact ? 2 : 1;
      // Short terminals have no spare row after status, mode, actions, and the quit hint.
      infoArea.visible = updateStatus.content !== "" && !compact;
    };
    // Terminal resize keeps the primary action and quit instruction visible instead of clipping long locale strings.
    resizeHandler = (width, height) => {
      applyResponsiveLayout(width, height);
      if (skillPickerVisible) renderSkillPicker();
    };
    applyResponsiveLayout(renderer.width, renderer.height);
    const skillPickerVisibleRows = () => {
      const compact = renderer.width <= COMPACT_WIDTH || renderer.height <= 12 || (actionGrid && (renderer.width <= 80 || renderer.height <= 18));
      const dialogHeight = compact ? renderer.height : Math.min(20, Math.max(10, renderer.height - 4));
      return Math.max(1, dialogHeight - (compact ? 5 : 6));
    };
    const stopSkillSpinner = () => {
      if (skillSpinnerTimer !== null) clearInterval(skillSpinnerTimer);
      skillSpinnerTimer = null;
    };
    const renderSkillPicker = () => {
      if (!skillPickerVisible) {
        stopSkillSpinner();
        return;
      }
      const spinning = skillPickerState === "loading" || skillPickerState === "saving";
      if (spinning && skillSpinnerTimer === null) {
        skillSpinnerTimer = setInterval(() => {
          skillSpinnerIndex = (skillSpinnerIndex + 1) % ORBIT_SPINNER.frames.length;
          if (!cleaned) renderSkillPicker();
        }, ORBIT_SPINNER.interval);
      } else if (!spinning) {
        stopSkillSpinner();
      }
      if (skillPickerState === "loading") {
        skillPickerList.content = `${ORBIT_SPINNER.frames[skillSpinnerIndex]} ${t("ompLeanSkillsLoading")}`;
        skillPickerHint.content = t("ompLeanSkillsCancelHint");
        skillPickerHint.fg = "#94A3B8";
        skillPickerList.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      if (skillPickerState === "saving") {
        skillPickerList.content = `${ORBIT_SPINNER.frames[skillSpinnerIndex]} ${t("ompLeanSkillsSaving")}`;
        skillPickerHint.content = t("ompLeanSkillsSavingHint");
        skillPickerHint.fg = "#94A3B8";
        skillPickerList.fg = "#94A3B8";
        renderer.requestRender();
        return;
      }
      if (skillPickerState === "error") {
        skillPickerList.content = `${t("ompLeanSkillsLoadFailed")}: ${skillPickerError?.message ?? t("ompLeanSkillsUnknownError")}`;
        skillPickerHint.content = t("ompLeanSkillsCancelHint");
        skillPickerHint.fg = "#94A3B8";
        skillPickerList.fg = "#F87171";
        renderer.requestRender();
        return;
      }
      const count = skillPickerVisibleRows();
      skillPickerIndex = Math.max(0, Math.min(skillPickerIndex, Math.max(0, availableSkills.length - 1)));
      if (skillPickerIndex < skillPickerViewport) skillPickerViewport = skillPickerIndex;
      if (skillPickerIndex >= skillPickerViewport + count) skillPickerViewport = skillPickerIndex - count + 1;
      skillPickerViewport = Math.max(0, Math.min(skillPickerViewport, Math.max(0, availableSkills.length - count)));
      const compact = renderer.width <= COMPACT_WIDTH || renderer.height <= 12;
      const rowWidth = Math.max(12, renderer.width - (compact ? 6 : 14));
      const rows = availableSkills.slice(skillPickerViewport, skillPickerViewport + count).map((skill, offset) => {
        const index = skillPickerViewport + offset;
        const prefix = `${index === skillPickerIndex ? ">" : " "} [${pendingLeanSkills.has(skill.name) ? "x" : " "}] `;
        const source = compact || !skill.source ? "" : `  ${skill.source}`;
        return `${prefix}${skill.name}${source}`.slice(0, rowWidth);
      });
      skillPickerList.content = rows.length > 0 ? rows.join("\n") : t("ompLeanSkillsEmpty");
      skillPickerList.fg = "#E2E8F0";
      skillPickerHint.content = skillPickerError
        ? t("ompLeanSkillsSaveFailed")
        : t("ompLeanSkillsHint", { count: pendingLeanSkills.size });
      skillPickerHint.fg = skillPickerError ? "#F87171" : "#94A3B8";
      renderer.requestRender();
    };
    const updateSelection = () => {
      actionCards.forEach(({ card, label }, index) => {
        const selected = index === selectedIndex;
        card.backgroundColor = selected ? "#0B171D" : "#000000";
        card.borderColor = selected ? "#67E8F9" : "#475569";
        label.fg = selected ? "#F8FAFC" : "#94A3B8";
      });
      updateDangerousMode();
    };
    const updateDangerousMode = (saveFailed = false) => {
      const track = dangerousModeEnabled ? "○━━━━━━━━━━━━●" : "●━━━━━━━━━━━━○";
      modeRail.content = `${t("dangerousModeSafe")}  ${track}  ${t("dangerousModeYolo")}`;
      modeRail.fg = dangerousModeEnabled ? "#F87171" : "#86EFAC";
      modeHint.content = saveFailed
        ? t("dangerousModeSaveFailed")
        : selectedIndex === ompActionIndex && ompLeanModeEnabled
          ? t("ompLeanSkillsOpenHint", { count: ompLeanSkillsEnabled.size })
          : t("dangerousModeSelectHint");
      modeHint.fg = saveFailed ? "#F87171" : "#64748B";
      updateMenuHint();
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
    const updateOmpLeanMode = (saveFailed = false) => {
      if (ompActionIndex < 0) return;
      fullLabels[ompActionIndex] = labelFor(content.actions[ompActionIndex]);
      compactLabels[ompActionIndex] = labelFor(content.actions[ompActionIndex], true);
      applyResponsiveLayout(renderer.width, renderer.height);
      if (saveFailed) {
        modeHint.content = t("ompLeanModeSaveFailed");
        modeHint.fg = "#F87171";
      } else {
        updateDangerousMode();
      }
    };
    const setOmpLeanMode = async (enabled) => {
      if (modeChangePending || enabled === ompLeanModeEnabled || ompActionIndex < 0) return;
      modeChangePending = true;
      try {
        await onOmpLeanModeChange(enabled);
        if (cleaned) return;
        ompLeanModeEnabled = enabled;
        updateOmpLeanMode();
      } catch {
        if (!cleaned) updateOmpLeanMode(true);
      } finally {
        modeChangePending = false;
      }
    };
    const showLeanConfirmation = () => {
      if (modeChangePending || ompActionIndex < 0) return;
      leanConfirmationVisible = true;
      leanConfirmationOverlay.visible = true;
    };
    const hideLeanConfirmation = () => {
      leanConfirmationVisible = false;
      leanConfirmationOverlay.visible = false;
    };
    const hideSkillPicker = () => {
      skillPickerGeneration += 1;
      skillPickerVisible = false;
      skillPickerOverlay.visible = false;
      stopSkillSpinner();
      renderer.requestRender();
    };
    const showSkillPicker = async () => {
      if (modeChangePending || !ompLeanModeEnabled || selectedIndex !== ompActionIndex) return;
      const generation = ++skillPickerGeneration;
      skillPickerVisible = true;
      skillPickerOverlay.visible = true;
      skillPickerState = "loading";
      skillPickerError = null;
      skillSpinnerIndex = 0;
      renderSkillPicker();
      try {
        const loaded = await onOmpSkillsLoad();
        if (cleaned || !skillPickerVisible || generation !== skillPickerGeneration) return;
        if (!Array.isArray(loaded)) throw new TypeError("OMP skill loader must return an array.");
        const names = new Set();
        availableSkills = loaded.map((skill) => {
          if (!skill || typeof skill !== "object" || typeof skill.name !== "string" || skill.name.length === 0) {
            throw new TypeError("OMP skill loader returned an invalid skill.");
          }
          return { name: skill.name, source: typeof skill.source === "string" ? skill.source : "" };
        }).filter((skill) => {
          if (names.has(skill.name)) return false;
          names.add(skill.name);
          return true;
        });
        for (const name of ompLeanSkillsEnabled) {
          if (!names.has(name)) availableSkills.push({ name, source: t("ompLeanSkillsMissingSource") });
        }
        pendingLeanSkills = new Set(ompLeanSkillsEnabled);
        skillPickerIndex = Math.max(0, availableSkills.findIndex((skill) => pendingLeanSkills.has(skill.name)));
        skillPickerViewport = 0;
        skillPickerState = "ready";
      } catch (error) {
        if (cleaned || !skillPickerVisible || generation !== skillPickerGeneration) return;
        skillPickerError = error instanceof Error ? error : new Error(String(error));
        skillPickerState = "error";
      }
      renderSkillPicker();
    };
    const saveSkillPicker = async () => {
      if (skillPickerState !== "ready") return;
      const selectedSkills = availableSkills
        .filter((skill) => pendingLeanSkills.has(skill.name))
        .map((skill) => skill.name);
      skillPickerState = "saving";
      skillPickerError = null;
      renderSkillPicker();
      try {
        await onOmpLeanSkillsChange(selectedSkills);
        if (cleaned || !skillPickerVisible) return;
        ompLeanSkillsEnabled = new Set(selectedSkills);
        hideSkillPicker();
        updateOmpLeanMode();
      } catch (error) {
        if (cleaned || !skillPickerVisible) return;
        skillPickerError = error instanceof Error ? error : new Error(String(error));
        skillPickerState = "ready";
        renderSkillPicker();
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
              applyResponsiveLayout(renderer.width, renderer.height);
              return;
            }
          }
          updateStatus.content = t("updateFailed");
          updateStatus.fg = "#F87171";
          applyResponsiveLayout(renderer.width, renderer.height);
        }).catch(() => {
          if (cleaned) return;
          updateStatus.content = t("updateFailed");
          updateStatus.fg = "#F87171";
          applyResponsiveLayout(renderer.width, renderer.height);
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
      const noModifiers = !event.ctrl && !event.meta && !event.option && !event.shift && !event.super && !event.hyper;
      if (skillPickerVisible) {
        if (!noModifiers) return;
        if (event.name === "escape") {
          hideSkillPicker();
          lastEscape = null;
          return;
        }
        if (skillPickerState !== "ready") return;
        if (event.name === "up") skillPickerIndex -= 1;
        else if (event.name === "down") skillPickerIndex += 1;
        else if (event.name === "home") skillPickerIndex = 0;
        else if (event.name === "end") skillPickerIndex = availableSkills.length - 1;
        else if (event.name === "pageup") skillPickerIndex -= skillPickerVisibleRows();
        else if (event.name === "pagedown") skillPickerIndex += skillPickerVisibleRows();
        else if (event.name === "space" && availableSkills[skillPickerIndex]) {
          const name = availableSkills[skillPickerIndex].name;
          if (pendingLeanSkills.has(name)) pendingLeanSkills.delete(name);
          else pendingLeanSkills.add(name);
        } else if (event.name === "return" || event.name === "enter" || event.name === "linefeed") {
          void saveSkillPicker();
          return;
        } else {
          return;
        }
        renderSkillPicker();
        return;
      }
      if (leanConfirmationVisible) {
        if (noModifiers && event.name === "escape") {
          hideLeanConfirmation();
          lastEscape = null;
          return;
        }
        if (noModifiers && (event.name === "return" || event.name === "enter" || event.name === "linefeed")) {
          hideLeanConfirmation();
          void setOmpLeanMode(true);
          return;
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
      if (noModifiers && event.name === "tab") {
        void setDangerousMode(!dangerousModeEnabled);
        return;
      }
      if (noModifiers && event.name === "l") {
        if (ompLeanModeEnabled) void setOmpLeanMode(false);
        else showLeanConfirmation();
        return;
      }
      if (noModifiers && event.name === "space") {
        void showSkillPicker();
        return;
      }
      if (modeChangePending) return;
      if (content.actions.length > 1 && ["up", "down", "left", "right"].includes(event.name)) {
        if (event.name === "left" && selectedIndex % actionColumns > 0) selectedIndex -= 1;
        if (event.name === "right" && selectedIndex % actionColumns < actionColumns - 1 && selectedIndex + 1 < content.actions.length) selectedIndex += 1;
        if (event.name === "up" && selectedIndex >= actionColumns) selectedIndex -= actionColumns;
        if (event.name === "down" && selectedIndex + actionColumns < content.actions.length) selectedIndex += actionColumns;
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
