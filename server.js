const express = require("express");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT, 10) || 3737;
const SESSION_DIR = path.join(__dirname, ".sessions");

// ── In-memory state ──────────────────────────────────────────────────
let config = {
  targetUrl:
    process.env.TARGET_URL ||
    "https://queue.rundisney.com/?c=rundisney&e=EVENT_ID&t=https%3A%2F%2Fwww.rundisney.com%2F",
  browserCount: parseInt(process.env.BROWSER_COUNT, 10) || 5,
};

const OFFSET_X = 150;
const OFFSET_Y = 80;
const WIN_WIDTH = 800;
const WIN_HEIGHT = 600;
const POLL_INTERVAL_MS = 60_000;

let nextId = 1;
const sessions = []; // { id, name, context, page, status, waitInfo, verified, cookieId, pollTimer }
const sseClients = [];

// ── Helpers ──────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  broadcast({ type: "log", message: line });
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sessionJson(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    waitInfo: s.waitInfo || null,
    verified: s.verified || false,
    cookieId: s.cookieId || null,
  };
}

function removeSingletonLock(dir) {
  const lock = path.join(dir, "SingletonLock");
  try {
    fs.unlinkSync(lock);
  } catch (_) {
    /* ignore */
  }
}

// ── Page status polling ──────────────────────────────────────────────
async function pollPageStatus(session) {
  if (!session.page || session.status !== "running") return;

  try {
    const info = await session.page.evaluate(() => {
      const body = document.body.innerText || "";
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);

      // Look for wait-time related text
      const waitPatterns = /estimated|wait|more than|hour|minute|remaining|your turn|in line|queue|position/i;
      const waitLines = lines.filter((l) => waitPatterns.test(l));

      // Grab the most informative line (longest match, likely contains the time)
      const timePattern = /(\d+\s*(hour|minute|min|hr|second|sec)s?|more than\s*(an?\s+)?hour)/i;
      const timeLine = waitLines.find((l) => timePattern.test(l));

      return timeLine || waitLines[0] || null;
    });

    if (info && info !== session.waitInfo) {
      session.waitInfo = info;
      log(`${session.name}: ${info}`);
      broadcast({ type: "update", session: sessionJson(session) });
    }
  } catch (_) {
    /* page may have navigated or closed */
  }
}

// ── Cookie verification ──────────────────────────────────────────────
async function verifyCookies(session) {
  if (!session.context || session.status !== "running") return;

  try {
    const cookies = await session.context.cookies();
    if (!cookies.length) return;

    // Look for queue-specific cookies first, then fall back to any unique ID
    const queueCookie = cookies.find(
      (c) =>
        /queue/i.test(c.name) ||
        /session/i.test(c.name) ||
        /QueueITAccepted/i.test(c.name) ||
        /BNI/i.test(c.name) ||
        /visitor/i.test(c.name) ||
        /uid/i.test(c.name)
    );

    // Build a fingerprint from all cookie values as fallback
    const fingerprint = cookies
      .map((c) => `${c.name}=${c.value}`)
      .sort()
      .join("|");

    const cookieId = queueCookie
      ? `${queueCookie.name}=${queueCookie.value.slice(0, 16)}...`
      : `fp:${simpleHash(fingerprint)}`;

    // Check uniqueness against other sessions
    const otherIds = sessions
      .filter((s) => s.id !== session.id && s.cookieId)
      .map((s) => s.cookieId);

    const isUnique = !otherIds.includes(cookieId);

    if (cookieId !== session.cookieId || session.verified !== isUnique) {
      session.cookieId = cookieId;
      session.verified = isUnique;
      if (isUnique) {
        log(`${session.name}: Verified — unique cookie identity`);
      } else {
        log(`${session.name}: WARNING — duplicate cookie identity detected`);
      }
      broadcast({ type: "update", session: sessionJson(session) });
    }
  } catch (_) {
    /* context may have closed */
  }
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

function startPolling(session) {
  // Run once immediately after a short delay (let page settle)
  setTimeout(() => {
    pollPageStatus(session);
    verifyCookies(session);
  }, 5000);

  session.pollTimer = setInterval(() => {
    pollPageStatus(session);
    verifyCookies(session);
  }, POLL_INTERVAL_MS);
}

function stopPolling(session) {
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
}

// ── Browser management ───────────────────────────────────────────────
async function launchSession() {
  const id = nextId++;
  const name = `queue${id}`;
  const userDataDir = path.join(SESSION_DIR, name);
  fs.mkdirSync(userDataDir, { recursive: true });
  removeSingletonLock(userDataDir);

  const x = OFFSET_X * ((id - 1) % 10);
  const y = OFFSET_Y * ((id - 1) % 10);

  const session = {
    id,
    name,
    context: null,
    page: null,
    status: "launching",
    waitInfo: null,
    verified: false,
    cookieId: null,
    pollTimer: null,
  };
  sessions.push(session);
  broadcast({ type: "update", session: sessionJson(session) });

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--window-size=${WIN_WIDTH},${WIN_HEIGHT}`,
        `--window-position=${x},${y}`,
      ],
      viewport: null,
    });

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.targetUrl).catch(() => {});

    session.context = context;
    session.page = page;
    session.status = "running";
    log(`Launched ${name} — window at (${x}, ${y})`);

    startPolling(session);

    context.on("close", () => {
      stopPolling(session);
      session.status = "stopped";
      session.context = null;
      session.page = null;
      log(`${name} closed.`);
      removeSession(session);
    });
  } catch (err) {
    session.status = "error";
    log(`Failed to launch ${name}: ${err.message}`);
  }

  broadcast({ type: "update", session: sessionJson(session) });
  return session;
}

function removeSession(session) {
  stopPolling(session);
  const idx = sessions.indexOf(session);
  if (idx !== -1) sessions.splice(idx, 1);
  broadcast({ type: "remove", id: session.id });
}

async function closeSession(id) {
  const session = sessions.find((s) => s.id === id);
  if (!session) return null;
  stopPolling(session);
  if (session.context) {
    await session.context.close().catch(() => {});
  }
  // context "close" event handler will call removeSession
  // but if close() failed or context was already null, clean up here
  if (sessions.includes(session)) {
    session.status = "stopped";
    session.context = null;
    session.page = null;
    removeSession(session);
  }
  return session;
}

async function closeAll() {
  const running = [...sessions].filter((s) => s.status === "running");
  for (const s of running) {
    await closeSession(s.id);
  }
}

// ── SSE endpoint ─────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  sseClients.push(res);
  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ── REST API ─────────────────────────────────────────────────────────
app.get("/api/sessions", (_req, res) => {
  res.json({ config, sessions: sessions.map(sessionJson) });
});

function normalizeUrl(url) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

app.post("/api/config", (req, res) => {
  if (req.body.targetUrl) config.targetUrl = normalizeUrl(req.body.targetUrl);
  if (req.body.browserCount)
    config.browserCount = parseInt(req.body.browserCount, 10);
  log(`Config updated — URL: ${config.targetUrl}  Count: ${config.browserCount}`);
  res.json({ config });
});

app.post("/api/sessions/launch", async (_req, res) => {
  const session = await launchSession();
  res.json(sessionJson(session));
});

app.post("/api/sessions/launch-all", async (_req, res) => {
  const count = config.browserCount;
  log(`Launching ${count} sessions...`);
  res.json({ message: `Launching ${count} sessions` });

  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const delay = Math.floor(Math.random() * 8 + 3) * 1000;
      log(`Waiting ${delay / 1000}s before next launch...`);
      await sleep(delay);
    }
    await launchSession();
  }
  log(`All ${count} sessions launched.`);
});

app.post("/api/sessions/close-all", async (_req, res) => {
  await closeAll();
  log("All sessions closed.");
  res.json({ message: "All sessions closed" });
});

app.post("/api/sessions/:id/close", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = await closeSession(id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(sessionJson(session));
});

app.post("/api/sessions/:id/focus", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.find((s) => s.id === id);
  if (!session || !session.page)
    return res.status(404).json({ error: "Session not found or not running" });

  try {
    await session.page.bringToFront();
    log(`Focused ${session.name}`);
    res.json({ id, focused: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/screenshot", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const session = sessions.find((s) => s.id === id);
  if (!session || !session.page)
    return res.status(404).json({ error: "Session not found or not running" });

  try {
    const buf = await session.page.screenshot({ type: "jpeg", quality: 60 });
    const base64 = buf.toString("base64");
    res.json({ id, screenshot: `data:image/jpeg;base64,${base64}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard HTML ───────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.type("html").send(/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shotgun</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Quicksand:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* ============================================================
     DISNEY AFTER DARK — NIGHTTIME SPECTACULAR
     Palette: Deep Space Navy, Cosmic Teal, Firework Magenta,
              Starlight Silver, Twilight Indigo, Sparkler Gold
     ============================================================ */

  :root {
    --space-navy: #0B0E2D;
    --cosmic-teal: #00CEC9;
    --firework-magenta: #E84393;
    --starlight-silver: #DFE6E9;
    --twilight-indigo: #2D3561;
    --sparkler-gold: #FDCB6E;
    --deep-void: #060820;
    --panel-bg: rgba(13, 17, 52, 0.72);
    --panel-border: rgba(0, 206, 201, 0.18);
    --text-primary: #DFE6E9;
    --text-secondary: rgba(223, 230, 233, 0.55);
    --text-muted: rgba(223, 230, 233, 0.35);

    /* Status */
    --status-running: #00CEC9;
    --status-launching: #FDCB6E;
    --status-stopped: rgba(223, 230, 233, 0.3);
    --status-error: #E84393;

    /* Spacing scale: 4px base */
    --sp-1: 4px;
    --sp-2: 8px;
    --sp-3: 12px;
    --sp-4: 16px;
    --sp-6: 24px;
    --sp-8: 32px;
    --sp-12: 48px;
    --sp-16: 64px;

    /* Radius */
    --r-sm: 6px;
    --r-md: 12px;
    --r-lg: 16px;

    /* Type scale (1.25x) */
    --fs-caption: 0.72rem;
    --fs-small: 0.8rem;
    --fs-body: 1rem;
    --fs-lg: 1.25rem;
    --fs-xl: 1.563rem;
    --fs-2xl: 1.953rem;
    --fs-3xl: 2.441rem;

    /* Easing */
    --ease-out: cubic-bezier(0.0, 0.0, 0.2, 1);
    --ease-in: cubic-bezier(0.4, 0.0, 1, 1);
    --ease-in-out: cubic-bezier(0.4, 0.0, 0.2, 1);
    --spring: cubic-bezier(0.68, -0.55, 0.265, 1.55);
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* ---- Reset ---- */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* ---- Star field background ---- */
  body {
    font-family: 'Quicksand', sans-serif;
    font-weight: 400;
    background: var(--deep-void);
    color: var(--text-primary);
    min-height: 100vh;
    overflow-x: hidden;
    position: relative;
    line-height: 1.5;
  }

  /* Layered night sky gradient */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 120% 60% at 50% 0%, rgba(45, 53, 97, 0.5) 0%, transparent 60%),
      radial-gradient(ellipse 80% 50% at 20% 80%, rgba(232, 67, 147, 0.08) 0%, transparent 50%),
      radial-gradient(ellipse 80% 50% at 80% 70%, rgba(0, 206, 201, 0.06) 0%, transparent 50%),
      linear-gradient(180deg, #080B28 0%, #0B0E2D 40%, #0D1035 100%);
    z-index: -3;
    pointer-events: none;
  }

  /* Star field canvas */
  #starfield {
    position: fixed;
    inset: 0;
    z-index: -2;
    pointer-events: none;
  }

  /* Castle silhouette skyline at bottom */
  .castle-skyline {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 120px;
    z-index: -1;
    pointer-events: none;
    opacity: 0.12;
  }

  /* ---- Title ---- */
  .page-title {
    text-align: center;
    padding: var(--sp-6) 0 var(--sp-2);
    position: relative;
  }
  .page-title h1 {
    font-family: 'Cinzel', serif;
    font-weight: 700;
    font-size: var(--fs-2xl);
    letter-spacing: 0.12em;
    color: var(--starlight-silver);
    text-transform: uppercase;
    position: relative;
    display: inline-block;
  }
  .page-title h1::after {
    content: '';
    position: absolute;
    bottom: -6px;
    left: 15%;
    width: 70%;
    height: 2px;
    background: linear-gradient(90deg, transparent, var(--cosmic-teal), var(--firework-magenta), var(--sparkler-gold), transparent);
    border-radius: 1px;
  }
  .page-title .subtitle {
    font-family: 'Quicksand', sans-serif;
    font-weight: 300;
    font-size: var(--fs-small);
    color: var(--text-secondary);
    letter-spacing: 0.25em;
    text-transform: uppercase;
    margin-top: var(--sp-3);
  }

  /* ---- Config bar ---- */
  .config-bar {
    display: flex;
    gap: var(--sp-3);
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    padding: var(--sp-4) var(--sp-6);
    background: var(--panel-bg);
    border-top: 1px solid var(--panel-border);
    border-bottom: 1px solid var(--panel-border);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .config-bar label {
    font-family: 'Cinzel', serif;
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .config-bar input[type=text],
  .config-bar input[type=number] {
    background: rgba(11, 14, 45, 0.7);
    border: 1px solid rgba(0, 206, 201, 0.2);
    color: var(--starlight-silver);
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-sm);
    font-family: 'Quicksand', sans-serif;
    font-size: var(--fs-small);
    font-weight: 500;
    transition: border-color 150ms var(--ease-out), box-shadow 150ms var(--ease-out);
    outline: none;
  }
  .config-bar input[type=text] { width: 380px; max-width: 60vw; }
  .config-bar input[type=number] { width: 64px; text-align: center; }
  .config-bar input:focus {
    border-color: var(--cosmic-teal);
    box-shadow: 0 0 0 2px rgba(0, 206, 201, 0.15), 0 0 20px rgba(0, 206, 201, 0.08);
  }

  /* ---- Buttons ---- */
  button {
    cursor: pointer;
    border: none;
    border-radius: var(--r-sm);
    padding: var(--sp-2) var(--sp-4);
    font-family: 'Quicksand', sans-serif;
    font-size: var(--fs-small);
    font-weight: 600;
    transition: all 150ms var(--ease-out);
    position: relative;
    overflow: hidden;
    outline: none;
    min-height: 36px;
  }
  button:focus-visible {
    outline: 2px solid var(--cosmic-teal);
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.3;
    cursor: default;
    pointer-events: none;
  }

  .btn-primary {
    background: linear-gradient(135deg, var(--cosmic-teal), #00b4b0);
    color: var(--space-navy);
    box-shadow: 0 2px 12px rgba(0, 206, 201, 0.25);
  }
  .btn-primary:hover:not(:disabled) {
    box-shadow: 0 4px 24px rgba(0, 206, 201, 0.45), 0 0 40px rgba(0, 206, 201, 0.15);
    transform: translateY(-1px);
  }

  .btn-success {
    background: linear-gradient(135deg, #00CEC9, var(--sparkler-gold));
    color: var(--space-navy);
    box-shadow: 0 2px 12px rgba(253, 203, 110, 0.2);
  }
  .btn-success:hover:not(:disabled) {
    box-shadow: 0 4px 24px rgba(253, 203, 110, 0.4), 0 0 40px rgba(253, 203, 110, 0.12);
    transform: translateY(-1px);
  }

  .btn-danger {
    background: linear-gradient(135deg, var(--firework-magenta), #c0392b);
    color: #fff;
    box-shadow: 0 2px 12px rgba(232, 67, 147, 0.2);
  }
  .btn-danger:hover:not(:disabled) {
    box-shadow: 0 4px 24px rgba(232, 67, 147, 0.4), 0 0 40px rgba(232, 67, 147, 0.12);
    transform: translateY(-1px);
  }

  .btn-info {
    background: linear-gradient(135deg, var(--twilight-indigo), #3d4a8a);
    color: var(--starlight-silver);
    border: 1px solid rgba(0, 206, 201, 0.2);
  }
  .btn-info:hover:not(:disabled) {
    border-color: var(--cosmic-teal);
    box-shadow: 0 4px 20px rgba(0, 206, 201, 0.2);
    transform: translateY(-1px);
  }

  .btn-focus {
    background: linear-gradient(135deg, var(--sparkler-gold), #e6b545);
    color: var(--space-navy);
    box-shadow: 0 2px 12px rgba(253, 203, 110, 0.2);
  }
  .btn-focus:hover:not(:disabled) {
    box-shadow: 0 4px 24px rgba(253, 203, 110, 0.4), 0 0 40px rgba(253, 203, 110, 0.12);
    transform: translateY(-1px);
  }

  .btn-sm {
    padding: var(--sp-1) var(--sp-3);
    font-size: var(--fs-caption);
    min-height: 32px;
  }

  /* Firework burst effect on click */
  button .burst {
    position: absolute;
    border-radius: 50%;
    transform: scale(0);
    animation: burst-expand 500ms var(--ease-out) forwards;
    pointer-events: none;
  }
  @keyframes burst-expand {
    0% { transform: scale(0); opacity: 0.5; }
    100% { transform: scale(4); opacity: 0; }
  }

  /* ---- Action bar ---- */
  .action-bar {
    display: flex;
    gap: var(--sp-3);
    justify-content: center;
    padding: var(--sp-4) var(--sp-6);
  }

  /* ---- Grid ---- */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
    gap: var(--sp-4);
    padding: var(--sp-4) var(--sp-6);
  }

  /* ---- Cards (lantern panels) ---- */
  .card {
    background: var(--panel-bg);
    border-radius: var(--r-md);
    padding: var(--sp-4);
    border: 1px solid var(--panel-border);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    transition: opacity 300ms var(--ease-out), transform 300ms var(--ease-out), box-shadow 300ms var(--ease-out);
    position: relative;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: card-enter 400ms var(--ease-out) both;
  }
  @keyframes card-enter {
    from {
      opacity: 0;
      transform: translateY(16px) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Glowing border pulse animation */
  .card::before {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: var(--r-md);
    padding: 1px;
    background: linear-gradient(135deg, rgba(0, 206, 201, 0.25), rgba(232, 67, 147, 0.15), rgba(253, 203, 110, 0.1));
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    pointer-events: none;
    animation: border-glow 4s ease-in-out infinite alternate;
  }
  @keyframes border-glow {
    0% { opacity: 0.4; }
    50% { opacity: 0.8; }
    100% { opacity: 0.4; }
  }

  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 40px rgba(0, 206, 201, 0.1), 0 0 60px rgba(232, 67, 147, 0.05);
  }
  .card.removing {
    opacity: 0;
    transform: translateY(-8px) scale(0.96);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--sp-2);
  }
  .card-title {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-width: 0;
  }
  .card-name {
    font-family: 'Cinzel', serif;
    font-weight: 600;
    font-size: var(--fs-body);
    color: var(--starlight-silver);
    letter-spacing: 0.03em;
  }
  .verified-badge {
    font-size: var(--fs-caption);
    color: var(--cosmic-teal);
    display: none;
    white-space: nowrap;
    text-shadow: 0 0 8px rgba(0, 206, 201, 0.5);
  }
  .verified-badge.show { display: inline; }

  .badge {
    padding: 3px var(--sp-2);
    border-radius: 10px;
    font-size: var(--fs-caption);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge-running {
    background: rgba(0, 206, 201, 0.15);
    color: var(--cosmic-teal);
    border: 1px solid rgba(0, 206, 201, 0.3);
    box-shadow: 0 0 12px rgba(0, 206, 201, 0.15);
  }
  .badge-launching {
    background: rgba(253, 203, 110, 0.15);
    color: var(--sparkler-gold);
    border: 1px solid rgba(253, 203, 110, 0.3);
    animation: pulse-gold 2s ease-in-out infinite;
  }
  @keyframes pulse-gold {
    0%, 100% { box-shadow: 0 0 8px rgba(253, 203, 110, 0.1); }
    50% { box-shadow: 0 0 20px rgba(253, 203, 110, 0.3); }
  }
  .badge-stopped {
    background: rgba(223, 230, 233, 0.06);
    color: var(--text-muted);
    border: 1px solid rgba(223, 230, 233, 0.1);
  }
  .badge-error {
    background: rgba(232, 67, 147, 0.15);
    color: var(--firework-magenta);
    border: 1px solid rgba(232, 67, 147, 0.3);
    box-shadow: 0 0 12px rgba(232, 67, 147, 0.15);
  }

  .wait-info {
    font-size: var(--fs-small);
    font-weight: 500;
    color: var(--sparkler-gold);
    min-height: 1.3em;
    text-shadow: 0 0 10px rgba(253, 203, 110, 0.2);
  }
  .cookie-id {
    font-size: 0.65rem;
    color: var(--text-muted);
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-actions {
    display: flex;
    gap: var(--sp-2);
    padding-top: var(--sp-1);
  }
  .card-screenshot {
    width: 100%;
    border-radius: var(--r-sm);
    margin-top: var(--sp-1);
    display: none;
    border: 1px solid var(--panel-border);
  }

  /* ---- Log section ---- */
  .log-section {
    padding: var(--sp-3) var(--sp-6) var(--sp-8);
  }
  .log-section h3 {
    font-family: 'Cinzel', serif;
    font-size: var(--fs-small);
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: var(--sp-2);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  #log {
    background: rgba(6, 8, 32, 0.8);
    border: 1px solid var(--panel-border);
    border-radius: var(--r-md);
    height: 180px;
    overflow-y: auto;
    padding: var(--sp-3) var(--sp-4);
    font-family: 'Cascadia Code', 'Fira Code', monospace;
    font-size: var(--fs-caption);
    line-height: 1.6;
    color: var(--cosmic-teal);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  #log div {
    white-space: pre-wrap;
    word-break: break-all;
    opacity: 0.85;
  }
  #log div:last-child {
    opacity: 1;
  }

  /* Log scrollbar */
  #log::-webkit-scrollbar { width: 6px; }
  #log::-webkit-scrollbar-track { background: transparent; }
  #log::-webkit-scrollbar-thumb {
    background: rgba(0, 206, 201, 0.2);
    border-radius: 3px;
  }
  #log::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 206, 201, 0.35);
  }

  /* ---- Empty state ---- */
  .empty-state {
    text-align: center;
    padding: var(--sp-12) var(--sp-6);
    color: var(--text-secondary);
    font-size: var(--fs-body);
    font-weight: 300;
    grid-column: 1 / -1;
    letter-spacing: 0.02em;
  }
  .empty-state::before {
    content: '';
    display: block;
    width: 48px;
    height: 48px;
    margin: 0 auto var(--sp-4);
    background: radial-gradient(circle, rgba(253, 203, 110, 0.3) 0%, transparent 70%);
    border-radius: 50%;
    animation: empty-pulse 3s ease-in-out infinite;
  }
  @keyframes empty-pulse {
    0%, 100% { transform: scale(1); opacity: 0.5; }
    50% { transform: scale(1.3); opacity: 0.9; }
  }

  /* ---- Firework particles (spawned on button click) ---- */
  .firework-particle {
    position: fixed;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    pointer-events: none;
    z-index: 9999;
    animation: firework-fly 700ms var(--ease-out) forwards;
  }
  @keyframes firework-fly {
    0% {
      transform: translate(0, 0) scale(1);
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  /* ---- Shooting star ---- */
  .shooting-star {
    position: fixed;
    width: 80px;
    height: 1px;
    background: linear-gradient(90deg, rgba(253, 203, 110, 0.8), transparent);
    pointer-events: none;
    z-index: -1;
    animation: shoot 1s linear forwards;
  }
  @keyframes shoot {
    0% { transform: translateX(0) translateY(0); opacity: 1; }
    100% { transform: translateX(200px) translateY(120px); opacity: 0; }
  }

  /* ---- Responsive ---- */
  @media (max-width: 767px) {
    .page-title h1 { font-size: var(--fs-xl); }
    .config-bar { padding: var(--sp-3) var(--sp-4); }
    .config-bar input[type=text] { width: 100%; }
    .grid { padding: var(--sp-3) var(--sp-4); gap: var(--sp-3); }
    .grid { grid-template-columns: 1fr; }
    .log-section { padding: var(--sp-3) var(--sp-4) var(--sp-6); }
  }
</style>
</head>
<body>

<!-- Star field canvas -->
<canvas id="starfield"></canvas>

<!-- Castle silhouette -->
<svg class="castle-skyline" viewBox="0 0 1440 120" preserveAspectRatio="none" fill="rgba(223, 230, 233, 0.7)" xmlns="http://www.w3.org/2000/svg">
  <path d="M0,120 L0,100 L40,100 L40,85 L50,85 L50,75 L55,60 L60,75 L60,85 L70,85 L70,100 L120,100 L120,90 L130,90 L130,80 L140,60 L145,45 L150,60 L160,80 L160,90 L170,90 L170,100 L230,100 L230,95 L240,95 L240,88 L250,88 L250,80 L255,70 L258,55 L260,40 L262,55 L265,70 L270,80 L270,88 L280,88 L280,95 L290,95 L290,100 L350,100 L350,92 L360,92 L360,100 L420,100 L420,90 L430,90 L435,75 L440,65 L445,55 L448,42 L450,30 L452,42 L455,55 L460,65 L465,75 L470,90 L480,90 L480,100 L540,100 L540,95 L550,95 L550,85 L555,70 L560,85 L560,95 L570,95 L570,100 L650,100 L650,88 L660,88 L665,72 L668,58 L670,45 L672,35 L674,22 L676,12 L678,22 L680,35 L682,45 L684,58 L687,72 L692,88 L700,88 L700,100 L760,100 L760,92 L770,92 L775,80 L780,92 L780,100 L840,100 L840,90 L850,90 L850,82 L855,70 L858,55 L860,42 L862,55 L865,70 L870,82 L870,90 L880,90 L880,100 L940,100 L940,95 L950,95 L950,100 L1010,100 L1010,88 L1020,88 L1025,75 L1028,60 L1030,50 L1032,60 L1035,75 L1040,88 L1050,88 L1050,100 L1110,100 L1110,95 L1120,95 L1120,85 L1125,72 L1130,85 L1130,95 L1140,95 L1140,100 L1200,100 L1200,92 L1210,92 L1210,80 L1215,68 L1218,55 L1220,45 L1222,55 L1225,68 L1230,80 L1230,92 L1240,92 L1240,100 L1300,100 L1300,95 L1310,95 L1310,88 L1315,78 L1320,88 L1320,95 L1330,95 L1330,100 L1380,100 L1380,90 L1390,90 L1390,82 L1395,72 L1400,82 L1400,90 L1410,90 L1410,100 L1440,100 L1440,120 Z" />
</svg>

<div class="page-title">
  <h1>Shotgun</h1>
  <div class="subtitle">Queue Manager Dashboard</div>
</div>

<div class="config-bar">
  <label for="targetUrl">URL</label>
  <input type="text" id="targetUrl" autocomplete="off">
  <label for="browserCount">Count</label>
  <input type="number" id="browserCount" min="1" max="20">
  <button class="btn-primary" onclick="saveConfig()">Save Config</button>
  <button class="btn-success" onclick="launchAll()">Launch All</button>
</div>

<div class="action-bar">
  <button class="btn-info" onclick="launchOne()">Launch One More</button>
  <button class="btn-danger" onclick="closeAll()">Close All</button>
</div>

<div class="grid" id="grid">
  <div class="empty-state" id="emptyState">No sessions yet. Configure URL and click Launch All.</div>
</div>

<div class="log-section">
  <h3>Event Log</h3>
  <div id="log"></div>
</div>

<script>
/* ============================================================
   STAR FIELD — twinkling stars on canvas
   ============================================================ */
(function initStarfield() {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  const STAR_COUNT = 220;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.5 + 0.3,
      alpha: Math.random() * 0.6 + 0.2,
      twinkleSpeed: Math.random() * 0.015 + 0.005,
      twinkleOffset: Math.random() * Math.PI * 2,
      hue: Math.random() > 0.85 ? (Math.random() > 0.5 ? 180 : 340) : 0,
      saturation: Math.random() > 0.85 ? 60 : 0,
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const twinkle = Math.sin(t * s.twinkleSpeed + s.twinkleOffset);
      const a = s.alpha + twinkle * 0.25;
      if (s.hue) {
        ctx.fillStyle = 'hsla(' + s.hue + ', ' + s.saturation + '%, 85%, ' + Math.max(0.05, a) + ')';
      } else {
        ctx.fillStyle = 'rgba(223, 230, 233, ' + Math.max(0.05, a) + ')';
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // Occasional shooting star
  function spawnShootingStar() {
    const el = document.createElement('div');
    el.className = 'shooting-star';
    el.style.top = (Math.random() * 40) + '%';
    el.style.left = (Math.random() * 70) + '%';
    el.style.transform = 'rotate(' + (25 + Math.random() * 15) + 'deg)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1100);
    setTimeout(spawnShootingStar, 6000 + Math.random() * 12000);
  }
  setTimeout(spawnShootingStar, 3000 + Math.random() * 5000);
})();

/* ============================================================
   FIREWORK BURST on button click
   ============================================================ */
document.addEventListener('click', function(e) {
  const btn = e.target.closest('button');
  if (!btn || btn.disabled) return;

  // Ripple burst inside button
  const rect = btn.getBoundingClientRect();
  const burst = document.createElement('span');
  burst.className = 'burst';
  const size = Math.max(rect.width, rect.height);
  burst.style.width = burst.style.height = size + 'px';
  burst.style.left = (e.clientX - rect.left - size / 2) + 'px';
  burst.style.top = (e.clientY - rect.top - size / 2) + 'px';

  const colors = ['rgba(0,206,201,0.3)', 'rgba(232,67,147,0.3)', 'rgba(253,203,110,0.3)'];
  burst.style.background = colors[Math.floor(Math.random() * colors.length)];
  btn.appendChild(burst);
  setTimeout(() => burst.remove(), 500);

  // Spawn small firework particles
  const particleCount = 8;
  const cx = e.clientX, cy = e.clientY;
  const particleColors = ['#00CEC9', '#E84393', '#FDCB6E', '#DFE6E9'];
  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('div');
    p.className = 'firework-particle';
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.background = particleColors[Math.floor(Math.random() * particleColors.length)];
    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.5;
    const dist = 30 + Math.random() * 40;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    p.style.animation = 'none';
    document.body.appendChild(p);
    p.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(0.2)', opacity: 0 }
    ], { duration: 600, easing: 'cubic-bezier(0.0, 0.0, 0.2, 1)', fill: 'forwards' });
    setTimeout(() => p.remove(), 650);
  }
});

/* ============================================================
   DASHBOARD LOGIC — identical API surface to original
   ============================================================ */
const grid = document.getElementById('grid');
const logEl = document.getElementById('log');
const emptyState = document.getElementById('emptyState');
const sessionsMap = {};

fetch('/api/sessions').then(r => r.json()).then(data => {
  document.getElementById('targetUrl').value = data.config.targetUrl;
  document.getElementById('browserCount').value = data.config.browserCount;
  data.sessions.forEach(s => upsertCard(s));
});

const evtSource = new EventSource('/api/events');
evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === 'log') appendLog(data.message);
  if (data.type === 'update') upsertCard(data.session);
  if (data.type === 'remove') removeCard(data.id);
};

function appendLog(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function badgeClass(status) {
  return 'badge badge-' + (status || 'stopped');
}

function upsertCard(s) {
  emptyState.style.display = 'none';
  if (sessionsMap[s.id]) {
    const card = sessionsMap[s.id];
    card.querySelector('.badge').className = badgeClass(s.status);
    card.querySelector('.badge').textContent = s.status;
    const btns = card.querySelectorAll('.card-actions button');
    const isRunning = s.status === 'running';
    btns[0].disabled = !isRunning;
    btns[1].disabled = !isRunning;
    btns[2].disabled = !isRunning;
    const waitEl = card.querySelector('.wait-info');
    waitEl.textContent = s.waitInfo || '';
    const vb = card.querySelector('.verified-badge');
    vb.className = 'verified-badge' + (s.verified ? ' show' : '');
    const cid = card.querySelector('.cookie-id');
    cid.textContent = s.verified ? s.cookieId || '' : '';
    return;
  }
  const card = document.createElement('div');
  card.className = 'card';
  const isRunning = s.status === 'running';
  card.innerHTML =
    '<div class="card-header">' +
      '<div class="card-title">' +
        '<span class="card-name">' + esc(s.name) + '</span>' +
        '<span class="verified-badge' + (s.verified ? ' show' : '') + '" title="Unique session verified">&#10003; verified</span>' +
      '</div>' +
      '<span class="' + badgeClass(s.status) + '">' + esc(s.status) + '</span>' +
    '</div>' +
    '<div class="wait-info">' + esc(s.waitInfo || '') + '</div>' +
    '<div class="cookie-id">' + (s.verified ? esc(s.cookieId || '') : '') + '</div>' +
    '<div class="card-actions">' +
      '<button class="btn-focus btn-sm" onclick="focusOne(' + s.id + ')"' + (isRunning ? '' : ' disabled') + '>Focus</button>' +
      '<button class="btn-info btn-sm" onclick="takeScreenshot(' + s.id + ')"' + (isRunning ? '' : ' disabled') + '>Screenshot</button>' +
      '<button class="btn-danger btn-sm" onclick="closeOne(' + s.id + ')"' + (isRunning ? '' : ' disabled') + '>Close</button>' +
    '</div>' +
    '<img class="card-screenshot" id="ss-' + s.id + '">';
  sessionsMap[s.id] = card;
  grid.appendChild(card);
}

function removeCard(id) {
  const card = sessionsMap[id];
  if (!card) return;
  card.classList.add('removing');
  setTimeout(() => {
    card.remove();
    delete sessionsMap[id];
    if (Object.keys(sessionsMap).length === 0) {
      emptyState.style.display = '';
    }
  }, 300);
}

function esc(str) {
  const d = document.createElement('span');
  d.textContent = str;
  return d.innerHTML;
}

async function saveConfig() {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetUrl: document.getElementById('targetUrl').value,
      browserCount: document.getElementById('browserCount').value,
    }),
  });
}

async function launchAll() {
  await saveConfig();
  fetch('/api/sessions/launch-all', { method: 'POST' });
}

async function launchOne() {
  await saveConfig();
  fetch('/api/sessions/launch', { method: 'POST' });
}

function closeAll() { fetch('/api/sessions/close-all', { method: 'POST' }); }

function focusOne(id) { fetch('/api/sessions/' + id + '/focus', { method: 'POST' }); }

function closeOne(id) { fetch('/api/sessions/' + id + '/close', { method: 'POST' }); }

async function takeScreenshot(id) {
  const img = document.getElementById('ss-' + id);
  img.style.display = 'none';
  const r = await fetch('/api/sessions/' + id + '/screenshot', { method: 'POST' });
  if (!r.ok) return;
  const data = await r.json();
  img.src = data.screenshot;
  img.style.display = 'block';
}
</script>
</body>
</html>`);
});

// ── Startup ──────────────────────────────────────────────────────────
async function start() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  app.listen(PORT, () => {
    log(`Dashboard running at http://localhost:${PORT}`);

    const url = `http://localhost:${PORT}`;
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, () => {});
  });
}

// ── Graceful shutdown ────────────────────────────────────────────────
async function shutdown() {
  log("Shutting down — closing all browser sessions...");
  await closeAll();
  log("All sessions closed. Exiting.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
