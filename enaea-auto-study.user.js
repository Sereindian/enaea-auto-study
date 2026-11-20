// ==UserScript==
// @name         ENAEA 新版学习平台自动连播助手 (estudy.enaea.edu.cn)
// @namespace    https://github.com/Sereindian/enaea-auto-study
// @version      1.0.4
// @description  支持 estudy.enaea.edu.cn 看完自动切P、完成课程自动切下一课程、看完一章自动切章节、自动锁定1.25倍速播放；遇行为验证/人脸识别自动暂停并提醒人工处理。
// @author       Sereindian
// @license      MIT
// @homepageURL  https://github.com/Sereindian/enaea-auto-study
// @supportURL   https://github.com/Sereindian/enaea-auto-study/issues
// @match        https://estudy.enaea.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG_KEY = "enaea_auto_study_config_v1";
  const SESSION_KEY = "enaea_auto_study_session_v1";
  const PANEL_ID = "enaea-auto-study-hud";
  const FINISHED_RESOURCE_TTL_MS = 95000;

  const DEFAULT_CONFIG = {
    enabled: true,
    autoMute: true,
    lockRate125: true,
    autoSkipEval: true,
    autoDismissWelcome: true,
    courseSwitchMode: "hybrid", // "hybrid" (优先下一课+章末回目录切章) | "list" (总是回目录按章选课)
    alertSound: true,
    panelCollapsed: false,
  };

  const VERIFY_KEYWORDS = [
    "行为验证",
    "请输入右侧验证码",
    "人脸识别",
    "滑块验证",
    "安全验证",
    "请完成验证",
  ];

  const STATUS_META = {
    IDLE: { label: "已暂停", tone: "neutral" },
    RUNNING: { label: "运行中", tone: "active" },
    VERIFY_REQUIRED: { label: "等待人工验证", tone: "danger" },
    DAILY_LIMIT: { label: "已达每日上限", tone: "warn" },
    ALL_COMPLETED: { label: "全部章节已完成", tone: "success" },
  };

  // --- Storage helpers (Tampermonkey GM_* with Web Storage fallback) ---

  function readGM(key, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        const val = GM_getValue(key, undefined);
        if (val !== undefined) return val;
      }
    } catch (_) {}
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeGM(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
      }
    } catch (_) {}
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function loadConfig() {
    const saved = readGM(CONFIG_KEY, null);
    if (!saved || typeof saved !== "object") {
      const initial = { ...DEFAULT_CONFIG };
      saveConfig(initial);
      return initial;
    }
    return { ...DEFAULT_CONFIG, ...saved };
  }

  function saveConfig(cfg) {
    writeGM(CONFIG_KEY, cfg);
  }

  function createEmptySession() {
    return {
      lastCourseListUrl: "",
      finishedResources: {},
      finishedCourses: {},
      skippedCourses: {},
      consecutiveCompletedHops: 0,
    };
  }

  function loadSession() {
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return createEmptySession();
      const parsed = JSON.parse(raw);
      return {
        ...createEmptySession(),
        ...parsed,
        finishedResources: parsed.finishedResources || {},
        finishedCourses: parsed.finishedCourses || {},
        skippedCourses: parsed.skippedCourses || {},
      };
    } catch (_) {
      return createEmptySession();
    }
  }

  function saveSession(ses) {
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(ses));
    } catch (_) {}
  }

  // --- Runtime state ---

  let config = loadConfig();
  let session = loadSession();

  const runtime = {
    status: config.enabled ? "RUNNING" : "IDLE",
    lastUrl: "",
    pageEnteredAt: Date.now(),
    activeEpisodeSig: "",
    lastEpisodeMeta: null, // { taskId, resourceId, curIdx, curTitle, sig }
    episodeEnteredAt: Date.now(),
    pendingEnd: null, // { sig, at }
    endedVideoSrc: "",
    endedAtEpisodeSig: "",
    currentEpisodeVideoSrc: "",
    prevEpisodeVideoSrc: "",
    sawActivePlaybackOnSig: false,
    manualResetTarget: null, // { taskId, idx, title, at }
    watchedUnfinished: false,
    playAttemptAt: 0,
    playFailCount: 0,
    lastRateApplyAt: 0,
    applyingRate: false,
    applyingMute: false,
    rateUnsupportedLoggedFor: "",
    modalActionAt: 0,
    expandCooldownUntil: 0,
    listActionCooldownUntil: 0,
    waitingCourseSwitch: null, // { beforeUrl, at }
    waitingReturnToList: null, // { beforeUrl, at }
    lastClickedCourseTitle: "",
    verifyAlertActive: false,
    titleFlashTimer: null,
    originalTitle: "",
    statusDetail: "等待检测页面...",
    logs: [],
  };

  const boundVideos = new WeakSet();

  // --- Logging & HUD updates ---

  function pushLog(msg) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    runtime.logs.unshift(`[${ts}] ${msg}`);
    if (runtime.logs.length > 20) runtime.logs.length = 20;
    updateHUD();
  }

  function setStatus(status, detail) {
    runtime.status = status;
    if (detail !== undefined) runtime.statusDetail = detail;
    updateHUD();
  }

  // --- DOM Helpers ---

  function isVisible(el) {
    if (!el) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute && cur.hasAttribute("hidden")) return false;
      if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return false;
      if (cur.style) {
        if (cur.style.display === "none" || cur.style.visibility === "hidden") return false;
      }
      if (typeof window.getComputedStyle === "function") {
        const cs = window.getComputedStyle(cur);
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
      }
      cur = cur.parentElement;
    }
    return true;
  }

  function normText(el) {
    return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  function isCollapseExpanded(panel) {
    return (
      panel.classList.contains("grt-collapse-item-active") ||
      panel.classList.contains("ant-collapse-item-active")
    );
  }

  function getDirectHeader(panel) {
    const direct = Array.from(panel.children || []).find(
      (ch) =>
        ch.classList.contains("grt-collapse-header") ||
        ch.classList.contains("ant-collapse-header")
    );
    return direct || panel.querySelector(".grt-collapse-header, .ant-collapse-header");
  }

  function getDirectContent(panel) {
    return Array.from(panel.children || []).find(
      (ch) =>
        ch.classList.contains("grt-collapse-content") ||
        ch.classList.contains("ant-collapse-content")
    );
  }

  function getDirectCollapseItems(collapseEl) {
    if (!collapseEl) return [];
    return Array.from(collapseEl.children || []).filter(
      (ch) =>
        ch.classList.contains("grt-collapse-item") ||
        ch.classList.contains("ant-collapse-item")
    );
  }

  function getRouteKind(pathname) {
    if (/\/(requiredCourse|requiredCourse-two|electiveCourses|electiveCourses-two)(\/|\?|$)/i.test(pathname)) {
      return "list";
    }
    if (/\/player\/(project|parent-school|open-course)(\/|\?|$)/i.test(pathname)) {
      return "player";
    }
    return "other";
  }

  function getQueryParams() {
    try {
      return new URLSearchParams(window.location.search || "");
    } catch (_) {
      return new URLSearchParams();
    }
  }

  function isProgressTextDone(txt) {
    const clean = (txt || "").replace(/\s+/g, "").trim();
    return clean === "完成" || clean === "100%";
  }

  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "00:00";
    const s = Math.floor(sec);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  // --- Alerting for manual verification / daily limit ---

  function playBeep() {
    if (!config.alertSound) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [0, 0.22].forEach((offset) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = offset === 0 ? 880 : 1046;
        gain.gain.setValueAtTime(0.08, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.18);
      });
    } catch (_) {}
  }

  function notifyUser(title, text) {
    try {
      if (typeof GM_notification === "function") {
        GM_notification({ title, text, timeout: 6000 });
      }
    } catch (_) {}
  }

  function startVerifyAlert() {
    if (runtime.verifyAlertActive) return;
    runtime.verifyAlertActive = true;
    runtime.originalTitle = document.title || "中国教育干部网络学院";
    let toggle = false;
    runtime.titleFlashTimer = window.setInterval(() => {
      toggle = !toggle;
      document.title = toggle
        ? `【请手动完成验证】${runtime.originalTitle}`
        : runtime.originalTitle;
    }, 1000);
    playBeep();
    notifyUser("ENAEA 自动学习已暂停", "检测到行为验证或人脸识别弹窗，请手动完成验证。");
    pushLog("⚠️ 检测到验证弹窗，脚本已暂停等待人工处理");
  }

  function clearVerifyAlert() {
    if (!runtime.verifyAlertActive) return;
    runtime.verifyAlertActive = false;
    if (runtime.titleFlashTimer) {
      window.clearInterval(runtime.titleFlashTimer);
      runtime.titleFlashTimer = null;
    }
    if (runtime.originalTitle) {
      document.title = runtime.originalTitle;
    }
    pushLog("✅ 验证弹窗已关闭，恢复自动学习");
  }

  // --- Modal detection (Safety-first priority order) ---

  function findButtonByText(container, textCandidates) {
    const buttons = Array.from(
      container.querySelectorAll("button.grt-btn, button.ant-btn, button, [role='button']")
    );
    for (const candidate of textCandidates) {
      const match = buttons.find((btn) => isVisible(btn) && normText(btn).includes(candidate));
      if (match) return match;
    }
    return null;
  }

  function checkModals(now) {
    // Priority 1: Captcha / Anti-hangup / Face verification — NEVER click or bypass.
    const verifyTargets = Array.from(
      document.querySelectorAll(
        '[class*="mask_"] [class*="main-box_"], [class*="code-wrap_"], .sliderCaptcha, .grt-modal-custom-wrap, .grt-modal-wrap, .ant-modal-wrap'
      )
    );
    const hasVerify = verifyTargets.some((el) => {
      if (!isVisible(el)) return false;
      if (el.classList && el.classList.contains("sliderCaptcha")) return true;
      const text = normText(el);
      return VERIFY_KEYWORDS.some((kw) => text.includes(kw));
    });

    if (hasVerify) {
      startVerifyAlert();
      setStatus("VERIFY_REQUIRED", "请手动完成行为验证 / 人脸识别（完成后自动恢复）");
      return "BLOCKED";
    }

    clearVerifyAlert();

    const modals = Array.from(
      document.querySelectorAll(
        ".grt-modal-wrap, .grt-modal-custom-wrap, .ant-modal-wrap, #other-modal-root .grt-modal, #other-modal-root .ant-modal"
      )
    ).filter(isVisible);

    // Priority 2: Daily study cap reached -> stop automation cleanly.
    for (const modal of modals) {
      const text = normText(modal);
      if (text.includes("已达到每日学习上限") || text.includes("每日学习上限")) {
        config.enabled = false;
        saveConfig(config);
        setStatus("DAILY_LIMIT", "今日学习时长已达上限，脚本已自动停止");
        pushLog("🛑 已达到每日学习上限，停止刷课");
        notifyUser("ENAEA 自动学习已停止", "已达到每日学习上限，明天再继续吧！");
        return "STOPPED";
      }
    }

    // Priority 3: External / third-party course warning -> record skip & close modal.
    for (const modal of modals) {
      const text = normText(modal);
      if (
        text.includes("暂不支持断点续播") &&
        (text.includes("外链") || text.includes("第三方"))
      ) {
        if (runtime.lastClickedCourseTitle) {
          session.skippedCourses[runtime.lastClickedCourseTitle] = "external";
          saveSession(session);
        }
        if (now - runtime.modalActionAt >= 2000) {
          const cancelBtn =
            findButtonByText(modal, ["取消", "关闭"]) ||
            modal.querySelector(".grt-modal-close, .ant-modal-close");
          if (cancelBtn && isVisible(cancelBtn)) {
            runtime.modalActionAt = now;
            cancelBtn.click();
            pushLog(`⏭️ 跳过外链/第三方课程: ${runtime.lastClickedCourseTitle || "未知课程"}`);
            return "HANDLED";
          }
        }
        setStatus("RUNNING", "遇到外链课程提示，等待关闭");
        return "BLOCKED";
      }
    }

    // Priority 4: 90% course evaluation modal -> click official "暂不评价" button.
    if (config.autoSkipEval && now - runtime.modalActionAt >= 2500) {
      for (const modal of modals) {
        const text = normText(modal);
        if (text.includes("我要评价") || text.includes("对本门课程进行评价")) {
          const skipBtn = findButtonByText(modal, ["暂不评价"]);
          if (skipBtn) {
            runtime.modalActionAt = now;
            skipBtn.click();
            pushLog("⏭️ 已点击「暂不评价」关闭评价弹窗");
            return "HANDLED";
          }
        }
      }
    }

    // Priority 5: Daily HeartBeatHelper welcome tip -> click "知道了".
    if (config.autoDismissWelcome && now - runtime.modalActionAt >= 2000) {
      for (const modal of modals) {
        const text = normText(modal);
        const isVerifyText = VERIFY_KEYWORDS.some((kw) => text.includes(kw));
        if (!isVerifyText && text.includes("欢迎进入学习")) {
          const okBtn = findButtonByText(modal, ["知道了", "确定"]);
          if (okBtn) {
            runtime.modalActionAt = now;
            okBtn.click();
            pushLog("💬 已关闭「温馨提示」弹窗");
            return "HANDLED";
          }
        }
      }
    }

    return "NONE";
  }

  // --- Player Page State Machine ---

  function markEpisodeFinished(taskId, resourceId, idx, title) {
    let changed = false;
    if (taskId && resourceId) {
      const rKey = `${taskId}::res::${resourceId}`;
      if (!session.finishedResources[rKey]) {
        session.finishedResources[rKey] = Date.now();
        changed = true;
      }
    }
    if (taskId && idx >= 0 && title) {
      const eKey = `${taskId}::ep::${idx}::${title}`;
      if (!session.finishedResources[eKey]) {
        session.finishedResources[eKey] = Date.now();
        changed = true;
      }
    }
    if (changed) saveSession(session);
  }

  function markCourseFinished(taskId, courseTitle) {
    let changed = false;
    if (taskId && !session.finishedCourses[taskId]) {
      session.finishedCourses[taskId] = Date.now();
      changed = true;
    }
    if (courseTitle && !session.finishedCourses[courseTitle]) {
      session.finishedCourses[courseTitle] = Date.now();
      changed = true;
    }
    if (changed) saveSession(session);
  }

  function getCurrentCourseTitle() {
    const headerTitle = document.querySelector('[class*="header-title_"]');
    if (!headerTitle) return "";
    const spans = headerTitle.querySelectorAll(":scope > span");
    if (spans.length >= 2) {
      return normText(spans[spans.length - 1]);
    }
    return normText(headerTitle);
  }

  function getPlaylistWrap() {
    const wrap = document.querySelector('[class*="play-list-wrap_"]');
    if (wrap && isVisible(wrap)) return wrap;
    return null;
  }

  function ensurePlaylistTabAndExpanded(now) {
    let wrap = getPlaylistWrap();
    if (!wrap) {
      const rightBox = document.getElementById("rightBox") || document;
      const tabs = Array.from(
        rightBox.querySelectorAll('.grt-tabs-tab, .ant-tabs-tab, [role="tab"], [class*="tab"]')
      );
      const dirTab = tabs.find((t) => normText(t) === "目录");
      if (dirTab && now - runtime.expandCooldownUntil >= 1000) {
        runtime.expandCooldownUntil = now;
        dirTab.click();
      }
      wrap = getPlaylistWrap();
    }
    if (!wrap) return null;

    // Expand any collapsed sub-chapters inside 目录 so cross-chapter episode scanning works.
    if (now - runtime.expandCooldownUntil >= 700) {
      const collapsed = wrap.querySelector(
        ".grt-collapse-item:not(.grt-collapse-item-active), .ant-collapse-item:not(.ant-collapse-item-active)"
      );
      if (collapsed) {
        const hdr = getDirectHeader(collapsed);
        if (hdr) {
          runtime.expandCooldownUntil = now;
          hdr.click();
        }
      }
    }
    return wrap;
  }

  function parseDurationTextSec(text) {
    const raw = (text || "").replace(/\s+/g, " ").trim();
    if (!raw) return 0;

    // Match Chinese format like "1 时 05 分 26 秒" / "20 分 15 秒" / "45 秒"
    const cnMatch = raw.match(/(?:(\d+)\s*时)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/);
    if (cnMatch && (cnMatch[1] || cnMatch[2] || cnMatch[3])) {
      const h = Number(cnMatch[1] || 0);
      const m = Number(cnMatch[2] || 0);
      const s = Number(cnMatch[3] || 0);
      const total = h * 3600 + m * 60 + s;
      if (total > 0) return total;
    }

    // Match colon format like "20:15" or "01:05:26"
    const colonMatch = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (colonMatch) {
      if (colonMatch[3] !== undefined) {
        return Number(colonMatch[1]) * 3600 + Number(colonMatch[2]) * 60 + Number(colonMatch[3]);
      }
      return Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
    }
    return 0;
  }

  function parseProgressPercent(text, containerEl) {
    const clean = (text || "").replace(/\s+/g, "").trim();
    if (clean === "完成" || clean === "100%") return 100;
    const m = clean.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) return Number(m[1]);
    if (containerEl) {
      const prog = containerEl.querySelector('[role="progressbar"][aria-valuenow]');
      if (prog) {
        const val = Number(prog.getAttribute("aria-valuenow"));
        if (Number.isFinite(val)) return val;
      }
    }
    return null;
  }

  function getEpisodeTitle(epEl) {
    const nameEl = epEl.querySelector('[class*="name-span_"]');
    return normText(nameEl || epEl);
  }

  function getExpectedEpisodeDurationSec(epEl) {
    let maxSec = 0;
    if (epEl) {
      const infoEl = epEl.querySelector('[class*="item-info_"]');
      if (infoEl) {
        maxSec = Math.max(maxSec, parseDurationTextSec(infoEl.textContent));
      }
    }
    const timeEl = document.querySelector("#player .xgplayer-time, .xgplayer-time");
    if (timeEl) {
      const parts = normText(timeEl).split("/");
      if (parts.length >= 2) {
        maxSec = Math.max(maxSec, parseDurationTextSec(parts[parts.length - 1]));
      }
    }
    return maxSec;
  }

  function getEpisodeProgressPercent(epEl) {
    if (isEpisodeDomDone(epEl)) return 100;
    const rateEl = epEl.querySelector('[class*="rate-span_"]');
    const pct = parseProgressPercent(rateEl ? rateEl.textContent : "", epEl);
    return pct === null ? 0 : pct;
  }

  function isEpisodeDomDone(epEl) {
    const rateEl = epEl.querySelector('[class*="rate-span_"]');
    if (rateEl && isProgressTextDone(rateEl.textContent)) return true;
    const prog = epEl.querySelector('[role="progressbar"][aria-valuenow]');
    if (prog && Number(prog.getAttribute("aria-valuenow")) >= 100) return true;
    return false;
  }

  function isCachedResourceValid(key, now) {
    const ts = session.finishedResources[key];
    if (!ts) return false;
    if (now - ts < FINISHED_RESOURCE_TTL_MS) return true;
    delete session.finishedResources[key];
    saveSession(session);
    return false;
  }

  function isEpisodeDone(epEl, idx, curIdx, taskId, resourceId) {
    if (isEpisodeDomDone(epEl)) return true;
    const now = Date.now();
    const title = getEpisodeTitle(epEl);
    if (taskId && title && isCachedResourceValid(`${taskId}::ep::${idx}::${title}`, now)) {
      return true;
    }
    if (idx === curIdx && taskId && resourceId && isCachedResourceValid(`${taskId}::res::${resourceId}`, now)) {
      return true;
    }
    return false;
  }

  function returnToCourseList(now) {
    session.consecutiveCompletedHops = 0;
    saveSession(session);
    const beforeUrl = window.location.href;
    const backBtn = document.querySelector('span[class*="return-icon_"], [class*="return-icon_"]');
    if (backBtn && isVisible(backBtn)) {
      runtime.waitingReturnToList = { beforeUrl, at: now };
      backBtn.click();
      pushLog("↩️ 返回课程目录页准备切换课程/章节");
      setStatus("RUNNING", "正在返回课程目录...");
      return;
    }
    if (session.lastCourseListUrl) {
      pushLog("↩️ 跳转回课程目录页");
      window.location.href = session.lastCourseListUrl;
    } else {
      pushLog("⚠️ 未找到返回按钮且无目录地址记录");
      setStatus("RUNNING", "请手动返回课程目录");
    }
  }

  function findNextCourseButton() {
    // Note: "项目首页" also uses class `next-btn_*`, so match strictly by text!
    const btns = Array.from(document.querySelectorAll('[class*="next-btn_"]'));
    return btns.find((el) => isVisible(el) && normText(el).includes("下一个课程")) || null;
  }

  function advanceToNextCourse(now, { markFinished = true } = {}) {
    const params = getQueryParams();
    const taskId = params.get("task_id") || params.get("course_id") || "";
    const courseTitle = getCurrentCourseTitle();
    if (markFinished) {
      markCourseFinished(taskId, courseTitle);
    }

    if (!runtime.watchedUnfinished && markFinished) {
      session.consecutiveCompletedHops = (session.consecutiveCompletedHops || 0) + 1;
      saveSession(session);
    }

    if (config.courseSwitchMode === "list" || session.consecutiveCompletedHops >= 2) {
      pushLog("📚 当前课程已完成，回目录查找下一未完成课程/章节");
      returnToCourseList(now);
      return;
    }

    const nextBtn = findNextCourseButton();
    if (!nextBtn) {
      returnToCourseList(now);
      return;
    }

    runtime.waitingCourseSwitch = { beforeUrl: window.location.href, at: now };
    nextBtn.click();
    pushLog(markFinished ? "⏭️ 本课全部集数已完成，点击「下一个课程」" : "⏭️ 手动切换「下一个课程」");
    setStatus("RUNNING", "正在切换至下一课程...");
  }

  function advanceToNextEpisodeOrCourse(now, { isManual = false } = {}) {
    const wrap = ensurePlaylistTabAndExpanded(now);
    if (!wrap) return false;

    const episodes = Array.from(wrap.querySelectorAll('div[class*="item-wrap_"][data-checked]'));
    if (!episodes.length) return false;

    const params = getQueryParams();
    const taskId = params.get("task_id") || params.get("course_id") || "";
    const resourceId = params.get("resource_id") || "";
    const curIdx = episodes.findIndex((el) => el.getAttribute("data-checked") === "true");

    const orderedCandidates = [];
    for (let i = curIdx + 1; i < episodes.length; i++) {
      if (!isEpisodeDone(episodes[i], i, curIdx, taskId, resourceId)) {
        orderedCandidates.push(episodes[i]);
      }
    }
    for (let i = 0; i < curIdx; i++) {
      if (!isEpisodeDone(episodes[i], i, curIdx, taskId, resourceId)) {
        orderedCandidates.push(episodes[i]);
      }
    }

    let nextTarget = null;
    if (!isManual && orderedCandidates.length > 0) {
      // Prioritize resuming already-started (1%–99%) episodes before starting new 0% ones.
      nextTarget =
        orderedCandidates.find((el) => {
          const pct = getEpisodeProgressPercent(el);
          return pct > 0 && pct < 100;
        }) || orderedCandidates[0];
    } else if (orderedCandidates.length > 0) {
      nextTarget = orderedCandidates[0];
    }

    if (nextTarget) {
      const nextTitle = getEpisodeTitle(nextTarget);
      runtime.pendingEnd = null;
      if (typeof nextTarget.scrollIntoView === "function") {
        nextTarget.scrollIntoView({ block: "nearest" });
      }
      nextTarget.click();
      pushLog(`🎬 ${isManual ? "手动" : "自动"}切P -> ${nextTitle || "下一集"}`);
      setStatus("RUNNING", `切换至: ${nextTitle || "下一集"}`);
      return true;
    }

    advanceToNextCourse(now, { markFinished: !isManual });
    return true;
  }

  function tryStartVideoPlayback(video, now) {
    if (now - runtime.playAttemptAt < 2500) return;
    runtime.playAttemptAt = now;

    if (config.autoMute && !video.muted) {
      video.muted = true;
    }

    try {
      const res = video.play();
      if (res && typeof res.catch === "function") {
        res.catch(() => {
          runtime.playFailCount += 1;
          video.muted = true;
          try {
            const retry = video.play();
            if (retry && typeof retry.catch === "function") retry.catch(() => {});
          } catch (_) {}
          const startBtn =
            document.querySelector(".xgplayer-start") ||
            document.querySelector(".xgplayer-play");
          if (startBtn) startBtn.click();
        });
      }
    } catch (_) {
      const startBtn =
        document.querySelector(".xgplayer-start") ||
        document.querySelector(".xgplayer-play");
      if (startBtn) startBtn.click();
    }
  }

  function getVideoSrcKey(video) {
    return (video && (video.currentSrc || video.src)) || "";
  }

  function getActiveEpisodeSnapshot() {
    const wrap = getPlaylistWrap();
    if (!wrap) return null;
    const episodes = Array.from(wrap.querySelectorAll('div[class*="item-wrap_"][data-checked]'));
    const curIdx = episodes.findIndex((el) => el.getAttribute("data-checked") === "true");
    if (curIdx === -1) return null;
    const curEl = episodes[curIdx];
    const curTitle = getEpisodeTitle(curEl);
    const p = getQueryParams();
    const taskId = p.get("task_id") || p.get("course_id") || "";
    const resourceId = p.get("resource_id") || "";
    return {
      taskId,
      resourceId,
      curIdx,
      curEl,
      curTitle,
      sig: `${taskId}|${resourceId}|${curIdx}|${curTitle}`,
    };
  }

  function transitionToEpisodeState(meta, now) {
    if (!meta || runtime.activeEpisodeSig === meta.sig) return;
    if (runtime.activeEpisodeSig) {
      const curVid = document.querySelector("#player video");
      runtime.prevEpisodeVideoSrc = runtime.currentEpisodeVideoSrc || getVideoSrcKey(curVid);
    }
    runtime.activeEpisodeSig = meta.sig;
    runtime.lastEpisodeMeta = meta;
    runtime.episodeEnteredAt = now;
    runtime.pendingEnd = null;
    runtime.sawActivePlaybackOnSig = false;
    runtime.currentEpisodeVideoSrc = "";
    runtime.watchedUnfinished = false;
    runtime.playFailCount = 0;

    if (
      runtime.manualResetTarget &&
      now - runtime.manualResetTarget.at < 5000 &&
      (runtime.manualResetTarget.idx === meta.curIdx || runtime.manualResetTarget.title === meta.curTitle)
    ) {
      if (meta.taskId && meta.resourceId && session.finishedResources[`${meta.taskId}::res::${meta.resourceId}`]) {
        delete session.finishedResources[`${meta.taskId}::res::${meta.resourceId}`];
        saveSession(session);
      }
      runtime.manualResetTarget = null;
    }
  }

  function markActivePlaybackIfLive(video) {
    if (!video) return;
    if (video.ended) return;
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 5 && video.currentTime >= dur - 2) return;
    const snap = getActiveEpisodeSnapshot();
    if (snap && runtime.activeEpisodeSig !== snap.sig) {
      transitionToEpisodeState(
        {
          taskId: snap.taskId,
          resourceId: snap.resourceId,
          curIdx: snap.curIdx,
          curTitle: snap.curTitle,
          sig: snap.sig,
        },
        Date.now()
      );
    }
    const vSrc = getVideoSrcKey(video);
    runtime.sawActivePlaybackOnSig = true;
    if (vSrc) {
      runtime.currentEpisodeVideoSrc = vSrc;
      if (runtime.prevEpisodeVideoSrc && vSrc !== runtime.prevEpisodeVideoSrc) {
        runtime.prevEpisodeVideoSrc = "";
      }
    }
  }

  function isVideoTrulyFinished(video, curEl, sig, now, fromEndedEvent = false) {
    if (!video) return false;
    const vSrc = getVideoSrcKey(video);
    const staleEndedVideo =
      runtime.endedAtEpisodeSig &&
      runtime.endedAtEpisodeSig !== sig &&
      (!vSrc || vSrc === runtime.endedVideoSrc) &&
      now - runtime.episodeEnteredAt < 8000;
    if (staleEndedVideo) return false;

    const stalePrevSrc =
      !runtime.sawActivePlaybackOnSig &&
      runtime.prevEpisodeVideoSrc &&
      (!vSrc || vSrc === runtime.prevEpisodeVideoSrc) &&
      now - runtime.episodeEnteredAt < 8000;
    if (stalePrevSrc) return false;

    const expectedSec = getExpectedEpisodeDurationSec(curEl);

    if (!runtime.sawActivePlaybackOnSig) {
      if (now - runtime.episodeEnteredAt < 5000) return false;
      if (expectedSec <= 15) return false;
    }

    if (fromEndedEvent || video.ended) {
      if (expectedSec > 15) {
        // Two-sided check blocks both short MSE chunks (e.g. 48s/1215s) and long prev-episode leftovers (e.g. 1806s/1160s).
        const durMatches = Number.isFinite(video.duration) && Math.abs(video.duration - expectedSec) <= 25;
        const posMatches =
          video.currentTime >= expectedSec - 15 && video.currentTime <= expectedSec + 25;
        if (!durMatches || !posMatches) return false;
      }
      return true;
    }

    if (video.seeking) return false;
    if (video.readyState !== undefined && video.readyState < 2) return false;
    if (!Number.isFinite(video.duration) || video.duration <= 5) return false;
    if (video.currentTime < video.duration - 0.6) return false;

    if (expectedSec > 15) {
      const durMatches = Math.abs(video.duration - expectedSec) <= 25;
      const posMatches =
        video.currentTime >= expectedSec - 15 && video.currentTime <= expectedSec + 25;
      if (!durMatches || !posMatches) return false;
    } else if (now - runtime.episodeEnteredAt < 3000) {
      return false;
    }

    return true;
  }

  function findOfficialRate125Option() {
    const ratePlugin =
      document.querySelector("#player .xgplayer-playbackrate") ||
      document.querySelector(".xgplayer-playbackrate");
    if (!ratePlugin) return null;
    const items = Array.from(ratePlugin.querySelectorAll("li.option-item, li"));
    return (
      items.find((li) => {
        const rateAttr = li.getAttribute("rate");
        if (rateAttr !== null && Math.abs(Number(rateAttr) - 1.25) <= 0.001) return true;
        return normText(li).toLowerCase() === "1.25x";
      }) || null
    );
  }

  function ensureLockedPlaybackRate(video, now, taskId, forceImmediate = false) {
    if (!config.lockRate125 || !video || video.ended || runtime.applyingRate) return;
    if (Math.abs((video.playbackRate || 1) - 1.25) <= 0.01) return;
    if (!forceImmediate && now - runtime.lastRateApplyAt < 1000) return;

    const opt125 = findOfficialRate125Option();
    if (!opt125) {
      const logKey = taskId || "default";
      if (
        now - runtime.episodeEnteredAt >= 1500 &&
        runtime.rateUnsupportedLoggedFor !== logKey
      ) {
        runtime.rateUnsupportedLoggedFor = logKey;
        pushLog("ℹ️ 当前课程未开放 1.25x 倍速选项，保持默认倍速");
      }
      return;
    }

    runtime.lastRateApplyAt = now;
    runtime.applyingRate = true;
    try {
      const prevRate = video.playbackRate || 1;
      if (!opt125.classList.contains("selected")) {
        opt125.click();
      }
      if (Math.abs((video.playbackRate || 1) - 1.25) > 0.01) {
        video.playbackRate = 1.25;
      }
      if (
        Math.abs(prevRate - 1.25) > 0.01 &&
        Math.abs((video.playbackRate || 1) - 1.25) <= 0.01
      ) {
        pushLog("⚡ 已锁定 1.25x 倍速播放");
      }
    } finally {
      runtime.applyingRate = false;
    }
  }

  function ensureMuted(video) {
    if (!config.autoMute || !video || runtime.applyingMute) return;
    if (video.muted) return;
    runtime.applyingMute = true;
    try {
      video.muted = true;
    } finally {
      runtime.applyingMute = false;
    }
  }

  function bindVideoEventsOnce(video) {
    if (boundVideos.has(video)) return;
    boundVideos.add(video);

    const onNeedLockRate = () => {
      if (!config.enabled || !config.lockRate125) return;
      const p = getQueryParams();
      const tId = p.get("task_id") || p.get("course_id") || "";
      ensureLockedPlaybackRate(video, Date.now(), tId, true);
    };

    const onNeedMute = () => {
      if (!config.enabled || !config.autoMute) return;
      ensureMuted(video);
    };

    const onCheckActivePlayback = () => {
      markActivePlaybackIfLive(video);
    };

    video.addEventListener("ratechange", onNeedLockRate);
    video.addEventListener("loadedmetadata", onNeedLockRate);
    video.addEventListener("play", onNeedLockRate);

    video.addEventListener("loadedmetadata", onNeedMute);
    video.addEventListener("play", onNeedMute);
    video.addEventListener("playing", onNeedMute);
    video.addEventListener("volumechange", onNeedMute);

    video.addEventListener("loadedmetadata", onCheckActivePlayback);
    video.addEventListener("play", onCheckActivePlayback);
    video.addEventListener("playing", onCheckActivePlayback);
    video.addEventListener("timeupdate", onCheckActivePlayback);

    video.addEventListener("ended", () => {
      if (!config.enabled) return;
      const snap = getActiveEpisodeSnapshot();
      if (!snap) return;
      const now = Date.now();
      const vSrc = getVideoSrcKey(video);

      // ENAEA's native handleEnd() may synchronously move data-checked to the next episode before our listener runs.
      if (runtime.activeEpisodeSig && snap.sig !== runtime.activeEpisodeSig) {
        if (runtime.lastEpisodeMeta) {
          markEpisodeFinished(
            runtime.lastEpisodeMeta.taskId,
            runtime.lastEpisodeMeta.resourceId,
            runtime.lastEpisodeMeta.curIdx,
            runtime.lastEpisodeMeta.curTitle
          );
        }
        runtime.prevEpisodeVideoSrc = vSrc;
        runtime.endedVideoSrc = vSrc;
        runtime.endedAtEpisodeSig = runtime.activeEpisodeSig;
        return;
      }

      if (!isVideoTrulyFinished(video, snap.curEl, snap.sig, now, true)) return;
      markEpisodeFinished(snap.taskId, snap.resourceId, snap.curIdx, snap.curTitle);
      runtime.endedVideoSrc = vSrc;
      runtime.endedAtEpisodeSig = snap.sig;
      if (!runtime.pendingEnd) {
        runtime.pendingEnd = { sig: snap.sig, at: now };
        window.setTimeout(tick, 3050);
      }
    });
  }

  function hasNoNextCourseToast() {
    const msgs = Array.from(
      document.querySelectorAll(".grt-message, .grt-message-notice, .ant-message, .ant-message-notice")
    );
    return msgs.some((el) => isVisible(el) && normText(el).includes("没有下一个课程"));
  }

  function handlePlayerPage(now) {
    // Handle pending fallback after clicking "下一个课程"
    if (runtime.waitingCourseSwitch) {
      if (window.location.href !== runtime.waitingCourseSwitch.beforeUrl) {
        runtime.waitingCourseSwitch = null;
      } else if (
        hasNoNextCourseToast() ||
        now - runtime.waitingCourseSwitch.at >= 4000
      ) {
        runtime.waitingCourseSwitch = null;
        pushLog("📑 本章/当前队列无下一个课程，返回目录切换章节");
        returnToCourseList(now);
        return;
      } else {
        setStatus("RUNNING", "等待进入下一课程...");
        return;
      }
    }

    // Handle pending fallback after clicking "< 课程学习"
    if (runtime.waitingReturnToList) {
      if (window.location.href !== runtime.waitingReturnToList.beforeUrl) {
        runtime.waitingReturnToList = null;
      } else if (now - runtime.waitingReturnToList.at >= 2500) {
        runtime.waitingReturnToList = null;
        if (session.lastCourseListUrl) {
          window.location.href = session.lastCourseListUrl;
        }
        return;
      } else {
        setStatus("RUNNING", "正在返回课程目录...");
        return;
      }
    }

    const wrap = ensurePlaylistTabAndExpanded(now);
    if (!wrap) {
      setStatus("RUNNING", "等待课程目录加载...");
      return;
    }

    const episodes = Array.from(wrap.querySelectorAll('div[class*="item-wrap_"][data-checked]'));
    if (!episodes.length) {
      setStatus("RUNNING", "等待剧集列表加载...");
      return;
    }

    const params = getQueryParams();
    const taskId = params.get("task_id") || params.get("course_id") || "";
    const resourceId = params.get("resource_id") || "";
    const curIdx = episodes.findIndex((el) => el.getAttribute("data-checked") === "true");
    if (curIdx === -1) {
      setStatus("RUNNING", "等待定位当前集数...");
      return;
    }

    const curEl = episodes[curIdx];
    const curTitle = getEpisodeTitle(curEl);
    const sig = `${taskId}|${resourceId}|${curIdx}|${curTitle}`;
    if (runtime.activeEpisodeSig !== sig) {
      transitionToEpisodeState({ taskId, resourceId, curIdx, curTitle, sig }, now);
    }

    // Wait out the 3s end grace period so native endSessionId/sensorsData finish flushing.
    if (runtime.pendingEnd) {
      if (runtime.pendingEnd.sig !== sig) {
        runtime.pendingEnd = null;
      } else if (now - runtime.pendingEnd.at >= 3000) {
        runtime.pendingEnd = null;
        advanceToNextEpisodeOrCourse(now);
        return;
      } else {
        setStatus("RUNNING", `本集结束，3秒后自动切换 (${curTitle})`);
        return;
      }
    }

    const playerVideo = document.querySelector("#player video");
    if (playerVideo) {
      bindVideoEventsOnce(playerVideo);
      markActivePlaybackIfLive(playerVideo);
      ensureMuted(playerVideo);
    }

    // If current episode is already marked finished in DOM or session cache, jump ahead.
    if (isEpisodeDone(curEl, curIdx, curIdx, taskId, resourceId)) {
      if (now - runtime.episodeEnteredAt >= 2000) {
        advanceToNextEpisodeOrCourse(now);
      } else {
        setStatus("RUNNING", `检测到当前集已完成，准备跳转 (${curTitle})`);
      }
      return;
    }

    // Document resource (resource_type === 5) has no video element.
    const docWrap = document.querySelector('[class*="doc-wrap_"]');
    const video = playerVideo || document.querySelector("#player video");
    if (docWrap && isVisible(docWrap) && !video) {
      if (now - runtime.episodeEnteredAt >= 5000) {
        runtime.watchedUnfinished = true;
        session.consecutiveCompletedHops = 0;
        markEpisodeFinished(taskId, resourceId, curIdx, curTitle);
        pushLog(`📄 文档已阅 -> ${curTitle}`);
        advanceToNextEpisodeOrCourse(now);
      } else {
        setStatus("RUNNING", `阅读文档中: ${curTitle}`);
      }
      return;
    }

    if (!video) {
      setStatus("RUNNING", "等待视频播放器就绪...");
      return;
    }

    const vSrc = getVideoSrcKey(video);
    const staleEndedVideo =
      runtime.endedAtEpisodeSig &&
      runtime.endedAtEpisodeSig !== sig &&
      (!vSrc || vSrc === runtime.endedVideoSrc) &&
      now - runtime.episodeEnteredAt < 8000;

    if (staleEndedVideo && video.ended) {
      setStatus("RUNNING", `等待切换新视频源 (${curTitle})...`);
      return;
    }

    markActivePlaybackIfLive(video);

    if (isVideoTrulyFinished(video, curEl, sig, now, false)) {
      markEpisodeFinished(taskId, resourceId, curIdx, curTitle);
      runtime.endedVideoSrc = vSrc;
      runtime.endedAtEpisodeSig = sig;
      runtime.pendingEnd = { sig, at: now };
      window.setTimeout(tick, 3050);
      setStatus("RUNNING", `本集已播完，准备切换 (${curTitle})`);
      return;
    }

    if (runtime.endedVideoSrc && !video.ended) {
      runtime.endedVideoSrc = "";
      runtime.endedAtEpisodeSig = "";
    }

    ensureMuted(video);
    ensureLockedPlaybackRate(video, now, taskId, false);

    if (!video.paused && video.currentTime > 1) {
      runtime.watchedUnfinished = true;
      runtime.playFailCount = 0;
      if (session.consecutiveCompletedHops !== 0) {
        session.consecutiveCompletedHops = 0;
        saveSession(session);
      }
    }

    if (video.paused) {
      tryStartVideoPlayback(video, now);
      setStatus("RUNNING", `准备播放: ${curTitle}`);
    } else {
      const curStr = formatDuration(video.currentTime);
      const durStr = formatDuration(video.duration);
      const rateStr = Number((video.playbackRate || 1).toFixed(2));
      setStatus("RUNNING", `播放中: ${curTitle} (${curStr} / ${durStr} | ${rateStr}x)`);
    }
  }

  // --- Course List & Chapter Switching State Machine ---

  function getCourseProgressPercent(box) {
    const label = box.querySelector('[class*="progress-label_"]');
    return parseProgressPercent(label ? label.textContent : "", box);
  }

  function isCourseBoxDone(box) {
    const pct = getCourseProgressPercent(box);
    if (pct !== null && pct >= 100) return true;

    const title = getCourseTitleFromBox(box);
    if (title && session.finishedCourses[title]) {
      // Never skip a course if the live DOM clearly shows it is still < 90% (e.g. 4%).
      if (pct !== null && pct < 90) {
        delete session.finishedCourses[title];
        saveSession(session);
        return false;
      }
      if (Date.now() - session.finishedCourses[title] < 180000) {
        return true;
      }
    }
    return false;
  }

  function isCourseSkipped(box) {
    const title = getCourseTitleFromBox(box);
    return Boolean(title && session.skippedCourses[title]);
  }

  function getCourseTitleFromBox(box) {
    const titleEl =
      box.querySelector('[class*="list-title_"] span') ||
      box.querySelector('[class*="list-title_"]') ||
      box.querySelector('[class*="item-title_"]');
    return normText(titleEl);
  }

  function clickCourseCard(box, chapterLabel, now) {
    const title = getCourseTitleFromBox(box);
    runtime.lastClickedCourseTitle = title;
    runtime.listActionCooldownUntil = now + 3500;
    const clickTarget = box.querySelector(":scope > div") || box.firstElementChild || box;
    if (typeof box.scrollIntoView === "function") {
      box.scrollIntoView({ block: "center" });
    }
    clickTarget.click();
    pushLog(`📖 进入课程: ${chapterLabel ? `${chapterLabel} / ` : ""}${title || "未命名课程"}`);
    setStatus("RUNNING", `进入课程: ${title || "..."}`);
  }

  function findAndClickInCollapseList(collapseList, now) {
    const rootCollapse =
      Array.from(collapseList.children || []).find(
        (ch) => ch.classList.contains("grt-collapse") || ch.classList.contains("ant-collapse")
      ) || collapseList.querySelector(".grt-collapse, .ant-collapse");

    const level1Panels = getDirectCollapseItems(rootCollapse);
    if (!level1Panels.length) {
      setStatus("RUNNING", "等待章节列表渲染...");
      return;
    }

    // Pass 1: expand all Level-1 and Level-2 chapters so we can prioritize any already-started (1%-99%) course.
    for (const l1Panel of level1Panels) {
      const l1Title = normText(getDirectHeader(l1Panel));
      if (!isCollapseExpanded(l1Panel)) {
        if (now < runtime.expandCooldownUntil) return;
        const hdr = getDirectHeader(l1Panel);
        if (hdr) {
          runtime.expandCooldownUntil = now + 250;
          hdr.click();
          pushLog(`📂 展开一级板块: ${l1Title}`);
          setStatus("RUNNING", `展开板块: ${l1Title}`);
          window.setTimeout(tick, 280);
          return;
        }
      }

      const l1Content = getDirectContent(l1Panel) || l1Panel;
      const secondInfo = l1Content.querySelector('[class*="sectionSecond-info_"]');
      const l2Collapse = secondInfo
        ? secondInfo.querySelector(".grt-collapse, .ant-collapse")
        : null;
      const level2Panels = getDirectCollapseItems(l2Collapse);

      for (const l2Panel of level2Panels) {
        const l2Title = normText(getDirectHeader(l2Panel));
        if (!isCollapseExpanded(l2Panel)) {
          if (now < runtime.expandCooldownUntil) return;
          const hdr = getDirectHeader(l2Panel);
          if (hdr) {
            runtime.expandCooldownUntil = now + 250;
            hdr.click();
            pushLog(`📁 展开章节: ${l2Title}`);
            setStatus("RUNNING", `展开章节: ${l2Title}`);
            window.setTimeout(tick, 280);
            return;
          }
        }
      }
    }

    // Pass 2: collect all unfinished & unskipped courses across all expanded chapters.
    const unfinished = [];
    for (const l1Panel of level1Panels) {
      const l1Title = normText(getDirectHeader(l1Panel));
      const l1Content = getDirectContent(l1Panel) || l1Panel;
      const secondInfo = l1Content.querySelector('[class*="sectionSecond-info_"]');
      const l2Collapse = secondInfo
        ? secondInfo.querySelector(".grt-collapse, .ant-collapse")
        : null;
      const level2Panels = getDirectCollapseItems(l2Collapse);

      if (level2Panels.length > 0) {
        for (const l2Panel of level2Panels) {
          const l2Title = normText(getDirectHeader(l2Panel));
          const l2Content = getDirectContent(l2Panel) || l2Panel;
          const boxes = Array.from(l2Content.querySelectorAll('[class*="section-box_"]'));
          for (const b of boxes) {
            if (!isCourseBoxDone(b) && !isCourseSkipped(b)) {
              unfinished.push({ box: b, chapterLabel: l2Title, pct: getCourseProgressPercent(b) });
            }
          }
        }
      } else {
        const boxes = Array.from(l1Content.querySelectorAll('[class*="section-box_"]'));
        for (const b of boxes) {
          if (!isCourseBoxDone(b) && !isCourseSkipped(b)) {
            unfinished.push({ box: b, chapterLabel: l1Title, pct: getCourseProgressPercent(b) });
          }
        }
      }
    }

    if (unfinished.length > 0) {
      const inProgress = unfinished.find(
        (item) => item.pct !== null && item.pct > 0 && item.pct < 100
      );
      const chosen = inProgress || unfinished[0];
      clickCourseCard(chosen.box, chosen.chapterLabel, now);
      return;
    }

    config.enabled = false;
    saveConfig(config);
    setStatus("ALL_COMPLETED", "当前页面所有章节课程已全部完成！");
    pushLog("🎉 恭喜！所有章节课程已全部完成");
    notifyUser("ENAEA 自动学习已完成", "当前列表所有章节课程均已完成！");
  }

  function findAndClickInFlatGrid(now) {
    const cards = Array.from(document.querySelectorAll('ul[class*="list-wrap_"] li#courseList, li#courseList'));
    if (!cards.length) {
      setStatus("RUNNING", "等待课程列表加载...");
      return;
    }

    const unfinished = cards.filter((c) => !isCourseBoxDone(c) && !isCourseSkipped(c));
    if (unfinished.length > 0) {
      const inProgress = unfinished.find((c) => {
        const pct = getCourseProgressPercent(c);
        return pct !== null && pct > 0 && pct < 100;
      });
      clickCourseCard(inProgress || unfinished[0], "", now);
      return;
    }

    const nextPageBtn = document.querySelector(
      ".grt-pagination-next:not(.grt-pagination-disabled), .ant-pagination-next:not(.ant-pagination-disabled)"
    );
    if (nextPageBtn && isVisible(nextPageBtn)) {
      runtime.expandCooldownUntil = now + 1500;
      nextPageBtn.click();
      pushLog("📄 当前页已完成，自动翻至下一页");
      setStatus("RUNNING", "正在翻页...");
      return;
    }

    config.enabled = false;
    saveConfig(config);
    setStatus("ALL_COMPLETED", "当前课程列表已全部完成！");
    pushLog("🎉 恭喜！列表课程已全部完成");
    notifyUser("ENAEA 自动学习已完成", "当前列表所有课程均已完成！");
  }

  function handleCourseListPage(now) {
    if (session.lastCourseListUrl !== window.location.href) {
      session.lastCourseListUrl = window.location.href;
      saveSession(session);
    }

    if (now < runtime.listActionCooldownUntil) {
      setStatus("RUNNING", "正在进入选定课程...");
      return;
    }

    const spinning = document.querySelector(".grt-spin-spinning, .ant-spin-spinning");
    if (spinning && isVisible(spinning)) {
      setStatus("RUNNING", "等待课程列表加载...");
      return;
    }

    // Give List.B98KfOK2.chunk.js ~1.5s on initial mount so its 500ms default collapse effect finishes.
    if (now - runtime.pageEnteredAt < 1500) {
      setStatus("RUNNING", "等待章节面板初始化...");
      return;
    }

    const collapseList = document.querySelector('[class*="collapseList_"]');
    if (collapseList) {
      findAndClickInCollapseList(collapseList, now);
      return;
    }

    const flatList = document.querySelector('ul[class*="list-wrap_"], li#courseList');
    if (flatList) {
      findAndClickInFlatGrid(now);
      return;
    }

    setStatus("RUNNING", "等待课程列表出现...");
  }

  // --- Main State Machine Tick ---

  function getCourseRouteIdentity(urlStr) {
    try {
      const u = new URL(urlStr, window.location.origin);
      const sp = new URLSearchParams(u.search);
      return {
        pathname: u.pathname,
        taskId: sp.get("task_id") || sp.get("course_id") || "",
      };
    } catch (_) {
      return { pathname: "", taskId: "" };
    }
  }

  function onUrlChanged(newUrl) {
    const prevId = runtime.lastUrl ? getCourseRouteIdentity(runtime.lastUrl) : { pathname: "", taskId: "" };
    const nextId = getCourseRouteIdentity(newUrl);
    const sameCoursePlayer =
      getRouteKind(nextId.pathname) === "player" &&
      prevId.pathname === nextId.pathname &&
      prevId.taskId &&
      prevId.taskId === nextId.taskId;

    runtime.lastUrl = newUrl;
    if (sameCoursePlayer) {
      // Switching resource_id within the same course: let handlePlayerPage transition episode state while keeping stale-src guards intact.
      return;
    }

    runtime.pageEnteredAt = Date.now();
    runtime.activeEpisodeSig = "";
    runtime.lastEpisodeMeta = null;
    runtime.episodeEnteredAt = Date.now();
    runtime.pendingEnd = null;
    runtime.endedVideoSrc = "";
    runtime.endedAtEpisodeSig = "";
    runtime.currentEpisodeVideoSrc = "";
    runtime.prevEpisodeVideoSrc = "";
    runtime.sawActivePlaybackOnSig = false;
    runtime.manualResetTarget = null;
    runtime.watchedUnfinished = false;
    runtime.playFailCount = 0;
    runtime.lastRateApplyAt = 0;
    runtime.rateUnsupportedLoggedFor = "";
    runtime.waitingCourseSwitch = null;
    runtime.waitingReturnToList = null;
    runtime.listActionCooldownUntil = 0;
  }

  function tick() {
    const now = Date.now();
    const curUrl = window.location.href;
    if (curUrl !== runtime.lastUrl) {
      onUrlChanged(curUrl);
    }

    const modalOutcome = checkModals(now);
    if (modalOutcome === "BLOCKED" || modalOutcome === "STOPPED") {
      return;
    }

    if (!config.enabled) {
      if (runtime.status !== "DAILY_LIMIT" && runtime.status !== "ALL_COMPLETED") {
        setStatus("IDLE", "已暂停，点击「开始自动学习」继续");
      }
      return;
    }

    const routeKind = getRouteKind(window.location.pathname || "");
    if (routeKind === "player") {
      handlePlayerPage(now);
    } else if (routeKind === "list") {
      handleCourseListPage(now);
    } else {
      setStatus("IDLE", "请打开「必修课 / 选修课」或课程播放页");
    }
  }

  // --- Floating HUD Panel ---

  const HUD_CSS = `
    #${PANEL_ID} {
      position: fixed;
      left: 16px;
      bottom: 16px;
      width: 300px;
      z-index: 99999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 12px;
      color: #1f2937;
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid #d1d5db;
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
      overflow: hidden;
      user-select: none;
    }
    #${PANEL_ID}.collapsed {
      width: 220px;
    }
    #${PANEL_ID} .hud-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: #1e3a8a;
      color: #ffffff;
      cursor: move;
    }
    #${PANEL_ID} .hud-title {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #${PANEL_ID} .hud-collapse-btn {
      background: rgba(255,255,255,0.18);
      border: none;
      color: #fff;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 11px;
      cursor: pointer;
    }
    #${PANEL_ID} .hud-body {
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #${PANEL_ID}.collapsed .hud-body {
      display: none;
    }
    #${PANEL_ID} .hud-status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    #${PANEL_ID} .hud-badge {
      padding: 2px 8px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 11px;
    }
    #${PANEL_ID} .hud-badge.neutral { background: #e5e7eb; color: #374151; }
    #${PANEL_ID} .hud-badge.active  { background: #dbeafe; color: #1d4ed8; }
    #${PANEL_ID} .hud-badge.danger  { background: #fee2e2; color: #b91c1c; }
    #${PANEL_ID} .hud-badge.warn    { background: #fef3c7; color: #92400e; }
    #${PANEL_ID} .hud-badge.success { background: #dcfce7; color: #166534; }
    #${PANEL_ID} .hud-detail {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 6px 8px;
      color: #334155;
      line-height: 1.4;
      word-break: break-word;
    }
    #${PANEL_ID} .hud-primary-btn {
      width: 100%;
      padding: 6px 10px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: #2563eb;
    }
    #${PANEL_ID} .hud-primary-btn.stop {
      background: #dc2626;
    }
    #${PANEL_ID} .hud-options {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
      font-size: 11px;
    }
    #${PANEL_ID} .hud-options label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    #${PANEL_ID} select.hud-select {
      width: 100%;
      font-size: 11px;
      padding: 4px 6px;
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      background: #fff;
      color: #1e293b;
    }
    #${PANEL_ID} .hud-actions {
      display: flex;
      gap: 6px;
    }
    #${PANEL_ID} .hud-mini-btn {
      flex: 1;
      padding: 4px 6px;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      color: #334155;
      border-radius: 5px;
      font-size: 11px;
      cursor: pointer;
    }
    #${PANEL_ID} .hud-mini-btn:hover {
      background: #e2e8f0;
    }
    #${PANEL_ID} .hud-logs {
      max-height: 96px;
      overflow-y: auto;
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 10.5px;
      line-height: 1.45;
      font-family: Consolas, Menlo, monospace;
    }
  `;

  function injectStyles() {
    try {
      if (typeof GM_addStyle === "function") {
        GM_addStyle(HUD_CSS);
        return;
      }
    } catch (_) {}
    if (!document.getElementById(`${PANEL_ID}-style`)) {
      const style = document.createElement("style");
      style.id = `${PANEL_ID}-style`;
      style.textContent = HUD_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.target && e.target.tagName === "BUTTON") return;
      dragging = true;
      const rect = panel.getBoundingClientRect ? panel.getBoundingClientRect() : { left: 16, top: 16 };
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const nextLeft = Math.max(0, origLeft + (e.clientX - startX));
      const nextTop = Math.max(0, origTop + (e.clientY - startY));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.bottom = "auto";
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function injectHUD() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    injectStyles();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    if (config.panelCollapsed) panel.classList.add("collapsed");

    panel.innerHTML = `
      <div class="hud-header">
        <span class="hud-title">🎓 ENAEA 连播助手</span>
        <button type="button" class="hud-collapse-btn" data-role="collapse">${config.panelCollapsed ? "展开" : "收起"}</button>
      </div>
      <div class="hud-body">
        <div class="hud-status-row">
          <span class="hud-badge neutral" data-role="badge">初始化</span>
          <span style="color:#64748b;font-size:11px;" data-role="route"></span>
        </div>
        <div class="hud-detail" data-role="detail">等待检测页面...</div>
        <button type="button" class="hud-primary-btn" data-role="toggle"></button>
        <div class="hud-options">
          <label><input type="checkbox" data-cfg="autoMute"> 自动静音</label>
          <label><input type="checkbox" data-cfg="lockRate125"> 锁定1.25倍速</label>
          <label><input type="checkbox" data-cfg="autoSkipEval"> 跳过90%评价</label>
          <label><input type="checkbox" data-cfg="autoDismissWelcome"> 关温馨提示</label>
          <label><input type="checkbox" data-cfg="alertSound"> 验证提示音</label>
        </div>
        <select class="hud-select" data-cfg="courseSwitchMode">
          <option value="hybrid">切课策略: 优先「下一个课程」+ 章末回目录切章</option>
          <option value="list">切课策略: 总是回目录按章节顺序选课</option>
        </select>
        <div class="hud-actions">
          <button type="button" class="hud-mini-btn" data-act="nextEp">下一集</button>
          <button type="button" class="hud-mini-btn" data-act="nextCourse">下一课</button>
          <button type="button" class="hud-mini-btn" data-act="clearCache">清除缓存</button>
        </div>
        <div class="hud-logs" data-role="logs">暂无日志</div>
      </div>
    `;

    document.body.appendChild(panel);
    makeDraggable(panel, panel.querySelector(".hud-header"));

    panel.querySelector('[data-role="collapse"]').addEventListener("click", () => {
      config.panelCollapsed = !config.panelCollapsed;
      saveConfig(config);
      panel.classList.toggle("collapsed", config.panelCollapsed);
      panel.querySelector('[data-role="collapse"]').textContent = config.panelCollapsed ? "展开" : "收起";
    });

    panel.querySelector('[data-role="toggle"]').addEventListener("click", () => {
      config.enabled = !config.enabled;
      saveConfig(config);
      if (config.enabled) {
        setStatus("RUNNING", "已启动自动学习");
        pushLog("▶️ 手动启动自动学习");
      } else {
        setStatus("IDLE", "已手动暂停");
        pushLog("⏸️ 手动暂停自动学习");
      }
      updateHUD();
    });

    ["autoMute", "lockRate125", "autoSkipEval", "autoDismissWelcome", "alertSound"].forEach((key) => {
      const input = panel.querySelector(`[data-cfg="${key}"]`);
      if (!input) return;
      input.checked = Boolean(config[key]);
      input.addEventListener("change", () => {
        config[key] = input.checked;
        saveConfig(config);
        if (key === "lockRate125" && input.checked) {
          const v = document.querySelector("#player video");
          const tId = getQueryParams().get("task_id") || getQueryParams().get("course_id") || "";
          if (v) ensureLockedPlaybackRate(v, Date.now(), tId, true);
        }
        if (key === "autoMute") {
          const v = document.querySelector("#player video");
          if (v) {
            if (input.checked) ensureMuted(v);
            else v.muted = false;
          }
        }
      });
    });

    const modeSelect = panel.querySelector('[data-cfg="courseSwitchMode"]');
    if (modeSelect) {
      modeSelect.value = config.courseSwitchMode;
      modeSelect.addEventListener("change", () => {
        config.courseSwitchMode = modeSelect.value;
        saveConfig(config);
      });
    }

    panel.querySelector('[data-act="nextEp"]').addEventListener("click", () => {
      if (getRouteKind(window.location.pathname || "") !== "player") {
        pushLog("ℹ️ 当前不在播放页");
        return;
      }
      advanceToNextEpisodeOrCourse(Date.now(), { isManual: true });
    });

    panel.querySelector('[data-act="nextCourse"]').addEventListener("click", () => {
      if (getRouteKind(window.location.pathname || "") !== "player") {
        pushLog("ℹ️ 当前不在播放页");
        return;
      }
      advanceToNextCourse(Date.now(), { markFinished: false });
    });

    panel.querySelector('[data-act="clearCache"]').addEventListener("click", () => {
      const keepListUrl = session.lastCourseListUrl;
      session = createEmptySession();
      session.lastCourseListUrl = keepListUrl;
      saveSession(session);
      pushLog("🧹 已清除本会话已播完缓存");
    });

    updateHUD();
  }

  function updateHUD() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const badge = panel.querySelector('[data-role="badge"]');
    const routeEl = panel.querySelector('[data-role="route"]');
    const detailEl = panel.querySelector('[data-role="detail"]');
    const toggleBtn = panel.querySelector('[data-role="toggle"]');
    const logsEl = panel.querySelector('[data-role="logs"]');

    const meta = STATUS_META[runtime.status] || STATUS_META.IDLE;
    if (badge) {
      badge.textContent = meta.label;
      badge.className = `hud-badge ${meta.tone}`;
    }
    if (routeEl) {
      const kind = getRouteKind(window.location.pathname || "");
      routeEl.textContent = kind === "player" ? "播放页" : kind === "list" ? "课程目录页" : "其他页";
    }
    if (detailEl) {
      detailEl.textContent = runtime.statusDetail;
    }
    if (toggleBtn) {
      toggleBtn.textContent = config.enabled ? "暂停自动学习" : "开始自动学习";
      toggleBtn.classList.toggle("stop", config.enabled);
    }
    if (logsEl) {
      logsEl.textContent = runtime.logs.length ? runtime.logs.join("\n") : "暂无日志";
    }
  }

  // --- Bootstrap & SPA Navigation Watch ---

  function hookHistoryEvents() {
    const notifyRoute = () => window.setTimeout(tick, 50);
    window.addEventListener("popstate", notifyRoute);
    window.addEventListener("hashchange", notifyRoute);
    try {
      const origPush = window.history.pushState;
      const origReplace = window.history.replaceState;
      if (typeof origPush === "function") {
        window.history.pushState = function (...args) {
          const ret = origPush.apply(this, args);
          notifyRoute();
          return ret;
        };
      }
      if (typeof origReplace === "function") {
        window.history.replaceState = function (...args) {
          const ret = origReplace.apply(this, args);
          notifyRoute();
          return ret;
        };
      }
    } catch (_) {}
  }

  function findEpisodeItemFromTarget(target) {
    let cur = target;
    let epEl = null;
    let inPlaylist = false;
    while (cur && cur.nodeType === 1) {
      const cls = String(cur.className || "");
      if (!epEl && cur.hasAttribute && cur.hasAttribute("data-checked") && cls.includes("item-wrap_")) {
        epEl = cur;
      }
      if (cls.includes("play-list-wrap_")) {
        inPlaylist = true;
        break;
      }
      cur = cur.parentElement;
    }
    return epEl && inPlaylist ? epEl : null;
  }

  function bindManualEpisodeClickReset() {
    document.addEventListener(
      "click",
      (e) => {
        if (!e || e.isTrusted !== true) return;
        const epEl = findEpisodeItemFromTarget(e.target);
        if (!epEl || isEpisodeDomDone(epEl)) return;

        const wrap = getPlaylistWrap();
        const episodes = wrap
          ? Array.from(wrap.querySelectorAll('div[class*="item-wrap_"][data-checked]'))
          : [];
        const idx = episodes.indexOf(epEl);
        const title = getEpisodeTitle(epEl);
        const p = getQueryParams();
        const taskId = p.get("task_id") || p.get("course_id") || "";

        let cleared = false;
        if (taskId && idx >= 0 && title) {
          const eKey = `${taskId}::ep::${idx}::${title}`;
          if (session.finishedResources[eKey]) {
            delete session.finishedResources[eKey];
            cleared = true;
          }
        }
        // Also clear any resource_id match once handlePlayerPage resolves the newly selected sig
        runtime.manualResetTarget = { taskId, idx, title, at: Date.now() };
        if (cleared) {
          saveSession(session);
          pushLog(`👆 检测到手动切回未完成集数，已重置缓存 (${title})`);
        }
      },
      true
    );
  }

  function start() {
    injectHUD();
    hookHistoryEvents();
    bindManualEpisodeClickReset();
    pushLog("🚀 脚本已就绪");
    tick();
    window.setInterval(() => {
      if (!document.getElementById(PANEL_ID)) injectHUD();
      tick();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
