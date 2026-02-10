const { chromium } = require("playwright");
const path = require("path");

const BROWSER_COUNT = parseInt(process.argv[2], 10) || 5;
const TARGET_URL = process.argv[3] || "https://queue.rundisney.com/";
const SESSION_DIR = path.join(__dirname, ".sessions");

// Cascade offset per window (pixels)
const OFFSET_X = 150;
const OFFSET_Y = 80;
const WIN_WIDTH = 800;
const WIN_HEIGHT = 600;

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z/, "");
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const browsers = [];
  const pages = [];

  async function cleanup() {
    log("Caught signal — closing all browser sessions...");
    for (const b of browsers) {
      await b.close().catch(() => {});
    }
    log("All sessions closed.");
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  for (let i = 1; i <= BROWSER_COUNT; i++) {
    const delay = Math.floor(Math.random() * 8 + 3) * 1000;
    log(`Waiting ${delay / 1000}s before launching session queue${i}...`);
    await sleep(delay);

    const userDataDir = path.join(SESSION_DIR, `queue${i}`);
    const x = OFFSET_X * (i - 1);
    const y = OFFSET_Y * (i - 1);

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--window-size=${WIN_WIDTH},${WIN_HEIGHT}`,
        `--window-position=${x},${y}`,
      ],
      viewport: null,
    });

    browsers.push(context);
    const page = context.pages()[0] || (await context.newPage());
    pages.push(page);
    await page.goto(TARGET_URL).catch(() => {});
    log(`Launched queue${i} — window at (${x}, ${y})`);
  }

  log(`All ${BROWSER_COUNT} sessions launched. Ctrl+C to close all.`);

  // Keep alive until all browser windows are manually closed or Ctrl+C
  await Promise.all(
    browsers.map(
      (b) => new Promise((resolve) => b.on("close", resolve))
    )
  );
  log("All browser windows closed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
