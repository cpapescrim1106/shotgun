const express = require("express");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const os = require("os");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const DEFAULT_TARGET_URL =
  "https://rundisney.com/";
const DEFAULT_BROWSER_COUNT = 5;
const MAX_BROWSER_COUNT = 20;
const DEFAULT_MAGICDNS_HOST = "iris.taila6f62d.ts.net";

const PORT = parsePort(process.env.PORT, 3737);
const HOST = process.env.HOST || "0.0.0.0";
const MAGICDNS_HOST = process.env.SHOTGUN_MAGICDNS_HOST || DEFAULT_MAGICDNS_HOST;
const SESSION_DIR = path.join(__dirname, ".sessions");
const TOKEN_FILE = path.join(__dirname, ".shotgun-token");
const ACCESS_TOKEN = getAccessToken();

// ── In-memory state ──────────────────────────────────────────────────
let config = {
  targetUrl: normalizeUrl(process.env.TARGET_URL || DEFAULT_TARGET_URL),
  browserCount: parseBrowserCount(process.env.BROWSER_COUNT, DEFAULT_BROWSER_COUNT),
};

const OFFSET_X = 150;
const OFFSET_Y = 80;
const WIN_WIDTH = 800;
const WIN_HEIGHT = 600;
const POLL_INTERVAL_MS = 60_000;

let nextId = 1;
const sessions = []; // { id, name, context, page, status, waitInfo, verified, cookieId, pollTimer }
const sseClients = [];
const logLines = [];

// ── Helpers ──────────────────────────────────────────────────────────
function parsePort(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getAccessToken() {
  const envToken = process.env.SHOTGUN_ACCESS_TOKEN || process.env.SHOTGUN_TOKEN;
  if (envToken) return envToken;

  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  } catch (_) {
    /* create below */
  }

  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

function requireAccessToken(req, res, next) {
  const token = req.get("X-Shotgun-Token") || req.query.token;
  if (token === ACCESS_TOKEN) return next();
  res.status(401).json({ error: "Access token required" });
}

function normalizeRemoteAddress(address) {
  return String(address || "")
    .replace(/^::ffff:/, "")
    .replace(/^::1$/, "127.0.0.1");
}

function isPrivateShortcutAddress(address) {
  const ip = normalizeRemoteAddress(address);
  if (ip === "127.0.0.1" || ip === "localhost") return true;

  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;

  // Tailscale uses 100.64.0.0/10.
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function parseBrowserCount(value, fallback = DEFAULT_BROWSER_COUNT) {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_BROWSER_COUNT);
}

function ts() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
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

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function summarizeQueueStatus(raw) {
  if (!raw) {
    return {
      state: "unknown",
      summary: "No queue status could be read.",
    };
  }

  const state =
    raw.pageId === "before" || /prequeue/i.test(raw.pageClass || "")
      ? "pre-queue"
      : raw.pageId === "queue" || /queue/i.test(raw.pageClass || "")
        ? "in queue"
        : raw.pageId || "unknown";

  const parts = [];
  if (state === "pre-queue") parts.push("Still in the pre-queue.");
  else if (state === "in queue") parts.push("You are in the queue.");
  else parts.push(`Queue state: ${state}.`);

  if (raw.eventStartTimeFormatted) {
    parts.push(`Event begins at ${raw.eventStartTimeFormatted}.`);
  }
  if (Number.isFinite(raw.secondsToStart) && raw.secondsToStart > 0) {
    parts.push(`About ${formatDuration(raw.secondsToStart)} left.`);
  }
  if (raw.messageText) {
    const updated = raw.messageTimestampFormatted
      ? ` Message last updated ${raw.messageTimestampFormatted}.`
      : "";
    parts.push(`${raw.messageText}${updated}`);
  }
  if (raw.lastUpdated) {
    parts.push(`Status checked by Queue-it at ${raw.lastUpdated}.`);
  }

  return {
    state,
    summary: parts.join(" "),
  };
}

async function readQueueStatusFromSession(session) {
  if (!session.page || session.status !== "running") return null;

  const raw = await session.page.evaluate(() => {
    const text = (selector) =>
      document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || null;
    const bodyClass = document.body?.className || "";
    const pageId = document.body?.dataset?.pageid || null;
    const ticket =
      window.queueViewModel && typeof window.queueViewModel.ticket === "object"
        ? window.queueViewModel.ticket
        : null;
    const message =
      window.queueViewModel && typeof window.queueViewModel.message === "function"
        ? window.queueViewModel.message()
        : null;

    const observableValue = (obj, key) => {
      if (!obj || !(key in obj)) return null;
      const value = obj[key];
      return typeof value === "function" ? value() : value;
    };

    const seconds = Number(observableValue(ticket, "secondsToStart"));

    return {
      url: window.location.href,
      title: document.title,
      pageId,
      pageClass: bodyClass,
      eventStartTimeFormatted:
        observableValue(ticket, "eventStartTimeFormatted") ||
        text("#MainPart_lbEventStartTime"),
      eventStartTimeUTC: observableValue(ticket, "eventStartTimeUTC"),
      secondsToStart: Number.isFinite(seconds) ? seconds : null,
      lastUpdated:
        observableValue(ticket, "lastUpdated") ||
        text("#MainPart_lbLastUpdateTimeText"),
      messageText:
        (message && message.text) ||
        text("#MainPart_pMessageOnQueueTicket"),
      messageTimestampFormatted:
        (message && message.timestampFormatted) ||
        text("#MainPart_h2MessageOnQueueTicketTimeText"),
      forecastStatus:
        window.queueViewModel && typeof window.queueViewModel.forecastStatus === "function"
          ? window.queueViewModel.forecastStatus()
          : null,
    };
  });

  return {
    session: sessionJson(session),
    checkedAt: new Date().toISOString(),
    ...raw,
    ...summarizeQueueStatus(raw),
  };
}

function removeSingletonLocks(dir) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch (_) {
      /* ignore */
    }
  }
}

function getSessionById(id) {
  const session = sessions.find((s) => s.id === id);
  if (!session || !session.page)
    return { error: "Session not found or not running", session: null };
  return { error: null, session };
}

function getNetworkUrls(port, host, token) {
  const urls = [{ label: "Local", url: `http://localhost:${port}/?token=${token}` }];
  const seen = new Set(["127.0.0.1"]);

  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || seen.has(entry.address)) continue;
      seen.add(entry.address);
      const isTailscale = entry.address.startsWith("100.") || /tailscale|utun|ts/i.test(name);
      urls.push({
        label: isTailscale ? "Tailscale" : "LAN/WiFi",
        url: `http://${entry.address}:${port}/?token=${token}`,
      });
    }
  }

  if (host && host !== "0.0.0.0" && host !== "127.0.0.1" && host !== "localhost") {
    urls.push({ label: "Host", url: `http://${host}:${port}/?token=${token}` });
  }

  return urls;
}

function getShortcutUrls(port, host, magicDnsHost = MAGICDNS_HOST) {
  const urls = [];
  if (magicDnsHost) {
    urls.push({
      label: "MagicDNS shortcut",
      url: `http://${magicDnsHost}:${port}/iphone`,
    });
  }

  return urls.concat(getNetworkUrls(port, host, "TOKEN")
    .filter((item) => item.label === "Local" || item.label === "Tailscale")
    .map((item) => ({
      label: `${item.label} shortcut`,
      url: item.url.replace("/?token=TOKEN", "/iphone"),
    })));
}

function clampCoordinate(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(5000, Math.round(num)));
}

function parseScrollDelta(body) {
  if (Number.isFinite(Number(body.delta))) {
    return Math.max(-1200, Math.min(1200, Number(body.delta)));
  }
  return body.direction === "up" ? -420 : 420;
}

function safeKey(key) {
  const allowed = new Set([
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Space",
  ]);
  return allowed.has(key) ? key : null;
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
  removeSingletonLocks(userDataDir);

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
    const launchOptions = {
      headless: false,
      channel: process.env.BROWSER_CHANNEL || "chrome",
      args: [
        `--window-size=${WIN_WIDTH},${WIN_HEIGHT}`,
        `--window-position=${x},${y}`,
        "--disable-session-crashed-bubble",
      ],
      viewport: null,
    };
    let context;
    try {
      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    } catch (err) {
      if (!launchOptions.channel) throw err;
      log(`${name}: Chrome channel launch failed (${err.message}). Retrying with bundled Chromium.`);
      delete launchOptions.channel;
      context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    }

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
app.get("/iphone", (req, res) => {
  if (!isPrivateShortcutAddress(req.ip)) {
    return res.status(403).type("text").send("Shortcut is only available from localhost or Tailscale.");
  }
  res.redirect(302, `/?token=${encodeURIComponent(ACCESS_TOKEN)}`);
});

app.use("/api", requireAccessToken);

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
  res.json({ config, sessions: sessions.map(sessionJson), logLines });
});

app.get("/api/queue-status", async (_req, res) => {
  const running = sessions.filter((s) => s.status === "running" && s.page);
  if (!running.length) {
    return res.status(404).json({
      error: "No running browser sessions to inspect.",
      summary: "No running browser sessions to inspect. Launch sessions first.",
    });
  }

  try {
    const queueSession =
      running.find((s) => /queue|registration|rundisney/i.test(s.page.url())) || running[0];
    const status = await readQueueStatusFromSession(queueSession);
    res.json(status);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      summary: "Could not read the current queue status from the browser page.",
    });
  }
});

function normalizeUrl(url) {
  url = String(url || "").trim();
  if (!url) return DEFAULT_TARGET_URL;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

app.post("/api/config", (req, res) => {
  if (req.body.targetUrl) config.targetUrl = normalizeUrl(req.body.targetUrl);
  if (req.body.browserCount)
    config.browserCount = parseBrowserCount(req.body.browserCount, config.browserCount);
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
  const { error, session } = getSessionById(id);
  if (error) return res.status(404).json({ error });

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
  const { error, session } = getSessionById(id);
  if (error) return res.status(404).json({ error });

  try {
    const viewport = await session.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      url: window.location.href,
      title: document.title,
    }));
    const buf = await session.page.screenshot({ type: "jpeg", quality: 60 });
    const base64 = buf.toString("base64");
    res.json({ id, screenshot: `data:image/jpeg;base64,${base64}`, viewport });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/click", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error, session } = getSessionById(id);
  if (error) return res.status(404).json({ error });

  const x = clampCoordinate(req.body.x);
  const y = clampCoordinate(req.body.y);
  if (x === null || y === null) return res.status(400).json({ error: "Valid x and y are required" });

  try {
    await session.page.mouse.click(x, y);
    log(`Tapped ${session.name} at (${x}, ${y})`);
    res.json({ id, clicked: true, x, y });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/type", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error, session } = getSessionById(id);
  if (error) return res.status(404).json({ error });

  const text = String(req.body.text || "");
  if (!text || text.length > 500)
    return res.status(400).json({ error: "Text is required and must be 500 characters or fewer" });

  try {
    await session.page.keyboard.insertText(text);
    log(`Sent text to ${session.name} (${text.length} chars)`);
    res.json({ id, typed: true, length: text.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/press", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error, session } = getSessionById(id);
  if (error) return res.status(404).json({ error });

  const key = safeKey(String(req.body.key || ""));
  if (!key) return res.status(400).json({ error: "Unsupported key" });

  try {
    await session.page.keyboard.press(key);
    log(`Pressed ${key} in ${session.name}`);
    res.json({ id, pressed: key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/:id/scroll", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error, session } = getSessionById(id);
  if (error) return res.status(404).json({ error });

  const delta = parseScrollDelta(req.body || {});

  try {
    await session.page.mouse.wheel(0, delta);
    log(`Scrolled ${session.name} by ${delta}px`);
    res.json({ id, scrolled: true, delta });
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
  .access-banner {
    display: none;
    max-width: 920px;
    margin: var(--sp-3) auto 0;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid rgba(253, 203, 110, 0.35);
    border-radius: var(--r-sm);
    background: rgba(253, 203, 110, 0.08);
    color: var(--sparkler-gold);
    font-size: var(--fs-small);
  }
  .access-banner.show { display: block; }
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
    flex-wrap: wrap;
    padding: var(--sp-4) var(--sp-6);
  }

  .help-button {
    position: fixed;
    top: var(--sp-4);
    right: var(--sp-4);
    z-index: 20;
    width: 38px;
    height: 38px;
    min-height: 38px;
    padding: 0;
    border-radius: 50%;
    background: rgba(13, 17, 52, 0.86);
    color: var(--sparkler-gold);
    border: 1px solid rgba(253, 203, 110, 0.35);
    font-family: 'Cinzel', serif;
    font-size: var(--fs-lg);
    box-shadow: 0 4px 22px rgba(0, 0, 0, 0.22);
  }

  .queue-status {
    margin: 0 auto var(--sp-2);
    max-width: 920px;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--panel-border);
    border-radius: var(--r-md);
    background: rgba(13, 17, 52, 0.7);
    color: var(--starlight-silver);
    font-size: var(--fs-small);
    line-height: 1.45;
    display: none;
  }
  .queue-status.show { display: block; }
  .queue-status strong {
    color: var(--sparkler-gold);
    font-family: 'Cinzel', serif;
    letter-spacing: 0.04em;
  }
  .queue-status .status-meta {
    color: var(--text-secondary);
    margin-top: var(--sp-1);
    font-size: var(--fs-caption);
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgba(6, 8, 32, 0.78);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: none;
    align-items: center;
    justify-content: center;
    padding: var(--sp-4);
  }
  .modal-backdrop.show { display: flex; }
  .help-modal {
    width: min(620px, 100%);
    max-height: 88vh;
    overflow-y: auto;
    background: rgba(13, 17, 52, 0.96);
    border: 1px solid var(--panel-border);
    border-radius: var(--r-md);
    padding: var(--sp-6);
    box-shadow: 0 18px 70px rgba(0, 0, 0, 0.45);
  }
  .help-modal header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-4);
  }
  .help-modal h2 {
    font-family: 'Cinzel', serif;
    font-size: var(--fs-lg);
    color: var(--starlight-silver);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .help-modal button {
    flex-shrink: 0;
  }
  .help-modal h3 {
    color: var(--sparkler-gold);
    font-size: var(--fs-small);
    margin: var(--sp-4) 0 var(--sp-2);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .help-modal p,
  .help-modal li {
    color: var(--text-primary);
    font-size: var(--fs-small);
    line-height: 1.55;
  }
  .help-modal ul {
    padding-left: var(--sp-4);
    display: grid;
    gap: var(--sp-2);
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
  .phase-line {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--text-secondary);
    font-size: var(--fs-caption);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .phase-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    box-shadow: 0 0 10px rgba(223, 230, 233, 0.12);
  }
  .phase-waiting .phase-dot {
    background: var(--sparkler-gold);
    box-shadow: 0 0 14px rgba(253, 203, 110, 0.36);
  }
  .phase-queue .phase-dot {
    background: var(--cosmic-teal);
    box-shadow: 0 0 14px rgba(0, 206, 201, 0.36);
  }
  .phase-registration .phase-dot {
    background: var(--firework-magenta);
    box-shadow: 0 0 14px rgba(232, 67, 147, 0.4);
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
    flex-wrap: wrap;
  }
  .card-screenshot {
    width: 100%;
    border-radius: var(--r-sm);
    margin-top: var(--sp-1);
    display: none;
    border: 1px solid var(--panel-border);
    aspect-ratio: 4 / 3;
    object-fit: contain;
    background: rgba(6, 8, 32, 0.8);
  }

  .controller-modal {
    width: min(980px, 100%);
    max-height: 94vh;
    overflow-y: auto;
    background: rgba(13, 17, 52, 0.97);
    border: 1px solid var(--panel-border);
    border-radius: var(--r-md);
    padding: var(--sp-4);
    box-shadow: 0 18px 70px rgba(0, 0, 0, 0.48);
  }
  .controller-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
  }
  .controller-title {
    min-width: 0;
  }
  .controller-title h2 {
    font-family: 'Cinzel', serif;
    font-size: var(--fs-lg);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .controller-title p {
    color: var(--text-secondary);
    font-size: var(--fs-caption);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 70vw;
  }
  .controller-stage {
    position: relative;
    width: 100%;
    background: rgba(6, 8, 32, 0.88);
    border: 1px solid var(--panel-border);
    border-radius: var(--r-sm);
    overflow: hidden;
    min-height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: none;
  }
  .controller-stage img {
    display: block;
    width: 100%;
    height: auto;
    max-height: 64vh;
    object-fit: contain;
    user-select: none;
    -webkit-user-select: none;
  }
  .tap-marker {
    position: absolute;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--sparkler-gold);
    transform: translate(-50%, -50%);
    pointer-events: none;
    animation: tap-marker 700ms var(--ease-out) forwards;
  }
  @keyframes tap-marker {
    from { opacity: 1; transform: translate(-50%, -50%) scale(0.6); }
    to { opacity: 0; transform: translate(-50%, -50%) scale(1.8); }
  }
  .controller-tools {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: var(--sp-2);
    margin-top: var(--sp-3);
  }
  .controller-progress {
    display: flex;
    gap: var(--sp-2);
    margin: var(--sp-2) 0 var(--sp-3);
  }
  .controller-progress span {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--panel-border);
    border-radius: var(--r-sm);
    padding: 6px var(--sp-2);
    color: var(--text-secondary);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-align: center;
    text-transform: uppercase;
  }
  .controller-progress span:first-child {
    border-color: rgba(253, 203, 110, 0.36);
    color: var(--sparkler-gold);
  }
  .controller-tools input {
    min-height: 44px;
    border-radius: var(--r-sm);
    border: 1px solid rgba(0, 206, 201, 0.24);
    background: rgba(6, 8, 32, 0.92);
    color: var(--starlight-silver);
    padding: 0 var(--sp-3);
    font: inherit;
    outline: none;
  }
  .controller-tools button,
  .controller-keys button {
    min-height: 44px;
  }
  .controller-keys {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }

  /* ---- Log section ---- */
  .log-section {
    padding: var(--sp-3) var(--sp-6) var(--sp-8);
  }
  .log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-2);
  }
  .log-section h3 {
    font-family: 'Cinzel', serif;
    font-size: var(--fs-small);
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .log-toggle {
    display: none;
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
  @media (min-width: 768px) and (max-width: 1180px) {
    .page-title {
      padding: var(--sp-4) var(--sp-12) var(--sp-2);
    }
    .page-title h1 {
      font-size: var(--fs-2xl);
    }
    .config-bar {
      display: grid;
      grid-template-columns: auto minmax(320px, 1fr) auto 82px auto auto;
      justify-content: stretch;
      padding: var(--sp-3) var(--sp-6);
    }
    .config-bar input[type=text] {
      width: 100%;
      max-width: none;
    }
    .config-bar button {
      min-height: 44px;
    }
    .action-bar {
      padding: var(--sp-3) var(--sp-6);
    }
    .action-bar button {
      min-height: 44px;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--sp-4);
      padding: var(--sp-4) var(--sp-6);
    }
    .card {
      padding: var(--sp-4);
      min-height: 0;
    }
    .card-actions {
      display: grid;
      grid-template-columns: 0.8fr 1fr 1fr 0.8fr;
    }
    .card-actions button {
      min-height: 44px;
      padding-inline: var(--sp-2);
    }
  }

  @media (max-width: 767px) {
    body { padding-bottom: env(safe-area-inset-bottom); }
    .page-title {
      padding: calc(var(--sp-2) + env(safe-area-inset-top)) 58px var(--sp-2) var(--sp-3);
      text-align: left;
    }
    .page-title h1 {
      font-size: 1.45rem;
      letter-spacing: 0.08em;
    }
    .page-title h1::after {
      left: 0;
      width: 160px;
      bottom: -4px;
    }
    .page-title .subtitle {
      margin-top: var(--sp-2);
      font-size: 0.58rem;
      letter-spacing: 0.14em;
    }
    .help-button {
      top: calc(var(--sp-2) + env(safe-area-inset-top));
      right: var(--sp-3);
      width: 44px;
      height: 44px;
      min-height: 44px;
    }
    .config-bar {
      position: sticky;
      top: 0;
      z-index: 15;
      display: grid;
      grid-template-columns: 52px 62px 1fr 1fr;
      padding: var(--sp-2) var(--sp-3);
      gap: var(--sp-2);
      align-items: center;
    }
    .config-bar label[for="targetUrl"] {
      display: none;
    }
    .config-bar input[type=text] {
      width: 100%;
      max-width: none;
      grid-column: 1 / -1;
      min-height: 42px;
      font-size: 0.95rem;
    }
    .config-bar label[for="browserCount"] {
      grid-column: 1;
      justify-self: start;
      letter-spacing: 0.08em;
    }
    .config-bar input[type=number] {
      grid-column: 2;
      width: 100%;
      min-height: 42px;
    }
    .config-bar button {
      min-height: 42px;
      padding-inline: var(--sp-2);
    }
    .config-bar .btn-primary {
      grid-column: 3;
    }
    .config-bar .btn-success {
      grid-column: 4;
    }
    .action-bar {
      position: sticky;
      top: 100px;
      z-index: 14;
      display: grid;
      grid-template-columns: 1fr 1fr 0.8fr;
      gap: var(--sp-2);
      padding: var(--sp-2) var(--sp-3);
      background: rgba(6, 8, 32, 0.86);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .action-bar button {
      min-height: 44px;
      padding-inline: var(--sp-2);
      font-size: 0.76rem;
    }
    .action-bar .btn-danger {
      grid-column: auto;
    }
    .queue-status,
    .access-banner { margin-inline: var(--sp-3); }
    .grid {
      padding: var(--sp-2) var(--sp-3) var(--sp-3);
      gap: var(--sp-2);
      grid-template-columns: 1fr;
    }
    .card {
      padding: var(--sp-3);
      gap: 6px;
      border-radius: var(--r-sm);
    }
    .card-name {
      font-size: 0.92rem;
    }
    .verified-badge {
      font-size: 0.68rem;
    }
    .badge {
      font-size: 0.66rem;
      padding: 2px 7px;
    }
    .wait-info {
      min-height: 1.1em;
      font-size: 0.78rem;
    }
    .phase-line {
      font-size: 0.62rem;
    }
    .cookie-id {
      font-size: 0.58rem;
    }
    .card-actions {
      display: grid;
      grid-template-columns: 0.9fr 1.1fr 1fr 0.9fr;
      gap: var(--sp-2);
    }
    .card-actions button {
      min-height: 42px;
      font-size: 0.76rem;
      padding-inline: 6px;
    }
    .card-actions .btn-primary {
      box-shadow: 0 2px 14px rgba(0, 206, 201, 0.32);
    }
    .log-section {
      padding: var(--sp-2) var(--sp-3) var(--sp-5);
    }
    .log-header {
      margin-bottom: 0;
    }
    .log-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 44px;
      background: rgba(13, 17, 52, 0.82);
      border: 1px solid var(--panel-border);
      color: var(--text-secondary);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .log-section h3 {
      display: none;
    }
    .log-section.collapsed #log {
      display: none;
    }
    #log {
      height: 128px;
      margin-top: var(--sp-2);
      padding: var(--sp-2) var(--sp-3);
      font-size: 0.66rem;
    }
    .modal-backdrop { padding: var(--sp-2); align-items: flex-start; }
    .help-modal,
    .controller-modal {
      width: 100%;
      max-height: calc(100vh - var(--sp-4));
      padding: var(--sp-3);
    }
    .controller-modal {
      min-height: calc(100dvh - var(--sp-4));
      display: flex;
      flex-direction: column;
    }
    .controller-header { align-items: flex-start; }
    .controller-title h2 { font-size: 1rem; }
    .controller-title p { max-width: 62vw; }
    .controller-progress {
      margin: 0 0 var(--sp-2);
    }
    .controller-stage {
      min-height: 260px;
      flex: 1;
    }
    .controller-stage img { max-height: calc(100dvh - 238px); }
    .controller-tools {
      grid-template-columns: 1fr 1fr;
    }
    .controller-tools input { grid-column: 1 / -1; }
    .controller-tools .send-text { grid-column: 1 / -1; }
    .controller-tools button { width: 100%; }
    .controller-keys {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
    }
  }

  @media (max-width: 767px) and (orientation: landscape) {
    .page-title {
      display: none;
    }
    .config-bar {
      grid-template-columns: minmax(260px, 1fr) 52px 112px 112px;
    }
    .config-bar input[type=text] {
      grid-column: 1;
    }
    .config-bar label[for="browserCount"] {
      display: none;
    }
    .config-bar input[type=number] {
      grid-column: 2;
    }
    .config-bar .btn-primary {
      grid-column: 3;
    }
    .config-bar .btn-success {
      grid-column: 4;
    }
    .action-bar {
      top: 60px;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .controller-stage img {
      max-height: calc(100dvh - 178px);
    }
  }
</style>
</head>
<body>

<button class="help-button" onclick="openHelp()" title="How to use Shotgun" aria-label="How to use Shotgun">?</button>

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

<div class="access-banner" id="accessBanner">
  Missing access token. Open the full private URL printed in the server log.
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
  <button class="btn-focus" onclick="checkQueueStatus()">Check Queue Code</button>
  <button class="btn-danger" onclick="closeAll()">Close All</button>
</div>

<div class="queue-status" id="queueStatus" aria-live="polite"></div>

<div class="grid" id="grid">
  <div class="empty-state" id="emptyState">No sessions yet. Configure URL and click Launch All.</div>
</div>

<div class="log-section collapsed" id="logSection">
  <div class="log-header">
    <h3>Event Log</h3>
    <button class="log-toggle" id="logToggle" onclick="toggleLog()">Show Event Log</button>
  </div>
  <div id="log"></div>
</div>

<div class="modal-backdrop" id="helpModal" onclick="closeHelp(event)">
  <div class="help-modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <header>
      <h2 id="helpTitle">How To Use Shotgun</h2>
      <button class="btn-info btn-sm" onclick="closeHelp()">Close</button>
    </header>

    <h3>Setup</h3>
    <ul>
      <li>Put the registration or runDisney URL in the URL field.</li>
      <li>Set Count to the number of browser windows you want.</li>
      <li>Click Launch All once. Each browser gets its own profile and queue identity.</li>
    </ul>

    <h3>During The Queue</h3>
    <ul>
      <li>Use Screenshot to refresh a card preview of that browser window.</li>
      <li>Use Focus to bring a specific browser window to the front.</li>
      <li>Use Control from your phone to tap, type, scroll, and press simple keys against a selected browser window.</li>
      <li>Use Check Queue Code to read the current Queue-it page state and event start time from one running session.</li>
    </ul>

    <h3>Mobile Access</h3>
    <ul>
      <li>Use the private Tailscale URL printed in the terminal when the app starts.</li>
      <li>The token in that URL is required before the dashboard APIs will respond.</li>
      <li>Keep Shotgun running on Iris because the actual browser windows still open on this computer.</li>
    </ul>

    <h3>Important</h3>
    <ul>
      <li>Operate registration pages manually.</li>
      <li>Do not refresh queue windows unless the page itself tells you to.</li>
      <li>Close shuts down one session. Close All shuts down every managed session.</li>
    </ul>
  </div>
</div>

<div class="modal-backdrop" id="controllerModal" onclick="closeController(event)">
  <div class="controller-modal" role="dialog" aria-modal="true" aria-labelledby="controllerTitle">
    <div class="controller-header">
      <div class="controller-title">
        <h2 id="controllerTitle">Controller</h2>
        <p id="controllerMeta">Tap the screenshot to click the browser window.</p>
      </div>
      <button class="btn-info btn-sm" onclick="closeController()">Close</button>
    </div>
    <div class="controller-progress" aria-label="Registration progress">
      <span>Waiting Room</span>
      <span>Queue</span>
      <span>Registration</span>
    </div>
    <div class="controller-stage" id="controllerStage">
      <img id="controllerImage" alt="Live browser screenshot">
    </div>
    <div class="controller-tools">
      <input id="controllerText" type="text" autocomplete="off" placeholder="Type text, then Send">
      <button class="btn-primary send-text" onclick="sendControllerText()">Send</button>
      <button class="btn-info" onclick="scrollController('up')">Up</button>
      <button class="btn-info" onclick="scrollController('down')">Down</button>
    </div>
    <div class="controller-keys">
      <button class="btn-info btn-sm" onclick="pressControllerKey('Enter')">Enter</button>
      <button class="btn-info btn-sm" onclick="pressControllerKey('Tab')">Tab</button>
      <button class="btn-info btn-sm" onclick="pressControllerKey('Backspace')">Backspace</button>
      <button class="btn-info btn-sm" onclick="pressControllerKey('Escape')">Esc</button>
      <button class="btn-info btn-sm" onclick="refreshController()">Refresh</button>
    </div>
  </div>
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
const queueStatusEl = document.getElementById('queueStatus');
const helpModal = document.getElementById('helpModal');
const controllerModal = document.getElementById('controllerModal');
const controllerImage = document.getElementById('controllerImage');
const controllerStage = document.getElementById('controllerStage');
const controllerText = document.getElementById('controllerText');
const controllerTitle = document.getElementById('controllerTitle');
const controllerMeta = document.getElementById('controllerMeta');
const accessBanner = document.getElementById('accessBanner');
const logSection = document.getElementById('logSection');
const logToggle = document.getElementById('logToggle');
const sessionsMap = {};
let activeControllerId = null;
let activeControllerViewport = null;
let controllerRefreshTimer = null;
let controllerPointerStart = null;
let suppressNextControllerClick = false;

const urlParams = new URLSearchParams(window.location.search);
const urlToken = urlParams.get('token');
if (urlToken) localStorage.setItem('shotgunToken', urlToken);
const shotgunToken = urlToken || localStorage.getItem('shotgunToken') || '';
if (!shotgunToken) accessBanner.classList.add('show');

function apiUrl(path) {
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(shotgunToken);
}

function apiFetch(path, options) {
  const opts = options || {};
  opts.headers = Object.assign({}, opts.headers || {}, { 'X-Shotgun-Token': shotgunToken });
  return fetch(apiUrl(path), opts);
}

apiFetch('/api/sessions').then(r => {
  if (!r.ok) {
    accessBanner.classList.add('show');
    return null;
  }
  return r.json();
}).then(data => {
  if (!data) return;
  document.getElementById('targetUrl').value = data.config.targetUrl;
  document.getElementById('browserCount').value = data.config.browserCount;
  (data.logLines || []).forEach(line => appendLog(line));
  data.sessions.forEach(s => upsertCard(s));
});

if (shotgunToken) {
  const evtSource = new EventSource(apiUrl('/api/events'));
  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'log') appendLog(data.message);
    if (data.type === 'update') upsertCard(data.session);
    if (data.type === 'remove') removeCard(data.id);
  };
}

function appendLog(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function toggleLog() {
  logSection.classList.toggle('collapsed');
  logToggle.textContent = logSection.classList.contains('collapsed') ? 'Show Event Log' : 'Hide Event Log';
}

function badgeClass(status) {
  return 'badge badge-' + (status || 'stopped');
}

function phaseInfo(s) {
  const text = String(s.waitInfo || '').toLowerCase();
  if (/register|registration|your turn|enter now|proceed|checkout/.test(text)) {
    return { label: 'Registration ready', cls: 'phase-registration' };
  }
  if (/estimated|wait|hour|minute|min|remaining|queue|line/.test(text)) {
    return { label: 'Queue active', cls: 'phase-queue' };
  }
  if (s.status === 'launching') return { label: 'Opening browser', cls: 'phase-waiting' };
  if (s.status === 'running') return { label: 'Watching page', cls: 'phase-waiting' };
  return { label: 'Stopped', cls: '' };
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
    btns[3].disabled = !isRunning;
    const waitEl = card.querySelector('.wait-info');
    waitEl.textContent = s.waitInfo || '';
    const phase = phaseInfo(s);
    const phaseEl = card.querySelector('.phase-line');
    phaseEl.className = 'phase-line ' + phase.cls;
    phaseEl.querySelector('.phase-label').textContent = phase.label;
    const vb = card.querySelector('.verified-badge');
    vb.className = 'verified-badge' + (s.verified ? ' show' : '');
    const cid = card.querySelector('.cookie-id');
    cid.textContent = s.verified ? s.cookieId || '' : '';
    return;
  }
  const card = document.createElement('div');
  card.className = 'card';
  const isRunning = s.status === 'running';
  const phase = phaseInfo(s);
  card.innerHTML =
    '<div class="card-header">' +
      '<div class="card-title">' +
        '<span class="card-name">' + esc(s.name) + '</span>' +
        '<span class="verified-badge' + (s.verified ? ' show' : '') + '" title="Unique session verified">&#10003; verified</span>' +
      '</div>' +
      '<span class="' + badgeClass(s.status) + '">' + esc(s.status) + '</span>' +
    '</div>' +
    '<div class="phase-line ' + phase.cls + '"><span class="phase-dot"></span><span class="phase-label">' + esc(phase.label) + '</span></div>' +
    '<div class="wait-info">' + esc(s.waitInfo || '') + '</div>' +
    '<div class="cookie-id">' + (s.verified ? esc(s.cookieId || '') : '') + '</div>' +
    '<div class="card-actions">' +
      '<button class="btn-focus btn-sm" onclick="focusOne(' + s.id + ')"' + (isRunning ? '' : ' disabled') + '>Focus</button>' +
      '<button class="btn-primary btn-sm" onclick="openController(' + s.id + ')"' + (isRunning ? '' : ' disabled') + '>Control</button>' +
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
  await apiFetch('/api/config', {
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
  apiFetch('/api/sessions/launch-all', { method: 'POST' });
}

async function launchOne() {
  await saveConfig();
  apiFetch('/api/sessions/launch', { method: 'POST' });
}

function closeAll() { apiFetch('/api/sessions/close-all', { method: 'POST' }); }

function focusOne(id) { apiFetch('/api/sessions/' + id + '/focus', { method: 'POST' }); }

function closeOne(id) { apiFetch('/api/sessions/' + id + '/close', { method: 'POST' }); }

function openHelp() {
  helpModal.classList.add('show');
}

function closeHelp(event) {
  if (event && event.target !== helpModal) return;
  helpModal.classList.remove('show');
}

function showQueueStatus(html) {
  queueStatusEl.innerHTML = html;
  queueStatusEl.classList.add('show');
}

async function checkQueueStatus() {
  showQueueStatus('<strong>Checking Queue-it code...</strong>');
  const r = await apiFetch('/api/queue-status');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    showQueueStatus('<strong>Could not check queue code.</strong> ' + esc(data.summary || data.error || 'No running session was available.'));
    return;
  }

  const meta = [];
  if (data.session && data.session.name) meta.push('Read from ' + data.session.name);
  if (data.checkedAt) meta.push('Checked ' + new Date(data.checkedAt).toLocaleTimeString());
  if (data.url) meta.push(data.url);

  showQueueStatus(
    '<strong>' + esc(data.state || 'Queue status') + '</strong> ' +
    esc(data.summary || '') +
    '<div class="status-meta">' + esc(meta.join(' | ')) + '</div>'
  );
}

async function takeScreenshot(id) {
  const img = document.getElementById('ss-' + id);
  img.style.display = 'none';
  const r = await apiFetch('/api/sessions/' + id + '/screenshot', { method: 'POST' });
  if (!r.ok) return;
  const data = await r.json();
  img.src = data.screenshot;
  img.style.display = 'block';
}

async function openController(id) {
  activeControllerId = id;
  activeControllerViewport = null;
  controllerTitle.textContent = 'Controller ' + id;
  controllerMeta.textContent = 'Loading screenshot...';
  controllerText.value = '';
  controllerModal.classList.add('show');
  await refreshController();
  clearInterval(controllerRefreshTimer);
  controllerRefreshTimer = setInterval(refreshController, 3000);
}

function closeController(event) {
  if (event && event.target !== controllerModal) return;
  controllerModal.classList.remove('show');
  clearInterval(controllerRefreshTimer);
  controllerRefreshTimer = null;
  activeControllerId = null;
  activeControllerViewport = null;
}

async function refreshController() {
  if (!activeControllerId) return;
  const r = await apiFetch('/api/sessions/' + activeControllerId + '/screenshot', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    controllerMeta.textContent = data.error || 'Could not refresh screenshot.';
    return;
  }
  activeControllerViewport = data.viewport || { width: 800, height: 600 };
  controllerImage.src = data.screenshot;
  const bits = [];
  if (activeControllerViewport.title) bits.push(activeControllerViewport.title);
  if (activeControllerViewport.url) bits.push(activeControllerViewport.url);
  controllerMeta.textContent = bits.join(' | ') || 'Tap the screenshot to click the browser window.';
}

controllerImage.addEventListener('pointerdown', function(e) {
  controllerPointerStart = {
    x: e.clientX,
    y: e.clientY,
    t: Date.now(),
  };
});

controllerImage.addEventListener('pointerup', async function(e) {
  if (!activeControllerId || !controllerPointerStart) return;
  const dx = e.clientX - controllerPointerStart.x;
  const dy = e.clientY - controllerPointerStart.y;
  controllerPointerStart = null;
  if (Math.abs(dy) > 34 && Math.abs(dy) > Math.abs(dx) * 1.2) {
    suppressNextControllerClick = true;
    await scrollController(dy > 0 ? 'up' : 'down');
    setTimeout(() => { suppressNextControllerClick = false; }, 350);
  }
});

controllerImage.addEventListener('click', async function(e) {
  if (!activeControllerId || !activeControllerViewport) return;
  if (suppressNextControllerClick) {
    suppressNextControllerClick = false;
    return;
  }
  const rect = controllerImage.getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;
  const x = Math.round(relX * activeControllerViewport.width);
  const y = Math.round(relY * activeControllerViewport.height);

  const marker = document.createElement('span');
  marker.className = 'tap-marker';
  marker.style.left = (e.clientX - controllerStage.getBoundingClientRect().left) + 'px';
  marker.style.top = (e.clientY - controllerStage.getBoundingClientRect().top) + 'px';
  controllerStage.appendChild(marker);
  setTimeout(() => marker.remove(), 750);

  await apiFetch('/api/sessions/' + activeControllerId + '/click', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y }),
  });
  setTimeout(refreshController, 500);
});

async function sendControllerText() {
  if (!activeControllerId) return;
  const text = controllerText.value;
  if (!text) return;
  controllerText.value = '';
  await apiFetch('/api/sessions/' + activeControllerId + '/type', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  setTimeout(refreshController, 500);
}

controllerText.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendControllerText();
  }
});

async function pressControllerKey(key) {
  if (!activeControllerId) return;
  await apiFetch('/api/sessions/' + activeControllerId + '/press', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  setTimeout(refreshController, 500);
}

async function scrollController(direction) {
  if (!activeControllerId) return;
  await apiFetch('/api/sessions/' + activeControllerId + '/scroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  setTimeout(refreshController, 500);
}
</script>
</body>
</html>`);
});

// ── Startup ──────────────────────────────────────────────────────────
async function start() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  app.listen(PORT, HOST, () => {
    const urls = getNetworkUrls(PORT, HOST, ACCESS_TOKEN);
    log(`Dashboard running on ${HOST}:${PORT}`);
    log("Private access URLs:");
    for (const item of urls) {
      log(`  ${item.label}: ${item.url}`);
    }
    log("Easy URLs:");
    for (const item of getShortcutUrls(PORT, HOST)) {
      log(`  ${item.label}: ${item.url}`);
    }

    if (process.env.SHOTGUN_NO_OPEN === "1") return;

    const url = `http://localhost:${PORT}/?token=${ACCESS_TOKEN}`;
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

if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  MAX_BROWSER_COUNT,
  clampCoordinate,
  formatDuration,
  getNetworkUrls,
  getShortcutUrls,
  isPrivateShortcutAddress,
  normalizeUrl,
  normalizeRemoteAddress,
  parseBrowserCount,
  parsePort,
  parseScrollDelta,
  removeSingletonLocks,
  safeKey,
  summarizeQueueStatus,
  simpleHash,
};
