import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserSeedProfile, SandboxIsolationError, SeatbeltSandbox } from '../src/sandbox.ts';
import { seedBrowsersCopy } from '../src/seed.ts';

const skip = process.platform === 'darwin' ? false : 'APFS clones are macOS only';

/** A seed holding Playwright's browser layout, plus a scratch dir to clone into. */
function fixture(): { dir: string; seed: string; copy: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mfms-browsers-')));
  const seed = join(dir, 'seed');
  const browser = join(seed, 'browsers', 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64');
  mkdirSync(browser, { recursive: true });
  writeFileSync(join(browser, 'chrome-headless-shell'), 'browser bytes');
  return { dir, seed, copy: join(dir, 'session', '.browsers') };
}

test('browserSeedProfile: the two Mach rules and a write deny, nothing else', () => {
  const profile = browserSeedProfile('/sandboxes/session/.browsers');
  const rules = profile.split('\n').filter((l) => l.trim() && !l.trim().startsWith(';'));
  assert.deepEqual(rules, [
    '(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer"))',
    '(allow mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer"))',
    '(deny file-write* (subpath "/sandboxes/session/.browsers"))',
  ]);
  // No rule widens reads or writes anywhere else.
  for (const rule of rules) assert.match(rule, /^\((?:allow mach-(?:register|lookup)|deny file-write\*)/);
});

test('browserSeedProfile: quotes and backslashes in the path are escaped', () => {
  const profile = browserSeedProfile('/odd/"name"/back\\slash');
  assert.ok(profile.includes('(deny file-write* (subpath "/odd/\\"name\\"/back\\\\slash"))'));
});

test('seedBrowsersCopy clones the browsers tree once and keeps the session copy', { skip }, () => {
  const { dir, seed, copy } = fixture();
  try {
    assert.deepEqual(seedBrowsersCopy(seed, copy), { seeded: true });
    const cloned = join(copy, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    assert.equal(readFileSync(cloned, 'utf8'), 'browser bytes');

    // The copy is the session's: writing to it does not reach the seed.
    writeFileSync(cloned, 'session change');
    assert.equal(readFileSync(join(seed, 'browsers', 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), 'utf8'), 'browser bytes');

    writeFileSync(join(copy, 'session-only'), 'kept');
    assert.deepEqual(seedBrowsersCopy(seed, copy), { seeded: false, reason: 'already present' });
    assert.equal(readFileSync(join(copy, 'session-only'), 'utf8'), 'kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedBrowsersCopy: a missing seed is reported, then retried once it appears', { skip }, () => {
  const { dir, seed, copy } = fixture();
  try {
    rmSync(seed, { recursive: true, force: true });
    const first = seedBrowsersCopy(seed, copy);
    assert.equal(first.seeded, false);
    assert.match(first.reason ?? '', /unseeded: /);
    assert.ok(existsSync(copy), 'the session still gets an empty dir');

    mkdirSync(join(seed, 'browsers', 'chromium_headless_shell-1234'), { recursive: true });
    assert.deepEqual(seedBrowsersCopy(seed, copy), { seeded: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seedBrowsersCopy: a failed clone leaves no .partial and is retried', { skip }, () => {
  const { dir, seed, copy } = fixture();
  try {
    // A seed dir without `browsers/` makes the clone fail.
    rmSync(join(seed, 'browsers'), { recursive: true, force: true });
    const failed = seedBrowsersCopy(seed, copy);
    assert.equal(failed.seeded, false);
    assert.match(failed.reason ?? '', /unseeded: browsers: /);
    assert.ok(existsSync(copy));
    assert.equal(existsSync(`${copy}.partial`), false);

    mkdirSync(join(seed, 'browsers', 'chromium_headless_shell-1234'), { recursive: true });
    assert.deepEqual(seedBrowsersCopy(seed, copy), { seeded: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browserSeed validation mirrors pnpmSeed', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mfms-browsers-')));
  try {
    const root = join(dir, 'sandboxes');
    assert.throws(() => new SeatbeltSandbox({ sessionId: 'rel', root, browserSeed: 'seed' }), /browserSeed must be absolute/);
    assert.throws(
      () => new SeatbeltSandbox({ sessionId: 'secret', root, browserSeed: join(homedir(), '.ssh') }),
      (err: Error) => err instanceof SandboxIsolationError && /browserSeed/.test(err.message),
    );
    // Constructing is side-effect free: nothing touches disk until start().
    new SeatbeltSandbox({ sessionId: 'ok', root, browserSeed: join(dir, 'seed') });
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
