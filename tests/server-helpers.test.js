const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
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
} = require("../server");

test("normalizeUrl keeps full URLs and adds https to bare hosts", () => {
  assert.equal(normalizeUrl("https://queue.example.com/a?b=c"), "https://queue.example.com/a?b=c");
  assert.equal(normalizeUrl("queue.example.com"), "https://queue.example.com");
});

test("parseBrowserCount rejects invalid counts and caps excessive counts", () => {
  assert.equal(parseBrowserCount("6"), 6);
  assert.equal(parseBrowserCount("0", 5), 5);
  assert.equal(parseBrowserCount("not-a-number", 5), 5);
  assert.equal(parseBrowserCount("999", 5), MAX_BROWSER_COUNT);
});

test("parsePort falls back for invalid ports", () => {
  assert.equal(parsePort("3738", 3737), 3738);
  assert.equal(parsePort("0", 3737), 3737);
  assert.equal(parsePort("oops", 3737), 3737);
});

test("getNetworkUrls includes localhost token URL", () => {
  const urls = getNetworkUrls(3737, "0.0.0.0", "abc123");
  assert.deepEqual(urls[0], {
    label: "Local",
    url: "http://localhost:3737/?token=abc123",
  });
});

test("getShortcutUrls prefers MagicDNS shortcut", () => {
  const urls = getShortcutUrls(3737, "0.0.0.0", "iris.taila6f62d.ts.net");
  assert.deepEqual(urls[0], {
    label: "MagicDNS shortcut",
    url: "http://iris.taila6f62d.ts.net:3737/iphone",
  });
});

test("private shortcut addresses allow localhost and Tailscale only", () => {
  assert.equal(normalizeRemoteAddress("::ffff:100.93.215.113"), "100.93.215.113");
  assert.equal(normalizeRemoteAddress("::1"), "127.0.0.1");
  assert.equal(isPrivateShortcutAddress("127.0.0.1"), true);
  assert.equal(isPrivateShortcutAddress("100.93.215.113"), true);
  assert.equal(isPrivateShortcutAddress("192.168.86.25"), false);
});

test("mobile control validators constrain input", () => {
  assert.equal(clampCoordinate("42.4"), 42);
  assert.equal(clampCoordinate("-5"), 0);
  assert.equal(clampCoordinate("999999"), 5000);
  assert.equal(clampCoordinate("nope"), null);

  assert.equal(parseScrollDelta({ direction: "up" }), -420);
  assert.equal(parseScrollDelta({ direction: "down" }), 420);
  assert.equal(parseScrollDelta({ delta: 9999 }), 1200);

  assert.equal(safeKey("Enter"), "Enter");
  assert.equal(safeKey("Meta+R"), null);
});

test("removeSingletonLocks removes stale Chromium singleton files only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shotgun-profile-"));
  const singletonNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
  for (const name of singletonNames) {
    fs.writeFileSync(path.join(dir, name), "stale");
  }
  fs.writeFileSync(path.join(dir, "Preferences"), "{}");

  removeSingletonLocks(dir);

  for (const name of singletonNames) {
    assert.equal(fs.existsSync(path.join(dir, name)), false);
  }
  assert.equal(fs.existsSync(path.join(dir, "Preferences")), true);
});

test("simpleHash is stable", () => {
  assert.equal(simpleHash("queue-cookie"), simpleHash("queue-cookie"));
  assert.notEqual(simpleHash("queue-cookie"), simpleHash("other-cookie"));
});

test("formatDuration produces compact human-readable durations", () => {
  assert.equal(formatDuration(0), "now");
  assert.equal(formatDuration(60), "1m");
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(3900), "1h 5m");
});

test("summarizeQueueStatus explains pre-queue state in normal language", () => {
  const result = summarizeQueueStatus({
    pageId: "before",
    pageClass: "before prequeue",
    eventStartTimeFormatted: "5:00 PM",
    secondsToStart: 3900,
    messageText: "Registration is delayed.",
    messageTimestampFormatted: "10:10 AM",
    lastUpdated: "11:00 AM",
  });

  assert.equal(result.state, "pre-queue");
  assert.match(result.summary, /Still in the pre-queue/);
  assert.match(result.summary, /Event begins at 5:00 PM/);
  assert.match(result.summary, /About 1h 5m left/);
  assert.match(result.summary, /Message last updated 10:10 AM/);
});
