/* Foco — app de concentração estilo Forest (pt-BR) */
(function () {
  "use strict";

  const STORAGE_KEY = "foco-app-v1";
  const GRACE_MS = 10000;
  const PAUSE_LIMIT_MS = 60 * 60 * 1000;
  const MIN_MINUTES = 5;
  const MAX_MINUTES = 180;
  const STEP_MINUTES = 5;
  const DAY_LABELS = ["D", "S", "T", "Q", "Q", "S", "S"];
  const ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const TREE_VARIANTS = ["carvalho", "pinheiro", "flor", "salgueiro", "outono"];

  const CRIT_TYPES = [
    { id: "level", label: "Alcançar nível" },
    { id: "totalMinutes", label: "Minutos totais de foco" },
    { id: "sessions", label: "Número de sessões" },
    { id: "streak", label: "Ofensiva de dias" },
    { id: "subjectMinutes", label: "Minutos em um assunto" },
    { id: "singleSession", label: "Uma sessão de N minutos" },
    { id: "spendCoins", label: "Gastar moedas" },
  ];

  const DEFAULT_STATE = () => ({
    version: 1,
    settings: { strictMode: true, sound: true, theme: "auto", notifyOnComplete: true },
    profile: { xp: 0, coins: 0, totalMinutes: 0, totalSessions: 0, currentStreak: 0, bestStreak: 0, lastFocusDate: null },
    sessions: [],
    rewards: [],
    reminders: [],
    notes: {},
    recentSubjects: [],
    activeSession: null,
    reminderLastShown: {},
  });

  let state = DEFAULT_STATE();
  let tickTimer = null;
  let reminderTimer = null;
  let wakeLock = null;
  let audioCtx = null;
  let dialDragging = false;
  let pendingMinutes = 25;
  let pendingSubject = "";
  let calCursor = new Date();
  let selectedNoteDay = todayKey();
  let editingRewardId = null;
  let missedBanner = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function uid() { return "id" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function todayKey(d) {
    const x = d ? new Date(d) : new Date();
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }
  function parseKey(k) {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function formatDate(k) {
    const d = typeof k === "string" ? parseKey(k) : new Date(k);
    return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
  }
  function formatDateTime(ts) {
    return new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function snapMinutes(m) {
    m = Math.round(Number(m) / STEP_MINUTES) * STEP_MINUTES;
    return clamp(m, MIN_MINUTES, MAX_MINUTES);
  }
  function fmtMMSS(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return pad(Math.floor(s / 60)) + ":" + pad(s % 60);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_STATE();
      const data = JSON.parse(raw);
      const base = DEFAULT_STATE();
      return {
        ...base, ...data,
        settings: { ...base.settings, ...(data.settings || {}) },
        profile: { ...base.profile, ...(data.profile || {}) },
        sessions: Array.isArray(data.sessions) ? data.sessions : [],
        rewards: Array.isArray(data.rewards) ? data.rewards : [],
        reminders: Array.isArray(data.reminders) ? data.reminders : [],
        notes: data.notes && typeof data.notes === "object" ? data.notes : {},
        recentSubjects: Array.isArray(data.recentSubjects) ? data.recentSubjects : [],
        reminderLastShown: data.reminderLastShown || {},
      };
    } catch (e) {
      return DEFAULT_STATE();
    }
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { toast("Não foi possível salvar (armazenamento cheio?)"); }
    syncRemindersToSW();
  }

  function xpNeededFor(level) { return Math.round(80 * Math.pow(level, 1.35)); }
  function levelFromXp(xp) {
    let lvl = 1, used = 0;
    while (true) {
      const need = xpNeededFor(lvl);
      if (used + need > xp) return { level: lvl, into: xp - used, need };
      used += need;
      lvl++;
      if (lvl > 200) return { level: lvl, into: 0, need: xpNeededFor(lvl) };
    }
  }
  function applyTheme() {
    const t = state.settings.theme || "auto";
    const dark = t === "dark" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#1c261f" : "#4f9a5e");
  }

  const PALETTES = {
    carvalho: { canopy: "#5fa86a", canopy2: "#3e8a4c", trunk: "#a07040", leaf: "#8fc96a", root: "#8a5a32" },
    pinheiro: { canopy: "#2f7a48", canopy2: "#1f5a34", trunk: "#7a5530", leaf: "#4fa05e", root: "#6a4528" },
    flor: { canopy: "#e8a0b8", canopy2: "#d47898", trunk: "#a07850", leaf: "#f0c0d0", root: "#8a6040" },
    salgueiro: { canopy: "#7aaa5a", canopy2: "#5a8a40", trunk: "#8a6a40", leaf: "#b5d080", root: "#705830" },
    outono: { canopy: "#e0a04a", canopy2: "#c87828", trunk: "#8a5a32", leaf: "#f0c868", root: "#704828" },
    murcha: { canopy: "#b8a078", canopy2: "#8a7060", trunk: "#6a5848", leaf: "#c8b898", root: "#5a4a3c" },
  };

  function treeSvg(stage, variant, withered, opts) {
    const o = opts || {};
    const pal = PALETTES[withered ? "murcha" : (variant || "carvalho")] || PALETTES.carvalho;
    const s = clamp(stage, 0, 5);
    const sway = o.sway ? ' class="canopy"' : "";
    let inner = "";
    inner += `<ellipse cx="100" cy="204" rx="48" ry="10" fill="${withered ? "#8a7a60" : "#8fbc6e"}" opacity="0.85"/>`;
    inner += `<ellipse cx="100" cy="208" rx="58" ry="8" fill="${withered ? "#7a6a50" : "#7aa65c"}"/>`;
    if (s === 0) {
      inner += `<ellipse cx="100" cy="196" rx="8" ry="6" fill="#6b4a28"/>`;
      inner += `<ellipse cx="100" cy="194" rx="5" ry="3" fill="#8a6440"/>`;
    } else if (s === 1) {
      inner += `<path d="M100 200 C98 186 102 180 100 170" stroke="${pal.trunk}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      inner += `<ellipse cx="92" cy="168" rx="10" ry="7" fill="${pal.leaf}"${sway}/>`;
      inner += `<ellipse cx="108" cy="166" rx="9" ry="7" fill="${pal.canopy}"${sway}/>`;
    } else if (s === 2) {
      inner += `<path d="M100 200 L100 150" stroke="${pal.trunk}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
      inner += `<circle cx="100" cy="138" r="22" fill="${pal.canopy}"${sway}/>`;
      inner += `<circle cx="88" cy="146" r="12" fill="${pal.leaf}"/>`;
      inner += `<circle cx="114" cy="144" r="11" fill="${pal.canopy2}"/>`;
    } else if (s === 3) {
      inner += `<path d="M100 200 L100 128" stroke="${pal.trunk}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
      inner += `<path d="M100 160 L84 142" stroke="${pal.trunk}" stroke-width="3" fill="none"/>`;
      inner += `<circle cx="100" cy="110" r="32" fill="${pal.canopy}"${sway}/>`;
      inner += `<circle cx="78" cy="122" r="16" fill="${pal.leaf}"/>`;
      inner += `<circle cx="122" cy="120" r="16" fill="${pal.canopy2}"/>`;
      inner += `<circle cx="100" cy="98" r="16" fill="${pal.leaf}"/>`;
    } else if (s === 4) {
      inner += `<path d="M100 200 L100 118" stroke="${pal.trunk}" stroke-width="9" fill="none" stroke-linecap="round"/>`;
      inner += `<path d="M100 168 L70 140 M100 156 L130 132" stroke="${pal.trunk}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
      inner += `<path d="M100 200 C88 206 74 208 62 206 M100 200 C112 206 128 208 140 206" stroke="${pal.root}" stroke-width="3" fill="none" opacity="0.8"/>`;
      inner += `<circle cx="100" cy="92" r="40" fill="${pal.canopy}"${sway}/>`;
      inner += `<circle cx="70" cy="108" r="20" fill="${pal.leaf}"/>`;
      inner += `<circle cx="130" cy="106" r="20" fill="${pal.canopy2}"/>`;
      inner += `<circle cx="100" cy="70" r="20" fill="${pal.leaf}"/>`;
      inner += `<circle cx="84" cy="80" r="14" fill="${pal.canopy2}"/>`;
    } else {
      inner += `<path d="M100 200 C90 208 72 214 52 214 M100 200 C110 208 128 214 148 214 M100 200 C96 210 90 218 84 222 M100 200 C104 210 110 218 116 222" stroke="${pal.root}" stroke-width="3.5" fill="none" stroke-linecap="round" opacity="0.9"/>`;
      inner += `<path d="M100 200 L100 108" stroke="${pal.trunk}" stroke-width="11" fill="none" stroke-linecap="round"/>`;
      inner += `<path d="M100 140 L80 100 M100 140 L122 96 M100 168 L64 128 M100 152 L136 118" stroke="${pal.trunk}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
      inner += `<g${sway}>`;
      inner += `<circle cx="100" cy="78" r="48" fill="${pal.canopy}"/>`;
      inner += `<circle cx="62" cy="100" r="24" fill="${pal.leaf}"/>`;
      inner += `<circle cx="140" cy="96" r="24" fill="${pal.canopy2}"/>`;
      inner += `<circle cx="100" cy="50" r="24" fill="${pal.leaf}"/>`;
      inner += `<circle cx="78" cy="64" r="18" fill="${pal.canopy2}"/>`;
      inner += `<circle cx="124" cy="62" r="18" fill="${pal.canopy}"/>`;
      if (!withered && variant === "flor") {
        inner += `<circle cx="70" cy="70" r="4" fill="#fff0f5"/><circle cx="130" cy="78" r="4" fill="#fff0f5"/><circle cx="100" cy="44" r="4" fill="#fff"/>`;
      }
      inner += `</g>`;
    }
    if (withered && s > 0) {
      inner += `<path d="M70 90 L78 110 M130 80 L120 100 M90 50 L100 70" stroke="#8a7060" stroke-width="2" fill="none" opacity="0.7"/>`;
    }
    return `<svg viewBox="0 0 200 230" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
  }

  function getAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }
  function beep(freq, dur, type, gain, at) {
    const ctx = getAudio();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || "sine";
    o.frequency.value = freq;
    g.gain.value = 0;
    o.connect(g); g.connect(ctx.destination);
    const t = ctx.currentTime + (at || 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain == null ? 0.07 : gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function playSuccess() {
    if (!state.settings.sound) return;
    beep(523.25, 0.18, "sine", 0.07, 0);
    beep(659.25, 0.18, "sine", 0.07, 0.14);
    beep(783.99, 0.32, "sine", 0.08, 0.28);
  }
  function playFail() {
    if (!state.settings.sound) return;
    beep(330, 0.28, "triangle", 0.06, 0);
    beep(247, 0.4, "triangle", 0.06, 0.18);
  }
  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }
  async function ensureNotifyPerm() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try { return (await Notification.requestPermission()) === "granted"; }
    catch (e) { return false; }
  }
  function showNotification(title, body, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = { body: body || "", tag: tag || "foco", icon: "icon-192.png", badge: "icon-192.png" };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {
          try { new Notification(title, opts); } catch (e2) {}
        });
      } else {
        new Notification(title, opts);
      }
    } catch (e) {}
  }

  function sessionElapsedMs(sess, now) {
    now = now || Date.now();
    let pause = sess.pauseTotal || 0;
    if (sess.pausedAt) pause += now - sess.pausedAt;
    return Math.max(0, now - sess.startedAt - pause);
  }
  function sessionRemainingMs(sess, now) {
    return Math.max(0, sess.plannedMinutes * 60000 - sessionElapsedMs(sess, now));
  }
  function growthStage(sess, now) {
    const p = sessionElapsedMs(sess, now) / (sess.plannedMinutes * 60000);
    if (p >= 1) return 5;
    return clamp(Math.floor(p * 6), 0, 5);
  }
  function xpForSession(minutes, streak) {
    let xp = minutes * 10;
    let bonus = 0;
    if (minutes >= 90) bonus += 0.5;
    else if (minutes >= 60) bonus += 0.3;
    else if (minutes >= 45) bonus += 0.15;
    bonus += Math.min(0.5, (streak || 0) * 0.05);
    xp = Math.round(xp * (1 + bonus));
    const coins = Math.round(minutes * (1 + bonus));
    return { xp, coins, bonus };
  }
  function updateStreakOnComplete(dateKey) {
    const p = state.profile;
    if (p.lastFocusDate === dateKey) return p.currentStreak;
    if (p.lastFocusDate) {
      const prev = parseKey(p.lastFocusDate);
      const cur = parseKey(dateKey);
      const diff = Math.round((cur - prev) / 86400000);
      p.currentStreak = diff === 1 ? (p.currentStreak || 0) + 1 : 1;
    } else {
      p.currentStreak = 1;
    }
    p.lastFocusDate = dateKey;
    if (p.currentStreak > p.bestStreak) p.bestStreak = p.currentStreak;
    return p.currentStreak;
  }
  async function requestWakeLock() {
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); }
    catch (e) { wakeLock = null; }
  }
  async function releaseWakeLock() {
    try { if (wakeLock) await wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  function startSession() {
    if (state.activeSession && state.activeSession.status === "running") return;
    const minutes = snapMinutes(pendingMinutes);
    const subject = (pendingSubject || "").trim();
    const variant = TREE_VARIANTS[Math.floor(Math.random() * TREE_VARIANTS.length)];
    state.activeSession = {
      id: uid(), startedAt: Date.now(), plannedMinutes: minutes, subject, variant,
      status: "running", lastHeartbeat: Date.now(), hiddenAt: null, pausedAt: null, pauseTotal: 0,
    };
    if (subject) {
      state.recentSubjects = [subject, ...state.recentSubjects.filter((s) => s !== subject)].slice(0, 10);
    }
    saveState();
    requestWakeLock();
    getAudio();
    ensureNotifyPerm();
    startTicking();
    render();
  }
  function pauseElapsedMs(sess, now) {
    now = now || Date.now();
    if (!sess || !sess.pausedAt) return 0;
    return Math.max(0, now - sess.pausedAt);
  }
  function clearPauseWatch() {
    if (window._focoPauseTimer) { clearTimeout(window._focoPauseTimer); window._focoPauseTimer = null; }
  }
  function schedulePauseWatch() {
    clearPauseWatch();
    const s = state.activeSession;
    if (!s || s.status !== "running" || !s.pausedAt) return;
    const left = PAUSE_LIMIT_MS - pauseElapsedMs(s);
    if (left <= 0) { enforcePauseLimit(); return; }
    window._focoPauseTimer = setTimeout(() => { enforcePauseLimit(); }, left + 50);
  }
  function enforcePauseLimit(now) {
    const s = state.activeSession;
    if (!s || s.status !== "running" || !s.pausedAt) return false;
    now = now || Date.now();
    if (pauseElapsedMs(s, now) <= PAUSE_LIMIT_MS) return false;
    clearPauseWatch();
    failSession("pause-timeout");
    return true;
  }
  function pauseSession() {
    const s = state.activeSession;
    if (!s || s.status !== "running") return;
    if (s.pausedAt) return;
    if (window._focoLeaveTimer) { clearTimeout(window._focoLeaveTimer); window._focoLeaveTimer = null; }
    s.pausedAt = Date.now();
    s.hiddenAt = null;
    s.lastHeartbeat = s.pausedAt;
    saveState();
    schedulePauseWatch();
    releaseWakeLock();
    renderFoco();
  }
  function resumeSession() {
    const s = state.activeSession;
    if (!s || !s.pausedAt) return;
    if (enforcePauseLimit()) return;
    s.pauseTotal = (s.pauseTotal || 0) + (Date.now() - s.pausedAt);
    s.pausedAt = null;
    s.lastHeartbeat = Date.now();
    s.hiddenAt = null;
    clearPauseWatch();
    saveState();
    requestWakeLock();
    startTicking();
    renderFoco();
  }
  function failSession(reason) {
    const s = state.activeSession;
    if (!s || (s.status !== "running" && s.status !== "paused")) return;
    const actual = Math.round(sessionElapsedMs(s) / 60000);
    state.sessions.unshift({
      id: s.id, startedAt: s.startedAt, endedAt: Date.now(),
      plannedMinutes: s.plannedMinutes, actualMinutes: actual,
      subject: s.subject || "", status: "failed", variant: s.variant, reason: reason || "left",
    });
    state.activeSession = { ...s, status: "failed", endedAt: Date.now(), failReason: reason };
    saveState();
    releaseWakeLock();
    playFail();
    vibrate([80, 60, 80]);
    render();
  }
  function completeSession() {
    const s = state.activeSession;
    if (!s || s.status !== "running") return;
    const minutes = s.plannedMinutes;
    const dateKey = todayKey();
    const streak = updateStreakOnComplete(dateKey);
    const reward = xpForSession(minutes, streak);
    const prevLevel = levelFromXp(state.profile.xp).level;
    state.profile.xp += reward.xp;
    state.profile.coins += reward.coins;
    state.profile.totalMinutes += minutes;
    state.profile.totalSessions += 1;
    const newLevel = levelFromXp(state.profile.xp).level;
    state.sessions.unshift({
      id: s.id, startedAt: s.startedAt, endedAt: Date.now(),
      plannedMinutes: minutes, actualMinutes: minutes, subject: s.subject || "",
      status: "completed", variant: s.variant, xp: reward.xp, coins: reward.coins,
    });
    state.activeSession = { ...s, status: "completed", endedAt: Date.now(), xp: reward.xp, coins: reward.coins };
    saveState();
    releaseWakeLock();
    playSuccess();
    vibrate([40, 40, 80, 40, 120]);
    if (state.settings.notifyOnComplete) {
      showNotification("Sessão concluída! 🌳", (s.subject ? s.subject + " · " : "") + minutes + " min · +" + reward.xp + " XP · +" + reward.coins + " moedas", "foco-done");
    }
    render();
    if (newLevel > prevLevel) showLevelUp(prevLevel, newLevel);
  }
  function clearActive() {
    state.activeSession = null;
    saveState();
    render();
  }
  function startTicking() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(onTick, 250);
  }
  function onTick() {
    const s = state.activeSession;
    if (!s || s.status !== "running") {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      return;
    }
    if (s.pausedAt) {
      if (enforcePauseLimit()) return;
      renderFocoTimeOnly();
      return;
    }
    const now = Date.now();
    s.lastHeartbeat = now;
    if (sessionRemainingMs(s, now) <= 0) { completeSession(); return; }
    if (now - (onTick._saved || 0) > 2000) { onTick._saved = now; saveState(); }
    renderFocoTimeOnly();
  }
  function handleVisibility() {
    const s = state.activeSession;
    if (!s || s.status !== "running") return;
    if (document.hidden) {
      s.hiddenAt = Date.now();
      if (s.pausedAt) s.lastHeartbeat = Date.now();
      saveState();
      // Leaving while paused must not wither the tree — only running time is watched.
      if (state.settings.strictMode && !s.pausedAt) {
        if (window._focoLeaveTimer) clearTimeout(window._focoLeaveTimer);
        window._focoLeaveTimer = setTimeout(() => {
          const cur = state.activeSession;
          if (cur && cur.status === "running" && document.hidden && state.settings.strictMode && !cur.pausedAt) {
            failSession("left");
          }
        }, GRACE_MS);
      }
    } else {
      if (window._focoLeaveTimer) { clearTimeout(window._focoLeaveTimer); window._focoLeaveTimer = null; }
      if (enforcePauseLimit()) return;
      if (s.hiddenAt && state.settings.strictMode && !s.pausedAt) {
        const away = Date.now() - s.hiddenAt;
        s.hiddenAt = null;
        if (away > GRACE_MS) failSession("left");
        else { s.lastHeartbeat = Date.now(); saveState(); }
      } else {
        s.hiddenAt = null;
        if (!s.pausedAt) s.lastHeartbeat = Date.now();
        saveState();
      }
      if (s.pausedAt) schedulePauseWatch();
      else requestWakeLock();
    }
  }
  function recoverActiveOnLoad() {
    const s = state.activeSession;
    if (!s || s.status !== "running") return;
    const now = Date.now();
    // Wall-clock pause limit must be checked first, even after the app was closed or the phone slept.
    if (enforcePauseLimit(now)) return;
    const gap = now - (s.lastHeartbeat || s.startedAt);
    if (state.settings.strictMode && !s.pausedAt && gap > GRACE_MS + 1000) {
      failSession("left");
      return;
    }
    if (sessionRemainingMs(s, now) <= 0 && !s.pausedAt) { completeSession(); return; }
    startTicking();
    if (s.pausedAt) schedulePauseWatch();
    else requestWakeLock();
  }

  function minutesSince(ts, filterFn) {
    return state.sessions.reduce((acc, sess) => {
      if (sess.status !== "completed") return acc;
      if (ts && sess.endedAt <= ts) return acc;
      if (filterFn && !filterFn(sess)) return acc;
      return acc + (sess.actualMinutes || sess.plannedMinutes || 0);
    }, 0);
  }
  function sessionsSince(ts) {
    return state.sessions.filter((sess) => sess.status === "completed" && (!ts || sess.endedAt > ts)).length;
  }
  function bestSessionSince(ts) {
    let best = 0;
    state.sessions.forEach((sess) => {
      if (sess.status !== "completed") return;
      if (ts && sess.endedAt <= ts) return;
      best = Math.max(best, sess.actualMinutes || sess.plannedMinutes || 0);
    });
    return best;
  }
  function subjectMinutesSince(ts, subject) {
    return minutesSince(ts, (sess) => (sess.subject || "") === subject);
  }
  function criterionProgress(crit, reward) {
    const since = reward.repeatable ? (reward.lastClaimedAt || 0) : 0;
    const lvl = levelFromXp(state.profile.xp).level;
    switch (crit.type) {
      case "level": return { current: lvl, target: crit.value, ok: lvl >= crit.value };
      case "totalMinutes": {
        const c = minutesSince(since);
        return { current: c, target: crit.value, ok: c >= crit.value };
      }
      case "sessions": {
        const c = sessionsSince(since);
        return { current: c, target: crit.value, ok: c >= crit.value };
      }
      case "streak":
        return { current: state.profile.currentStreak, target: crit.value, ok: state.profile.currentStreak >= crit.value };
      case "subjectMinutes": {
        const c = subjectMinutesSince(since, crit.subject || "");
        return { current: c, target: crit.value, ok: c >= crit.value };
      }
      case "singleSession": {
        const c = bestSessionSince(since);
        return { current: c, target: crit.value, ok: c >= crit.value };
      }
      case "spendCoins":
        return { current: state.profile.coins, target: crit.value, ok: state.profile.coins >= crit.value };
      default:
        return { current: 0, target: 1, ok: false };
    }
  }
  function rewardUnlocked(reward) {
    if (reward.claimed && !reward.repeatable) return true;
    if (!reward.criteria || !reward.criteria.length) return false;
    return reward.criteria.every((c) => criterionProgress(c, reward).ok);
  }
  function criterionLabel(c) {
    const t = CRIT_TYPES.find((x) => x.id === c.type);
    const name = t ? t.label : c.type;
    if (c.type === "subjectMinutes") return name + ": " + (c.subject || "?") + " · " + c.value + " min";
    if (c.type === "level") return name + " " + c.value;
    if (c.type === "spendCoins") return name + ": " + c.value;
    if (c.type === "streak") return name + ": " + c.value + " dias";
    if (c.type === "sessions") return name + ": " + c.value;
    return name + ": " + c.value + " min";
  }
  function claimReward(id) {
    const r = state.rewards.find((x) => x.id === id);
    if (!r) return;
    if (!rewardUnlocked(r) || (r.claimed && !r.repeatable)) return;
    const spend = (r.criteria || []).filter((c) => c.type === "spendCoins");
    const cost = spend.reduce((s, c) => s + (c.value || 0), 0);
    if (cost > state.profile.coins) { toast("Moedas insuficientes."); return; }
    state.profile.coins -= cost;
    r.claimedAt = Date.now();
    r.claimCount = (r.claimCount || 0) + 1;
    r.lastClaimedAt = Date.now();
    r.claimed = !r.repeatable;
    saveState();
    toast("Recompensa resgatada! 🎉");
    renderRecompensas();
    renderHeader();
  }

  function nextOccurrence(reminder, after) {
    after = after || new Date();
    const [hh, mm] = (reminder.time || "21:00").split(":").map(Number);
    const days = (reminder.days && reminder.days.length) ? reminder.days.slice().sort() : [0,1,2,3,4,5,6];
    for (let i = 0; i <= 7; i++) {
      const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, hh, mm, 0, 0);
      if (d.getTime() <= after.getTime()) continue;
      if (days.indexOf(d.getDay()) !== -1) return d;
    }
    return null;
  }
  function lastOccurrence(reminder, before) {
    before = before || new Date();
    const [hh, mm] = (reminder.time || "21:00").split(":").map(Number);
    const days = (reminder.days && reminder.days.length) ? reminder.days.slice().sort() : [0,1,2,3,4,5,6];
    for (let i = 0; i <= 7; i++) {
      const d = new Date(before.getFullYear(), before.getMonth(), before.getDate() - i, hh, mm, 0, 0);
      if (d.getTime() > before.getTime()) continue;
      if (days.indexOf(d.getDay()) !== -1) return d;
    }
    return null;
  }
  function reminderTitle(r) { return r.type === "journal" ? "Anotação do dia" : "Hora de focar"; }
  function reminderBody(r) {
    return r.message || (r.type === "journal" ? "Que tal escrever a anotação do dia?" : "Hora de estudar! Abra o Foco e plante uma árvore.");
  }
  function fireReminder(r, missed) {
    const occ = missed ? lastOccurrence(r, new Date()) : new Date();
    const key = r.id + ":" + todayKey(occ) + ":" + r.time;
    if (state.reminderLastShown[key]) return;
    state.reminderLastShown[key] = Date.now();
    saveState();
    const title = reminderTitle(r);
    const body = (missed ? "Lembrete: " : "") + reminderBody(r);
    showNotification(title, body, "foco-rem-" + r.id);
    if (missed) {
      missedBanner = { title, body, type: r.type, id: r.id };
      renderMissedBanner();
    } else {
      toast((title + " — " + body).slice(0, 140));
    }
    vibrate([50, 40, 50]);
    if (state.settings.sound) beep(880, 0.15, "sine", 0.06, 0);
  }
  function checkMissedReminders() {
    const now = new Date();
    const windowMs = 3 * 60 * 60 * 1000;
    (state.reminders || []).forEach((r) => {
      if (!r.enabled) return;
      const last = lastOccurrence(r, now);
      if (!last) return;
      const ago = now.getTime() - last.getTime();
      if (ago < 0 || ago > windowMs) return;
      const key = r.id + ":" + todayKey(last) + ":" + r.time;
      if (!state.reminderLastShown[key]) fireReminder(r, true);
    });
  }
  function scheduleOpenReminders() {
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
    const now = new Date();
    let next = null, which = null;
    (state.reminders || []).forEach((r) => {
      if (!r.enabled) return;
      const d = nextOccurrence(r, now);
      if (d && (!next || d < next)) { next = d; which = r; }
    });
    if (!next || !which) return;
    const wait = Math.min(next.getTime() - Date.now(), 2147483647);
    reminderTimer = setTimeout(() => { fireReminder(which, false); scheduleOpenReminders(); }, Math.max(500, wait));
    tryScheduleTriggers();
  }
  async function tryScheduleTriggers() {
    if (typeof TimestampTrigger === "undefined") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    for (const r of state.reminders || []) {
      if (!r.enabled) continue;
      const d = nextOccurrence(r, new Date());
      if (!d) continue;
      try {
        new Notification(reminderTitle(r), {
          body: reminderBody(r), tag: "foco-trig-" + r.id,
          showTrigger: new TimestampTrigger(d.getTime()),
        });
      } catch (e) {}
    }
  }
  async function syncRemindersToSW() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    try {
      const cache = await caches.open("foco-data");
      await cache.put(new URL("reminders-data.json", location.href), new Response(JSON.stringify({
        reminders: state.reminders, lastShown: state.reminderLastShown,
      })));
      navigator.serviceWorker.controller.postMessage({ type: "reminders-updated" });
    } catch (e) {}
  }
  function buildIcs(reminders) {
    const lines = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Foco//Lembretes//PT-BR","CALSCALE:GREGORIAN","METHOD:PUBLISH"];
    reminders.forEach((r) => {
      const days = (r.days && r.days.length) ? r.days : [0,1,2,3,4,5,6];
      const byday = days.map((d) => ICS_DAYS[d]).join(",");
      const next = nextOccurrence(r, new Date()) || new Date();
      const stamp = next.getFullYear() + pad(next.getMonth() + 1) + pad(next.getDate()) + "T" + pad(next.getHours()) + pad(next.getMinutes()) + "00";
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + r.id + "@foco.app");
      lines.push("DTSTAMP:" + stamp);
      lines.push("DTSTART:" + stamp);
      lines.push("DURATION:PT15M");
      lines.push("RRULE:FREQ=WEEKLY;BYDAY=" + byday);
      lines.push("SUMMARY:" + (reminderTitle(r) + " — " + reminderBody(r)).replace(/\n/g, " "));
      lines.push("DESCRIPTION:Lembrete do app Foco. Importe no calendário do celular para ter um alarme confiável.");
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }
  function downloadIcs(reminders, filename) {
    const blob = new Blob([buildIcs(reminders)], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "foco-lembretes.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Arquivo de calendário baixado. Importe no Calendário ou Relógio para ter um alarme confiável.");
  }

  function minutesToAngle(m) { return (clamp(m, 0, MAX_MINUTES) / MAX_MINUTES) * 360; }
  function angleToMinutes(deg) { return snapMinutes((deg / 360) * MAX_MINUTES); }
  function eventAngle(e, el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const pt = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e);
    const ang = Math.atan2(pt.clientY - cy, pt.clientX - cx);
    return (ang * 180 / Math.PI + 90 + 360) % 360;
  }
  function polar(cx, cy, r, deg) {
    const rad = (deg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }
  function describeArc(cx, cy, r, startDeg, endDeg) {
    if (endDeg <= 0) return "";
    const sweep = Math.min(359.99, endDeg - startDeg);
    const start = polar(cx, cy, r, startDeg);
    const end = polar(cx, cy, r, startDeg + sweep);
    const large = sweep > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
  }
  function renderDialSvg(minutes, progress01, interactive) {
    const size = 200, cx = 100, cy = 100, r = 86;
    const ang = minutesToAngle(minutes);
    const remainAng = progress01 == null ? ang : (1 - progress01) * ang;
    let ticks = "";
    for (let m = 0; m < MAX_MINUTES; m += 15) {
      const a = minutesToAngle(m);
      const p1 = polar(cx, cy, r - 9, a);
      const p2 = polar(cx, cy, r + 9, a);
      ticks += `<line class="ticks" x1="${p1.x.toFixed(2)}" y1="${p1.y.toFixed(2)}" x2="${p2.x.toFixed(2)}" y2="${p2.y.toFixed(2)}"/>`;
    }
    const arc = remainAng > 0 ? `<path class="arc" d="${describeArc(cx, cy, r, 0, remainAng)}"/>` : "";
    const knobPos = polar(cx, cy, r, remainAng);
    const knob = interactive
      ? `<circle class="knob" data-knob="1" cx="${knobPos.x.toFixed(2)}" cy="${knobPos.y.toFixed(2)}" r="9"/>`
      : "";
    return `<svg class="dial-svg" viewBox="0 0 ${size} ${size}" role="slider" aria-valuemin="${MIN_MINUTES}" aria-valuemax="${MAX_MINUTES}" aria-valuenow="${minutes}" aria-label="Duração do foco em minutos">
      <circle class="track" cx="${cx}" cy="${cy}" r="${r}"/>
      ${ticks}${arc}${knob}
    </svg>`;
  }
  function bindDialEvents() {
    const svg = $(".dial-svg");
    if (!svg || svg.dataset.bound) return;
    const running = state.activeSession && state.activeSession.status === "running";
    if (running) return;
    svg.dataset.bound = "1";
    const onMove = (e) => {
      if (!dialDragging) return;
      e.preventDefault();
      pendingMinutes = angleToMinutes(eventAngle(e, svg));
      renderFoco();
    };
    const onUp = () => { dialDragging = false; };
    const onDown = (e) => {
      const sess = state.activeSession;
      if (sess && (sess.status === "running" || sess.status === "completed" || sess.status === "failed")) return;
      dialDragging = true;
      pendingMinutes = angleToMinutes(eventAngle(e, svg));
      renderFoco();
    };
    svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture(e.pointerId); onDown(e); });
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
  }

  function render() {
    applyTheme();
    renderHeader();
    renderFoco();
    renderFloresta();
    renderNotas();
    renderRecompensas();
    renderAjustes();
    renderMissedBanner();
  }
  function renderHeader() {
    const info = levelFromXp(state.profile.xp);
    const lvlEl = $("#hdr-level");
    const coinEl = $("#hdr-coins");
    if (lvlEl) lvlEl.textContent = "Nv. " + info.level;
    if (coinEl) coinEl.textContent = String(state.profile.coins);
  }

  function renderFoco() {
    const root = $("#view-foco");
    if (!root) return;
    const sess = state.activeSession;
    const running = sess && sess.status === "running";
    const ended = sess && (sess.status === "completed" || sess.status === "failed");
    const paused = running && sess.pausedAt;
    let minutes = pendingMinutes;
    let stage = 0, variant = "carvalho", withered = false, progress = 0;
    let timeLabel = minutes + " min";
    let unit = "minutos";
    let sub = "Gire o círculo para escolher o tempo";
    let status = "";

    if (running) {
      const rem = sessionRemainingMs(sess);
      const elap = sessionElapsedMs(sess);
      progress = clamp(elap / (sess.plannedMinutes * 60000), 0, 1);
      minutes = sess.plannedMinutes;
      stage = growthStage(sess);
      variant = sess.variant;
      timeLabel = fmtMMSS(paused ? sessionRemainingMs(sess, sess.pausedAt) : rem);
      unit = paused ? "restantes" : "restantes";
      sub = sess.subject ? sess.subject : (paused ? "Foco pausado" : "Foco em andamento");
      if (paused) status = `<span class="status-chip warn">Pausado</span>`;
      else if (state.settings.strictMode) status = `<span class="status-chip">Modo rigoroso · não saia do app</span>`;
      else status = `<span class="status-chip">Modo flexível</span>`;
    } else if (ended) {
      variant = sess.variant;
      withered = sess.status === "failed";
      stage = withered ? Math.max(1, growthStage(sess, sess.endedAt || Date.now())) : 5;
      progress = withered ? clamp(sessionElapsedMs(sess, sess.endedAt) / (sess.plannedMinutes * 60000), 0, 1) : 1;
      minutes = sess.plannedMinutes;
      if (withered) {
        timeLabel = "Murchou"; unit = "";
        sub = (sess.failReason === "pause-timeout")
          ? "A pausa passou de 1 hora. A árvore não sobreviveu."
          : "Você saiu ou desistiu. A árvore não sobreviveu.";
        status = `<span class="status-chip fail">Sessão perdida</span>`;
      } else {
        timeLabel = "Feito!"; unit = "+" + (sess.xp || 0) + " XP";
        sub = (sess.subject ? sess.subject + " · " : "") + sess.plannedMinutes + " min";
        status = `<span class="status-chip">Árvore plantada</span>`;
      }
    }

    const interactive = !running && !ended;
    const countdown = running
      ? `<div class="countdown-big"><span class="mm">${escapeHtml(timeLabel)}</span><span class="unit">${escapeHtml(unit)}</span></div>`
      : `<div class="countdown-big"><span class="mm">${ended ? escapeHtml(timeLabel) : pendingMinutes}</span><span class="unit">${ended ? escapeHtml(unit) : "min"}</span></div>`;

    let actions = "";
    if (running) {
      actions = `<div class="btn-row">
        <button class="btn btn-danger" id="btn-desistir">Desistir</button>
        ${paused
          ? `<button class="btn btn-primary" style="margin-top:0" id="btn-continuar">Continuar</button>`
          : `<button class="btn btn-ghost" id="btn-pausar">Pausar</button>`}
      </div>`;
    } else if (ended) {
      actions = `<button class="btn btn-primary" id="btn-nova">Plantar outra</button>`;
    } else {
      actions = `<button class="btn btn-primary" id="btn-plantar">🌱 Plantar</button>`;
    }

    const chips = state.recentSubjects.map((s) =>
      `<button type="button" class="chip ${s === pendingSubject ? "active" : ""}" data-subject="${escapeHtml(s)}">${escapeHtml(s)}</button>`
    ).join("");

    const subjectBlock = (!running && !ended) ? `
      <div class="subject-block">
        <div class="section-label">O que você está estudando?</div>
        <input class="field" id="subject-input" type="text" maxlength="80" placeholder="Ex.: matemática, inglês, redação…" value="${escapeHtml(pendingSubject)}" autocomplete="off">
        <div class="tag-suggestions">${chips}</div>
      </div>` : "";

    root.innerHTML = `
      <div class="foco-scene">
        <div class="sun"></div>
        <div class="hills"></div>
        <div class="dial-stage" id="dial-stage">
          ${renderDialSvg(minutes, running || ended ? progress : null, interactive)}
          ${countdown}
          <div class="dial-center">
            <div class="tree-wrap ${running && !paused ? "sway" : ""}" id="tree-wrap">
              ${treeSvg(stage, variant, withered, { sway: running && !paused })}
            </div>
          </div>
        </div>
      </div>
      <div class="timer-block">
        <div class="timer-sub">${escapeHtml(sub)}</div>
        ${status}
        ${paused ? `<div class="pause-panel">
          <div class="pause-clock" id="pause-clock">${fmtMMSS(pauseElapsedMs(sess))}</div>
          <div class="pause-label">tempo pausado</div>
          <p class="pause-hint">Se ficar pausado por mais de 1 hora, a árvore murcha.</p>
        </div>` : ""}
      </div>
      ${subjectBlock}
      ${actions}
    `;
    bindDialEvents();
    bindFocoEvents();
  }

  function renderFocoTimeOnly() {
    const sess = state.activeSession;
    if (!sess || sess.status !== "running") { renderFoco(); return; }
    const paused = !!sess.pausedAt;
    const rem = sessionRemainingMs(sess, paused ? sess.pausedAt : Date.now());
    const elap = sessionElapsedMs(sess);
    const progress = clamp(elap / (sess.plannedMinutes * 60000), 0, 1);
    const mm = $(".countdown-big .mm");
    const unit = $(".countdown-big .unit");
    if (mm) mm.textContent = fmtMMSS(rem);
    if (unit) unit.textContent = "restantes";
    const pclock = $("#pause-clock");
    if (paused && pclock) pclock.textContent = fmtMMSS(pauseElapsedMs(sess));
    const svgHost = $(".dial-stage");
    if (svgHost) {
      const old = svgHost.querySelector(".dial-svg");
      const tmp = document.createElement("div");
      tmp.innerHTML = renderDialSvg(sess.plannedMinutes, progress, false);
      if (old && tmp.firstElementChild) old.replaceWith(tmp.firstElementChild);
    }
    const stage = growthStage(sess);
    const wrap = $("#tree-wrap");
    if (wrap && wrap.dataset.stage !== String(stage)) {
      wrap.dataset.stage = String(stage);
      wrap.classList.add("grow-pop");
      wrap.innerHTML = treeSvg(stage, sess.variant, false, { sway: !paused });
      setTimeout(() => wrap.classList.remove("grow-pop"), 500);
    }
  }

  function bindFocoEvents() {
    const plant = $("#btn-plantar");
    if (plant) plant.addEventListener("click", () => {
      pendingSubject = ($("#subject-input") && $("#subject-input").value) || pendingSubject;
      startSession();
    });
    const input = $("#subject-input");
    if (input) {
      input.addEventListener("input", () => { pendingSubject = input.value; });
    }
    $$("[data-subject]").forEach((b) => {
      b.addEventListener("click", () => {
        pendingSubject = b.getAttribute("data-subject") || "";
        renderFoco();
      });
    });
    const des = $("#btn-desistir");
    if (des) des.addEventListener("click", () => {
      openConfirm("Desistir desta árvore?", "Se você desistir, a árvore murcha e a sessão não conta pontos.", () => failSession("gaveup"));
    });
    const pausar = $("#btn-pausar");
    if (pausar) pausar.addEventListener("click", pauseSession);
    const continuar = $("#btn-continuar");
    if (continuar) continuar.addEventListener("click", resumeSession);
    const nova = $("#btn-nova");
    if (nova) nova.addEventListener("click", () => { clearActive(); });
  }

  function renderFloresta() {
    const root = $("#view-floresta");
    if (!root) return;
    const info = levelFromXp(state.profile.xp);
    const pct = Math.round((info.into / info.need) * 100);
    const p = state.profile;
    const week = weekStats();
    const bySub = subjectStats();
    const forest = state.sessions.slice(0, 60);
    const cells = forest.map((s) => {
      const w = s.status === "failed";
      return `<button class="forest-cell ${w ? "withered" : ""}" data-sess="${s.id}" title="${escapeHtml((s.subject || "Foco") + " · " + formatDateTime(s.startedAt))}">${treeSvg(w ? 3 : 5, s.variant, w)}</button>`;
    }).join("");
    const weekCols = week.map((d) => {
      const h = d.minutes ? Math.max(8, Math.round((d.minutes / Math.max(60, week.max)) * 80)) : 4;
      return `<div class="week-bar ${d.isToday ? "today" : ""}">
        <div class="col" style="height:${h}px;opacity:${d.minutes ? 1 : 0.3}"></div>
        <div class="d">${d.label}</div>
      </div>`;
    }).join("");
    const tagRows = bySub.length ? bySub.map((t) => {
      const w = Math.round((t.minutes / bySub[0].minutes) * 100);
      return `<div class="tag-row-stat"><span class="name" title="${escapeHtml(t.subject)}">${escapeHtml(t.subject)}</span>
        <div class="bar"><span style="width:${w}%"></span></div>
        <span class="mins">${t.minutes} min</span></div>`;
    }).join("") : `<p class="forest-empty">Os assuntos das suas sessões aparecem aqui.</p>`;
    const hist = state.sessions.slice(0, 12).map((s) => {
      const w = s.status === "failed";
      return `<div class="hist-item">
        <div class="mini">${treeSvg(w ? 3 : 5, s.variant, w)}</div>
        <div style="flex:1">
          <div class="when">${escapeHtml(s.subject || "Foco livre")} ${w ? '<span class="fail-dot">· murchou</span>' : '<span class="ok-dot">· concluída</span>'}</div>
          <div class="meta">${formatDateTime(s.startedAt)} · ${w ? (s.actualMinutes + "/" + s.plannedMinutes) : s.plannedMinutes} min${s.xp ? " · +" + s.xp + " XP" : ""}</div>
        </div>
      </div>`;
    }).join("") || `<p class="forest-empty">Plante sua primeira árvore na aba Foco.</p>`;

    root.innerHTML = `
      <div class="card level-card">
        <div class="level-top">
          <div class="level-num">Nível ${info.level}</div>
          <div class="xp-label">${info.into} / ${info.need} XP</div>
        </div>
        <div class="bar"><span style="width:${pct}%"></span></div>
      </div>
      <div class="stat-grid">
        <div class="stat"><b>${p.totalMinutes}</b><span>minutos</span></div>
        <div class="stat"><b>${p.totalSessions}</b><span>sessões</span></div>
        <div class="stat"><b>${p.currentStreak}d</b><span>ofensiva</span></div>
      </div>
      <div class="card">
        <div class="section-label" style="margin-top:0">Sua floresta</div>
        ${cells ? `<div class="forest-grid">${cells}</div>` : `<p class="forest-empty">As árvores que você plantar (e as que murcharam) ficam aqui.</p>`}
      </div>
      <div class="card">
        <div class="section-label" style="margin-top:0">Esta semana</div>
        <div class="week-bars">${weekCols}</div>
      </div>
      <div class="card">
        <div class="section-label" style="margin-top:0">Por assunto</div>
        <div class="tag-list">${tagRows}</div>
      </div>
      <div class="card">
        <div class="section-label" style="margin-top:0">Histórico</div>
        ${hist}
      </div>
    `;
    $$("[data-sess]", root).forEach((b) => b.addEventListener("click", () => showSession(b.getAttribute("data-sess"))));
  }

  function weekStats() {
    const today = new Date();
    const dow = today.getDay();
    const mondayOff = dow === 0 ? -6 : 1 - dow;
    const days = [];
    let max = 1;
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + mondayOff + i);
      const k = todayKey(d);
      const minutes = state.sessions.filter((s) => s.status === "completed" && todayKey(s.startedAt) === k)
        .reduce((a, s) => a + (s.actualMinutes || s.plannedMinutes), 0);
      max = Math.max(max, minutes);
      days.push({ key: k, minutes, label: DAY_LABELS[d.getDay()], isToday: k === todayKey() });
    }
    days.max = max;
    return days;
  }
  function subjectStats() {
    const map = {};
    state.sessions.forEach((s) => {
      if (s.status !== "completed") return;
      const name = s.subject || "Foco livre";
      map[name] = (map[name] || 0) + (s.actualMinutes || s.plannedMinutes || 0);
    });
    return Object.keys(map).map((subject) => ({ subject, minutes: map[subject] })).sort((a, b) => b.minutes - a.minutes);
  }
  function showSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    const w = s.status === "failed";
    openModal(`
      <div class="grab"></div>
      <div style="width:120px;margin:0 auto 8px">${treeSvg(w ? 3 : 5, s.variant, w)}</div>
      <h2 style="text-align:center">${escapeHtml(s.subject || "Foco livre")}</h2>
      <p class="timer-sub" style="text-align:center">${formatDateTime(s.startedAt)}</p>
      <p style="text-align:center;margin-top:8px;font-weight:700">${w ? "Árvore murchou · " + s.actualMinutes + " de " + s.plannedMinutes + " min" : s.plannedMinutes + " min concluídos"}</p>
      ${s.xp ? `<p style="text-align:center;color:var(--ink-soft)">+${s.xp} XP · +${s.coins} moedas</p>` : ""}
      <button class="btn btn-primary" data-close>Fechar</button>
    `);
  }

  function sessionsOnDay(key) {
    return state.sessions.filter((s) => todayKey(s.startedAt) === key);
  }
  function renderNotas() {
    const root = $("#view-notas");
    if (!root) return;
    const key = selectedNoteDay;
    const note = state.notes[key] || { text: "", updatedAt: null };
    const sess = sessionsOnDay(key);
    const doneMin = sess.filter((s) => s.status === "completed").reduce((a, s) => a + (s.actualMinutes || s.plannedMinutes), 0);
    const failed = sess.filter((s) => s.status === "failed").length;
    const subjects = Array.from(new Set(sess.filter((s) => s.subject).map((s) => s.subject)));
    const y = calCursor.getFullYear();
    const m = calCursor.getMonth();
    const first = new Date(y, m, 1);
    const startDow = first.getDay();
    const daysIn = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    let cells = "";
    for (let i = 0; i < 42; i++) {
      let day, mute, cellKey;
      if (i < startDow) {
        day = prevDays - startDow + 1 + i; mute = true;
        cellKey = todayKey(new Date(y, m - 1, day));
      } else if (i >= startDow + daysIn) {
        day = i - startDow - daysIn + 1; mute = true;
        cellKey = todayKey(new Date(y, m + 1, day));
      } else {
        day = i - startDow + 1; mute = false;
        cellKey = todayKey(new Date(y, m, day));
      }
      const hasS = sessionsOnDay(cellKey).length > 0;
      const hasN = !!(state.notes[cellKey] && state.notes[cellKey].text);
      const cls = ["cal-day", mute ? "mute" : "", cellKey === todayKey() ? "today" : "", cellKey === key ? "sel" : ""].filter(Boolean).join(" ");
      cells += `<button class="${cls}" data-day="${cellKey}"><span>${day}</span><span class="dots">${hasS ? '<i class="dot sess"></i>' : ""}${hasN ? '<i class="dot note"></i>' : ""}</span></button>`;
    }
    const sessHtml = sess.length ? sess.map((s) => {
      const w = s.status === "failed";
      return `<div class="hist-item">
        <div class="mini">${treeSvg(w ? 3 : 5, s.variant, w)}</div>
        <div style="flex:1">
          <div class="when">${escapeHtml(s.subject || "Foco livre")} ${w ? '<span class="fail-dot">· murchou</span>' : '<span class="ok-dot">· concluída</span>'}</div>
          <div class="meta">${new Date(s.startedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · ${w ? s.actualMinutes + "/" + s.plannedMinutes : s.plannedMinutes} min</div>
        </div>
      </div>`;
    }).join("") : `<p class="forest-empty">Nenhuma sessão neste dia.</p>`;
    const isToday = key === todayKey();
    root.innerHTML = `
      <div class="card">
        <div class="cal-head">
          <button type="button" id="cal-prev" aria-label="Mês anterior">‹</button>
          <h3>${MONTHS[m]} ${y}</h3>
          <button type="button" id="cal-next" aria-label="Próximo mês">›</button>
        </div>
        <div class="cal-weekdays">${DAY_LABELS.map((x) => `<span>${x}</span>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        <p class="note-meta">Ponto verde: sessões · ponto dourado: anotação</p>
      </div>
      <div class="card">
        <div class="section-label" style="margin-top:0">${isToday ? "Anotações do dia" : "Anotação — " + formatDate(key)}</div>
        <p class="note-meta">${doneMin} min de foco${subjects.length ? " · " + subjects.join(", ") : ""}${failed ? " · " + failed + " árvore(s) murcha(s)" : ""}</p>
        <textarea class="note-area" id="note-text" maxlength="4000" placeholder="${isToday ? "Como foi o estudo hoje? O que deu certo, o que falta revisar…" : "Escreva uma reflexão para este dia."}">${escapeHtml(note.text || "")}</textarea>
        <p class="note-meta" id="note-saved">${note.updatedAt ? "Salva às " + new Date(note.updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "As anotações salvam automaticamente."}</p>
        <div class="day-sessions">${sessHtml}</div>
      </div>
    `;
    $("#cal-prev").addEventListener("click", () => { calCursor = new Date(y, m - 1, 1); renderNotas(); });
    $("#cal-next").addEventListener("click", () => { calCursor = new Date(y, m + 1, 1); renderNotas(); });
    $$("[data-day]", root).forEach((b) => b.addEventListener("click", () => { selectedNoteDay = b.getAttribute("data-day"); renderNotas(); }));
    const ta = $("#note-text");
    let tmr = null;
    ta.addEventListener("input", () => {
      clearTimeout(tmr);
      tmr = setTimeout(() => {
        const text = ta.value;
        if (!text.trim()) delete state.notes[key];
        else state.notes[key] = { text, updatedAt: Date.now() };
        saveState();
        const meta = $("#note-saved");
        if (meta) meta.textContent = "Salva agora";
      }, 300);
    });
  }

  function renderRecompensas() {
    const root = $("#view-recompensas");
    if (!root) return;
    const list = (state.rewards || []).map((r) => {
      const unlocked = rewardUnlocked(r);
      const claimedDone = r.claimed && !r.repeatable;
      let badge = claimedDone
        ? `<span class="badge badge-done">Resgatada</span>`
        : unlocked
          ? `<span class="badge badge-ok">Disponível</span>`
          : `<span class="badge badge-lock">Bloqueada</span>`;
      if (r.repeatable) badge += `<span class="badge badge-done">Repetível${r.claimCount ? " · " + r.claimCount + "x" : ""}</span>`;
      const crits = (r.criteria || []).map((c) => {
        const p = criterionProgress(c, r);
        const pct = p.target ? Math.min(100, Math.round((p.current / p.target) * 100)) : 0;
        return `<div class="crit"><div class="crit-meta"><span>${escapeHtml(criterionLabel(c))}</span><span>${p.current}/${p.target}</span></div>
          <div class="bar"><span style="width:${pct}%"></span></div></div>`;
      }).join("");
      const claimedInfo = r.lastClaimedAt ? `<p class="note-meta">Último resgate: ${formatDateTime(r.lastClaimedAt)}</p>` : "";
      const canClaim = unlocked && !claimedDone;
      return `<div class="card reward-card">
        <div class="reward-head">
          <div class="reward-emoji">${escapeHtml(r.emoji || "🎁")}</div>
          <div style="flex:1">
            <h3>${escapeHtml(r.name)}</h3>
            ${r.description ? `<p>${escapeHtml(r.description)}</p>` : ""}
            ${badge}
          </div>
        </div>
        <div class="crit-list">${crits}</div>
        ${claimedInfo}
        <div class="reward-actions">
          ${canClaim ? `<button class="btn btn-primary" style="margin-top:0" data-claim="${r.id}">Resgatar</button>` : ""}
          <button class="btn btn-ghost" data-edit-reward="${r.id}">Editar</button>
          <button class="btn btn-danger" data-del-reward="${r.id}">Excluir</button>
        </div>
      </div>`;
    }).join("") || `<p class="forest-empty">Crie recompensas suas — um episódio, um lanche, uma folga — e defina o que precisa cumprir para desbloquear.</p>`;

    root.innerHTML = list + `<button class="btn btn-add" id="btn-new-reward">＋ Nova recompensa</button>`;
    $("#btn-new-reward").addEventListener("click", () => openRewardEditor(null));
    $$("[data-claim]").forEach((b) => b.addEventListener("click", () => claimReward(b.getAttribute("data-claim"))));
    $$("[data-edit-reward]").forEach((b) => b.addEventListener("click", () => openRewardEditor(b.getAttribute("data-edit-reward"))));
    $$("[data-del-reward]").forEach((b) => b.addEventListener("click", () => {
      openConfirm("Excluir esta recompensa?", "Esta ação não dá para desfazer.", () => {
        state.rewards = state.rewards.filter((x) => x.id !== b.getAttribute("data-del-reward"));
        saveState();
        renderRecompensas();
      });
    }));
  }

  function openRewardEditor(id) {
    const existing = id ? state.rewards.find((x) => x.id === id) : null;
    editingRewardId = existing ? existing.id : null;
    const r = existing || { name: "", description: "", emoji: "🎁", criteria: [{ type: "sessions", value: 5 }], repeatable: false };
    const criteria = (r.criteria && r.criteria.length ? r.criteria : [{ type: "sessions", value: 5 }]).map((c, i) => critEditorRow(c, i)).join("");
    openModal(`
      <div class="grab"></div>
      <h2>${existing ? "Editar recompensa" : "Nova recompensa"}</h2>
      <div class="form-grid">
        <label>Emoji</label>
        <input class="field" id="rw-emoji" maxlength="8" value="${escapeHtml(r.emoji || "🎁")}">
        <label>Nome</label>
        <input class="field" id="rw-name" maxlength="60" value="${escapeHtml(r.name)}" placeholder="Ex.: Episódio da série">
        <label>Descrição (opcional)</label>
        <input class="field" id="rw-desc" maxlength="140" value="${escapeHtml(r.description || "")}" placeholder="O que você vai se permitir">
        <label>Critérios (todos, ao mesmo tempo)</label>
        <div class="crit-builder" id="rw-crits">${criteria}</div>
        <button class="btn btn-ghost" type="button" id="rw-add-crit">＋ Adicionar critério</button>
        <div class="setting-row" style="border:0;padding:4px 0">
          <div><h3>Repetível</h3><p>Depois de resgatar, a contagem recomeça.</p></div>
          <button type="button" class="toggle" id="rw-rep" role="switch" aria-checked="${r.repeatable ? "true" : "false"}"></button>
        </div>
        <button class="btn btn-primary" type="button" id="rw-save">Salvar</button>
      </div>
    `);
    $("#rw-rep").addEventListener("click", () => {
      const on = $("#rw-rep").getAttribute("aria-checked") !== "true";
      $("#rw-rep").setAttribute("aria-checked", on ? "true" : "false");
    });
    $("#rw-add-crit").addEventListener("click", () => {
      const box = $("#rw-crits");
      const wrap = document.createElement("div");
      wrap.innerHTML = critEditorRow({ type: "totalMinutes", value: 30 }, box.children.length);
      box.appendChild(wrap.firstElementChild);
      bindCritRows();
    });
    bindCritRows();
    $("#rw-save").addEventListener("click", saveRewardFromEditor);
  }
  function critEditorRow(c, i) {
    const opts = CRIT_TYPES.map((t) => `<option value="${t.id}" ${t.id === c.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("");
    const showSub = c.type === "subjectMinutes";
    return `<div class="crit-edit" data-crit-row>
      <div class="crit-edit-row">
        <select class="field c-type">${opts}</select>
        <button type="button" class="icon-btn c-del" aria-label="Remover">✕</button>
      </div>
      <div class="crit-edit-row">
        <input class="field c-subject" type="text" placeholder="Assunto (ex.: matemática)" value="${escapeHtml(c.subject || "")}" style="${showSub ? "" : "display:none"}">
        <input class="field c-value" type="number" min="1" inputmode="numeric" value="${escapeHtml(c.value || 1)}" placeholder="Valor">
      </div>
    </div>`;
  }
  function bindCritRows() {
    $$("[data-crit-row]").forEach((row) => {
      const type = $(".c-type", row);
      const sub = $(".c-subject", row);
      const del = $(".c-del", row);
      type.onchange = () => { sub.style.display = type.value === "subjectMinutes" ? "" : "none"; };
      del.onclick = () => {
        if ($$("[data-crit-row]").length <= 1) { toast("Deixe pelo menos um critério."); return; }
        row.remove();
      };
    });
  }
  function saveRewardFromEditor() {
    const name = ($("#rw-name").value || "").trim();
    if (!name) { toast("Dê um nome à recompensa."); return; }
    const emoji = ($("#rw-emoji").value || "🎁").trim().slice(0, 8);
    const description = ($("#rw-desc").value || "").trim();
    const repeatable = $("#rw-rep").getAttribute("aria-checked") === "true";
    const criteria = $$("[data-crit-row]").map((row) => {
      const type = $(".c-type", row).value;
      const value = Math.max(1, parseInt($(".c-value", row).value, 10) || 1);
      const subject = ($(".c-subject", row).value || "").trim();
      return type === "subjectMinutes" ? { type, value, subject } : { type, value };
    });
    if (criteria.some((c) => c.type === "subjectMinutes" && !c.subject)) {
      toast("Informe o assunto do critério.");
      return;
    }
    if (editingRewardId) {
      const r = state.rewards.find((x) => x.id === editingRewardId);
      Object.assign(r, { name, emoji, description, criteria, repeatable });
    } else {
      state.rewards.push({ id: uid(), name, emoji, description, criteria, repeatable, claimed: false, claimCount: 0, lastClaimedAt: null });
    }
    saveState();
    closeModal();
    renderRecompensas();
    toast("Recompensa salva.");
  }

  function renderAjustes() {
    const root = $("#view-ajustes");
    if (!root) return;
    const s = state.settings;
    const remHtml = (state.reminders || []).map((r) => reminderCard(r)).join("") ||
      `<p class="forest-empty">Nenhum lembrete ainda. Crie horários de estudo ou um toque para a anotação do dia.</p>`;
    root.innerHTML = `
      <div class="card">
        <div class="setting-row">
          <div><h3>Modo rigoroso</h3><p>Sair do app por mais de 10s, com o timer rodando, murcha a árvore. Pode pausar; se a pausa passar de 1 hora, a árvore também murcha.</p></div>
          <button type="button" class="toggle" id="set-strict" role="switch" aria-checked="${s.strictMode ? "true" : "false"}"></button>
        </div>
        <div class="setting-row">
          <div><h3>Modo flexível</h3><p>Pode sair do app com o timer rodando sem murchar. A pausa também existe, com o mesmo limite de 1 hora.</p></div>
          <button type="button" class="toggle" id="set-flex" role="switch" aria-checked="${!s.strictMode ? "true" : "false"}"></button>
        </div>
        <div class="setting-row">
          <div><h3>Som</h3><p>Toques ao concluir, murchar ou no lembrete.</p></div>
          <button type="button" class="toggle" id="set-sound" role="switch" aria-checked="${s.sound ? "true" : "false"}"></button>
        </div>
        <div class="setting-row">
          <div><h3>Notificar ao concluir</h3><p>Pede permissão do sistema quando necessário.</p></div>
          <button type="button" class="toggle" id="set-notif" role="switch" aria-checked="${s.notifyOnComplete ? "true" : "false"}"></button>
        </div>
        <div class="setting-row">
          <div><h3>Aparência</h3><p>Claro no estilo Forest, ou escuro suave.</p></div>
          <div class="theme-seg" id="theme-seg">
            <button type="button" data-theme="light" class="${s.theme === "light" ? "active" : ""}">Claro</button>
            <button type="button" data-theme="auto" class="${s.theme === "auto" ? "active" : ""}">Auto</button>
            <button type="button" data-theme="dark" class="${s.theme === "dark" ? "active" : ""}">Escuro</button>
          </div>
        </div>
      </div>
      <div class="section-label">Lembretes de estudo</div>
      <div id="reminder-list">${remHtml}</div>
      <button class="btn btn-add" id="btn-new-rem">＋ Novo lembrete</button>
      <button class="btn btn-ghost" style="width:100%;margin-top:8px" id="btn-journal-rem">📝 Lembrete da anotação do dia</button>
      <div class="help">
        <strong>Sobre notificações:</strong> com o app aberto, os lembretes disparam no horário. Se você abrir o app depois, mostramos o lembrete atrasado (até 3 horas).
        No Android/Chrome, notificações agendadas com o app fechado ou removido da memória não são confiáveis — o navegador não permite um alarme estável sem um servidor de push.
        No iOS, notificações web só funcionam em PWA instalado, e também não disparam com o app fechado.
        <strong>Para um alarme de verdade,</strong> use “Adicionar ao calendário/alarme” e importe o arquivo .ics no Calendário do celular.
      </div>
      <div class="section-label">Dados</div>
      <div class="card">
        <button class="btn btn-ghost" style="width:100%" id="btn-export">Exportar backup (JSON)</button>
        <label class="btn btn-ghost file-btn" style="width:100%;margin-top:8px">Importar backup<input type="file" id="btn-import" accept="application/json,.json"></label>
        <button class="btn btn-danger" style="width:100%;margin-top:8px" id="btn-reset">Apagar todos os dados</button>
      </div>
      <div class="help">
        Versão local, offline, só no seu aparelho. Para instalar como app, abra pelo HTTPS (ou localhost) e use “Adicionar à tela inicial”.
        O arquivo <strong>foco.html</strong> funciona aberto direto da pasta, sem servidor — mas instalação PWA e service worker exigem HTTPS.
      </div>
    `;
    bindToggle("#set-strict", (on) => { state.settings.strictMode = on; saveState(); renderAjustes(); renderFoco(); });
    $("#set-flex").onclick = () => {
      const wantFlex = $("#set-flex").getAttribute("aria-checked") !== "true";
      state.settings.strictMode = !wantFlex;
      saveState();
      renderAjustes();
      renderFoco();
    };
    bindToggle("#set-sound", (on) => { state.settings.sound = on; saveState(); });
    bindToggle("#set-notif", async (on) => {
      state.settings.notifyOnComplete = on;
      if (on) await ensureNotifyPerm();
      saveState();
    });
    $$("#theme-seg [data-theme]").forEach((b) => b.addEventListener("click", () => {
      state.settings.theme = b.getAttribute("data-theme");
      saveState();
      applyTheme();
      renderAjustes();
    }));
    $("#btn-new-rem").addEventListener("click", () => openReminderEditor(null));
    $("#btn-journal-rem").addEventListener("click", () => {
      const exists = state.reminders.find((r) => r.type === "journal");
      if (exists) openReminderEditor(exists.id);
      else openReminderEditor(null, { type: "journal", time: "21:00", days: [0,1,2,3,4,5,6], message: "Que tal escrever a anotação do dia?", enabled: true });
    });
    $$("[data-edit-rem]").forEach((b) => b.addEventListener("click", () => openReminderEditor(b.getAttribute("data-edit-rem"))));
    $$("[data-del-rem]").forEach((b) => b.addEventListener("click", () => {
      state.reminders = state.reminders.filter((x) => x.id !== b.getAttribute("data-del-rem"));
      saveState();
      scheduleOpenReminders();
      renderAjustes();
    }));
    $$("[data-toggle-rem]").forEach((b) => b.addEventListener("click", async () => {
      const r = state.reminders.find((x) => x.id === b.getAttribute("data-toggle-rem"));
      if (!r) return;
      r.enabled = !r.enabled;
      if (r.enabled) await ensureNotifyPerm();
      saveState();
      scheduleOpenReminders();
      renderAjustes();
    }));
    $$("[data-ics]").forEach((b) => b.addEventListener("click", () => {
      const r = state.reminders.find((x) => x.id === b.getAttribute("data-ics"));
      if (r) downloadIcs([r], "foco-" + (r.type === "journal" ? "anotacao" : "lembrete") + ".ics");
    }));
    $("#btn-export").addEventListener("click", exportBackup);
    $("#btn-import").addEventListener("change", importBackup);
    $("#btn-reset").addEventListener("click", () => {
      openConfirm("Apagar todos os dados?", "Sessões, floresta, recompensas, anotações e lembretes serão removidos deste aparelho.", () => {
        state = DEFAULT_STATE();
        pendingMinutes = 25;
        pendingSubject = "";
        saveState();
        render();
        toast("Tudo apagado.");
      });
    });
  }
  function bindToggle(sel, fn) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("click", () => {
      const on = el.getAttribute("aria-checked") !== "true";
      el.setAttribute("aria-checked", on ? "true" : "false");
      fn(on);
    });
  }
  function reminderCard(r) {
    const days = DAY_LABELS.map((lab, i) => {
      const on = (r.days || []).indexOf(i) !== -1;
      return `<span class="day-chip ${on ? "on" : ""}">${lab}</span>`;
    }).join("");
    return `<div class="card reminder-card">
      <div class="reminder-top">
        <div>
          <div class="reminder-time">${escapeHtml(r.time)}</div>
          <div class="reminder-msg">${escapeHtml(reminderBody(r))}</div>
        </div>
        <button type="button" class="toggle" data-toggle-rem="${r.id}" role="switch" aria-checked="${r.enabled ? "true" : "false"}"></button>
      </div>
      <div class="days">${days}</div>
      <div class="btn-row">
        <button class="btn btn-ghost" data-ics="${r.id}">📅 Calendário/alarme</button>
        <button class="btn btn-ghost" data-edit-rem="${r.id}">Editar</button>
        <button class="btn btn-danger" data-del-rem="${r.id}">Excluir</button>
      </div>
    </div>`;
  }
  function openReminderEditor(id, preset) {
    const existing = id ? state.reminders.find((x) => x.id === id) : null;
    const r = existing || preset || { type: "study", time: "19:00", days: [1,2,3,4,5], message: "Hora de focar!", enabled: true };
    const days = [0,1,2,3,4,5,6].map((i) => {
      const on = (r.days || []).indexOf(i) !== -1;
      return `<button type="button" class="day-chip ${on ? "active" : ""}" data-day="${i}">${DAY_LABELS[i]}</button>`;
    }).join("");
    openModal(`
      <div class="grab"></div>
      <h2>${existing ? "Editar lembrete" : (r.type === "journal" ? "Lembrete da anotação" : "Novo lembrete")}</h2>
      <div class="form-grid">
        <label>Horário</label>
        <input class="field" id="rm-time" type="time" value="${escapeHtml(r.time || "19:00")}">
        <label>Dias da semana</label>
        <div class="days" id="rm-days">${days}</div>
        <label>Mensagem</label>
        <input class="field" id="rm-msg" maxlength="120" value="${escapeHtml(r.message || "")}" placeholder="Hora de focar!">
        <input type="hidden" id="rm-type" value="${escapeHtml(r.type || "study")}">
        <button class="btn btn-primary" id="rm-save">Salvar lembrete</button>
      </div>
    `);
    $$("#rm-days [data-day]").forEach((b) => b.addEventListener("click", () => b.classList.toggle("active")));
    $("#rm-save").addEventListener("click", async () => {
      const time = $("#rm-time").value || "19:00";
      const daysSel = $$("#rm-days [data-day].active").map((b) => parseInt(b.getAttribute("data-day"), 10));
      if (!daysSel.length) { toast("Escolha pelo menos um dia."); return; }
      const message = ($("#rm-msg").value || "").trim();
      const type = $("#rm-type").value || "study";
      if (existing) Object.assign(existing, { time, days: daysSel, message, type });
      else state.reminders.push({ id: uid(), enabled: true, time, days: daysSel, message, type });
      await ensureNotifyPerm();
      saveState();
      scheduleOpenReminders();
      closeModal();
      renderAjustes();
      toast("Lembrete salvo.");
    });
  }

  function exportBackup() {
    const payload = { app: "foco", exportedAt: new Date().toISOString(), ...state, activeSession: null };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "foco-backup-" + todayKey() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Backup exportado.");
  }
  function importBackup(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || (data.app !== "foco" && !data.profile && !data.sessions)) throw new Error("formato");
        const base = DEFAULT_STATE();
        state = {
          ...base, ...data, version: 1,
          settings: { ...base.settings, ...(data.settings || {}) },
          profile: { ...base.profile, ...(data.profile || {}) },
          sessions: Array.isArray(data.sessions) ? data.sessions : [],
          rewards: Array.isArray(data.rewards) ? data.rewards : [],
          reminders: Array.isArray(data.reminders) ? data.reminders : [],
          notes: data.notes && typeof data.notes === "object" ? data.notes : {},
          recentSubjects: Array.isArray(data.recentSubjects) ? data.recentSubjects : [],
          reminderLastShown: data.reminderLastShown || {},
          activeSession: null,
        };
        saveState();
        scheduleOpenReminders();
        render();
        toast("Backup importado.");
      } catch (err) {
        toast("Arquivo inválido.");
      }
    };
    reader.readAsText(file);
  }

  function showTab(name) {
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === name));
    if (name === "floresta") renderFloresta();
    if (name === "notas") renderNotas();
    if (name === "recompensas") renderRecompensas();
    if (name === "ajustes") renderAjustes();
  }
  function openModal(html, center) {
    closeModal();
    const bg = document.createElement("div");
    bg.className = "modal-bg" + (center ? " center" : "");
    bg.id = "modal-bg";
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    bg.addEventListener("click", (e) => { if (e.target === bg) closeModal(); });
    document.body.appendChild(bg);
    bg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  }
  function closeModal() {
    const bg = $("#modal-bg");
    if (bg) bg.remove();
  }
  function openConfirm(title, text, onYes) {
    openModal(`
      <div class="grab"></div>
      <h2>${escapeHtml(title)}</h2>
      <p class="danger-text">${escapeHtml(text)}</p>
      <div class="btn-row">
        <button class="btn btn-ghost" data-close>Cancelar</button>
        <button class="btn btn-danger" id="confirm-yes">Confirmar</button>
      </div>
    `, true);
    $("#confirm-yes").addEventListener("click", () => { closeModal(); onYes(); });
  }
  function toast(msg) {
    $$(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  function showLevelUp(from, to) {
    const ov = document.createElement("div");
    ov.className = "overlay-level";
    ov.innerHTML = `<div class="level-up">
      <div class="burst">🌟</div>
      <h2>Subiu de nível!</h2>
      <p>Nível ${from} → <strong>Nível ${to}</strong></p>
      <button class="btn btn-primary" style="margin-top:16px">Continuar</button>
    </div>`;
    ov.querySelector("button").addEventListener("click", () => ov.remove());
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
    if (state.settings.sound) {
      beep(523, 0.15, "sine", 0.07, 0);
      beep(784, 0.2, "sine", 0.07, 0.16);
      beep(1046, 0.4, "sine", 0.08, 0.32);
    }
    vibrate([30, 40, 30, 40, 80]);
  }
  function renderMissedBanner() {
    const old = $("#missed-banner");
    if (old) old.remove();
    if (!missedBanner) return;
    const t = document.createElement("div");
    t.className = "missed-bar";
    t.id = "missed-banner";
    t.innerHTML = "<div class=\"txt\"></div><button type=\"button\" class=\"x\" aria-label=\"Fechar\">✕</button>";
    t.querySelector(".txt").textContent = missedBanner.title + " — " + missedBanner.body;
    const go = () => {
      const typ = missedBanner && missedBanner.type;
      missedBanner = null;
      t.remove();
      if (typ === "journal") showTab("notas");
      else showTab("foco");
    };
    t.querySelector(".txt").addEventListener("click", go);
    t.querySelector(".x").addEventListener("click", (e) => { e.stopPropagation(); missedBanner = null; t.remove(); });
    const header = $(".app-header");
    if (header && header.parentNode) header.after(t);
    else document.getElementById("app").prepend(t);
  }

  function bindShell() {
    $$(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.getAttribute("data-tab"))));
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", () => {
      if (state.activeSession && state.activeSession.status === "running") {
        state.activeSession.lastHeartbeat = Date.now();
        state.activeSession.hiddenAt = state.activeSession.hiddenAt || Date.now();
        saveState();
      }
    });
    try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme); } catch (e) {}
    document.addEventListener("click", () => { try { getAudio(); } catch (err) {} }, { once: true });
  }
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").then(() => syncRemindersToSW()).catch(() => {});
    if (navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => {
        if (reg.periodicSync) {
          reg.periodicSync.register("foco-reminder-check", { minInterval: 60 * 60 * 1000 }).catch(() => {});
        }
      }).catch(() => {});
    }
  }
  function init() {
    state = loadState();
    applyTheme();
    bindShell();
    recoverActiveOnLoad();
    render();
    checkMissedReminders();
    scheduleOpenReminders();
    registerSW();
  }

  window.FocoApp = {
    init, getState: () => state, setState: (s) => { state = s; saveState(); if (enforcePauseLimit()) return; render(); if (state.activeSession && state.activeSession.status === "running") { startTicking(); if (state.activeSession.pausedAt) schedulePauseWatch(); } },
    showTab, startSession, failSession, completeSession, pauseSession, resumeSession,
    recoverActiveOnLoad, enforcePauseLimit,
    pendingMinutesSet: (m) => { pendingMinutes = snapMinutes(m); },
    STORAGE_KEY, todayKey, levelFromXp, PAUSE_LIMIT_MS, GRACE_MS,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
