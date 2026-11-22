import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { seatbeltFactorySandbox, SeatbeltSandbox, SandboxIsolationError, DEFAULT_ROOT } from '../src/index.ts';
import type { ExecutionLimiter } from '../src/index.ts';

const ctx = (sessionId: string) => ({ sessionId }) as any;

test('the callback builds a sandbox per session without touching disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mfms-unit-'));
  try {
    const root = join(dir, 'boxes');
    const make = seatbeltFactorySandbox({ root });
    const sb = make(ctx('sess/1')) as SeatbeltSandbox;
    assert.ok(sb instanceof SeatbeltSandbox);
    assert.equal(sb.id, 'sess/1');
    assert.equal(sb.sessionRoot, join(root, 'sess-1'));
    assert.equal(existsSync(root), false, 'construction must be side-effect free');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaults: root without spaces, ~/.ssh and the server .env denied', () => {
  assert.equal(DEFAULT_ROOT, join(homedir(), '.factory-sandboxes'));
  assert.doesNotMatch(DEFAULT_ROOT.replace(homedir(), ''), /\s/);
  const sb = new SeatbeltSandbox({ sessionId: 's', factoryDirs: ['/srv/factory/secrets'] });
  assert.ok(sb.denyReadPaths.includes(join(homedir(), '.ssh')));
  assert.ok(sb.denyReadPaths.includes(join(process.cwd(), '.env')));
  assert.ok(sb.denyReadPaths.includes('/srv/factory/secrets'));
});

test('a root that overlaps a deny path is refused', () => {
  assert.throws(() => new SeatbeltSandbox({ sessionId: 's', root: '/srv/data/boxes', factoryDirs: ['/srv/data'] }), SandboxIsolationError);
  assert.throws(() => new SeatbeltSandbox({ sessionId: 's', root: '/srv/data', denyRead: ['/srv/data/secrets'] }), SandboxIsolationError);
  assert.throws(() => new SeatbeltSandbox({ sessionId: 's', denyRead: ['relative/path'] }), /absolute/);
});

test('one limiter is shared by every session; a custom one is used as is; false disables it', () => {
  const custom: ExecutionLimiter = { acquire: async () => ({ release() {} }) };
  assert.doesNotThrow(() => seatbeltFactorySandbox({ limiter: custom })(ctx('a')));
  assert.doesNotThrow(() => seatbeltFactorySandbox({ limiter: false })(ctx('a')));
  assert.doesNotThrow(() => seatbeltFactorySandbox({ limiter: { concurrency: 2 } })(ctx('a')));
  assert.throws(() => seatbeltFactorySandbox({ limiter: { concurrency: 0 } }), /concurrency/);
});
