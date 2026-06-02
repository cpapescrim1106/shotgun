const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const TEST_PORT = 3838;
const TEST_TOKEN = "test_visual_token_123456";
const SCREENSHOT_DIR = path.join(__dirname, "..", "docs", "screenshots");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("visual responsiveness and device screenshot generation", async () => {
  // 1. Ensure screenshot directory exists
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // 2. Start the Express server on a test port
  const serverProc = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      PORT: TEST_PORT.toString(),
      SHOTGUN_ACCESS_TOKEN: TEST_TOKEN,
      SHOTGUN_NO_OPEN: "1", // prevent browser from opening on the desktop
    },
  });

  let serverReady = false;
  serverProc.stdout.on("data", (data) => {
    const output = data.toString();
    if (output.includes("Dashboard running") || output.includes("running on")) {
      serverReady = true;
    }
  });

  serverProc.stderr.on("data", (data) => {
    console.error(`[Server Error] ${data}`);
  });

  // Wait up to 5 seconds for the server to be ready
  for (let i = 0; i < 50; i++) {
    if (serverReady) break;
    await sleep(100);
  }

  assert.ok(serverReady, "Server should start successfully on test port");

  // 3. Launch Playwright
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  try {
    // 4. Generate mock sessions via the API
    const mockRes = await context.request.post(`http://localhost:${TEST_PORT}/api/sessions/mock?count=15`, {
      headers: {
        "X-Shotgun-Token": TEST_TOKEN,
      },
    });
    const mockData = await mockRes.json();
    assert.equal(mockRes.ok(), true, "Mock sessions generation should succeed");
    assert.equal(mockData.count, 15, "Should have 15 mock sessions");

    // 5. Setup device profiles to test
    const devices = [
      { name: "iphone-portrait", width: 390, height: 844, isMobile: true, hasTouch: true },
      { name: "iphone-landscape", width: 844, height: 390, isMobile: true, hasTouch: true },
      { name: "ipad-portrait", width: 820, height: 1180, isMobile: true, hasTouch: true },
      { name: "ipad-landscape", width: 1180, height: 820, isMobile: true, hasTouch: true },
    ];

    for (const dev of devices) {
      console.log(`Testing viewport: ${dev.name} (${dev.width}x${dev.height})`);

      // Create page with specific viewport
      const page = await context.newPage();
      
      page.on("pageerror", (err) => {
        console.error(`[Browser Page Error] ${err.stack || err.toString()}`);
      });
      
      page.on("console", (msg) => {
        console.log(`[Browser Console] ${msg.text()}`);
      });

      await page.setViewportSize({ width: dev.width, height: dev.height });

      // Navigate to the dashboard with the test token
      const url = `http://localhost:${TEST_PORT}/?token=${TEST_TOKEN}`;
      await page.goto(url);

      // Wait for the grid to render mock cards
      await page.waitForSelector(".card");

      // Verify no horizontal overflow
      const overflow = await page.evaluate(() => {
        // Document width vs viewport width
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      assert.equal(overflow, false, `Horizontal overflow detected in Grid mode on ${dev.name}`);

      // Take Grid View screenshot
      const gridImgPath = path.join(SCREENSHOT_DIR, `${dev.name}-grid.png`);
      await page.screenshot({ path: gridImgPath, fullPage: false });
      console.log(`Saved screenshot: ${gridImgPath}`);

      // Switch to List View
      await page.click("#btnViewList");
      await sleep(300); // Wait for transition

      // Verify no horizontal overflow in List mode
      const overflowList = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      assert.equal(overflowList, false, `Horizontal overflow detected in List mode on ${dev.name}`);

      // Take List View screenshot
      const listImgPath = path.join(SCREENSHOT_DIR, `${dev.name}-list.png`);
      await page.screenshot({ path: listImgPath, fullPage: false });
      console.log(`Saved screenshot: ${listImgPath}`);

      await page.close();
    }
  } finally {
    // 6. Cleanup browser and server process
    await browser.close();
    serverProc.kill("SIGINT");
    await sleep(500); // Give process time to die
  }
});
