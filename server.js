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

function getMockScreenshot(id, phaseCls) {
  const width = 800;
  const height = 600;
  let bg = "#0B0E2D";
  let title = `Queue Session ${id}`;
  let detail = "Position in line: 12,450";
  let timeText = "Estimated wait: 45 minutes";
  
  if (phaseCls === "phase-registration") {
    bg = "#E84393";
    title = "Registration Open!";
    detail = "YOUR TURN HAS ARRIVED";
    timeText = "Click 'Register Now' to begin";
  } else if (phaseCls === "phase-queue") {
    bg = "#2D3561";
    title = "Queue-it Waiting Room";
    detail = "Event Registration Queue";
    timeText = "Expected wait: 15 minutes";
  } else if (phaseCls === "phase-waiting") {
    bg = "#060820";
    title = "Waiting Room";
    detail = "Queue starts soon";
    timeText = "Opens at 10:00 AM EST";
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="${bg}"/>
    <circle cx="400" cy="300" r="180" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="8"/>
    <text x="400" y="240" font-family="'Cinzel', serif" font-size="32" fill="#DFE6E9" text-anchor="middle" font-weight="bold">${title}</text>
    <text x="400" y="310" font-family="'Quicksand', sans-serif" font-size="24" fill="#FDCB6E" text-anchor="middle" font-weight="600">${detail}</text>
    <text x="400" y="370" font-family="'Quicksand', sans-serif" font-size="20" fill="#00CEC9" text-anchor="middle">${timeText}</text>
    <text x="400" y="520" font-family="monospace" font-size="14" fill="rgba(223,230,233,0.4)" text-anchor="middle">http://rundisney.com/queue-it/id_${id}</text>
  </svg>`;
  
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
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
    "Shift+Tab",
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

  if (!session.page) {
    log(`Tapped MOCK ${session.name} at (${x}, ${y})`);
    return res.json({ id, clicked: true, x, y });
  }

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

  if (!session.page) {
    log(`Sent text to MOCK ${session.name} (${text.length} chars)`);
    return res.json({ id, typed: true, length: text.length });
  }

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

  if (!session.page) {
    log(`Pressed MOCK ${key} in ${session.name}`);
    return res.json({ id, pressed: key });
  }

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

  if (!session.page) {
    log(`Scrolled MOCK ${session.name} by ${delta}px`);
    return res.json({ id, scrolled: true, delta });
  }

  try {
    await session.page.mouse.wheel(0, delta);
    log(`Scrolled ${session.name} by ${delta}px`);
    res.json({ id, scrolled: true, delta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sessions/mock", (req, res) => {
  const realSessions = sessions.filter(s => s.page);
  sessions.length = 0;
  sessions.push(...realSessions);

  const count = parseInt(req.body?.count || req.query.count, 10) || 12;
  const states = [
    { waitInfo: "Your turn! Click here to register.", status: "running", verified: true },
    { waitInfo: "Registration ready. Proceed to checkout.", status: "running", verified: true },
    { waitInfo: "Line position: 1,520. Expected wait: 12 minutes.", status: "running", verified: true },
    { waitInfo: "Estimated wait time: 45 minutes.", status: "running", verified: true },
    { waitInfo: "Estimated wait time: more than an hour.", status: "running", verified: false },
    { waitInfo: "Watching page...", status: "running", verified: false },
    { waitInfo: "Opening browser...", status: "launching", verified: false },
    { waitInfo: "", status: "stopped", verified: false },
  ];

  for (let i = 1; i <= count; i++) {
    const state = states[(i - 1) % states.length];
    const id = nextId++;
    sessions.push({
      id,
      name: `queue${id}`,
      context: null,
      page: null,
      status: state.status,
      waitInfo: state.waitInfo,
      verified: state.verified,
      cookieId: state.verified ? `QueueITAccepted-SD-cookieval_${id}` : null,
      pollTimer: null,
    });
  }

  log(`Generated ${count} mock sessions in memory.`);
  broadcast({ type: "reload" });
  res.json({ success: true, count, sessions: sessions.map(sessionJson) });
});

// ── Dashboard HTML ───────────────────────────────────────────────────
app.get("/", (_req, res) => {
  // Always revalidate so dashboard edits show immediately (no stale phone cache).
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
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
