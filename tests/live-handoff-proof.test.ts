const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const proofPath = path.join(process.cwd(), 'docs', 'live-handoff-proof.md');

test('live handoff proof file exists', () => {
  assert.ok(fs.existsSync(proofPath), 'proof file should exist');
});

test("live handoff proof file states 'event-driven handoff works'", () => {
  const proof = fs.readFileSync(proofPath, 'utf8');
  assert.ok(proof.includes('event-driven handoff works'));
});
