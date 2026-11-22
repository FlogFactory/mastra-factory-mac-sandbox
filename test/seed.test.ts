import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneTree, seedPnpmCopy } from '../src/seed.ts';
import { SandboxIsolationError, SeatbeltSandbox } from '../src/sandbox.ts';

const skip = process.platform === 'darwin' ? false : 'APFS clones are macOS only';

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mfms-seed-')));
  const seed = join(dir, 'seed');
  for (const sub of ['store/v11/files/00', 'cache/v12/metadata']) mkdirSync(join(seed, sub), { recursive: true });
  writeFileSync(join(seed, 'store/v11/files/00/pkg'), 'package bytes');
  writeFileSync(join(seed, 'cache/v12/metadata/left-pad.jsonl'), '{}');
  return { dir, seed, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cloneTree clones a whole directory tree, and the copy is independent', { skip }, () => {
  const f = fixture();
  try {
    const dst = join(f.dir, 'copy');
    cloneTree(join(f.seed, 'store'), dst);
    assert.equal(readFileSync(join(dst, 'v11/files/00/pkg'), 'utf8'), 'package bytes');
    writeFileSync(join(dst, 'v11/files/00/pkg'), 'changed in the copy');
    assert.equal(readFileSync(join(f.seed, 'store/v11/files/00/pkg'), 'utf8'), 'package bytes');
  } finally {
    f.done();
  }
});

test('cloneTree refuses to overwrite and reports a missing source', { skip }, () => {
  const f = fixture();
  try {
    const dst = join(f.dir, 'copy');
    mkdirSync(dst);
    assert.throws(() => cloneTree(join(f.seed, 'store'), dst), /clonefileat/);
    assert.throws(() => cloneTree(join(f.dir, 'missing'), join(f.dir, 'copy2')), /clonefileat/);
  } finally {
    f.done();
  }
});

test('seedPnpmCopy clones store and cache once, and keeps an existing copy', { skip }, () => {
  const f = fixture();
  try {
    const copy = join(f.dir, 'session', '.pnpm');
    assert.deepEqual(seedPnpmCopy(f.seed, copy), { seeded: true });
    assert.equal(readFileSync(join(copy, 'store/v11/files/00/pkg'), 'utf8'), 'package bytes');
    assert.ok(statSync(join(copy, 'cache/v12/metadata/left-pad.jsonl')).isFile());
    // A restarted session keeps what it already has, including packages it added itself.
    writeFileSync(join(copy, 'store/mine'), 'x');
    assert.deepEqual(seedPnpmCopy(f.seed, copy), { seeded: false, reason: 'already present' });
    assert.equal(readFileSync(join(copy, 'store/mine'), 'utf8'), 'x');
  } finally {
    f.done();
  }
});

test('without a usable seed, seedPnpmCopy leaves empty dirs and says why', { skip }, () => {
  const f = fixture();
  try {
    const copy = join(f.dir, 'session', '.pnpm');
    const r = seedPnpmCopy(join(f.dir, 'no-seed-yet'), copy);
    assert.equal(r.seeded, false);
    assert.match(r.reason!, /no-seed-yet/);
    assert.ok(statSync(join(copy, 'store')).isDirectory());
    assert.ok(statSync(join(copy, 'cache')).isDirectory());
  } finally {
    f.done();
  }
});

test('a subtree the seed could not provide is retried on the next start', { skip }, () => {
  const f = fixture();
  try {
    const copy = join(f.dir, 'session', '.pnpm');
    // The seed has no store yet: the cache seeds, the store is reported and left empty.
    rmSync(join(f.seed, 'store'), { recursive: true, force: true });
    const first = seedPnpmCopy(f.seed, copy);
    assert.equal(first.seeded, true);
    assert.match(first.reason!, /store/);
    assert.deepEqual(readdirSync(join(copy, 'store')), []);
    // The session installs while the store was missing, so its copy holds real data.
    writeFileSync(join(copy, 'cache/session-file'), 'kept');
    // The seed is filled, the session restarts: the store is cloned, the cache is left alone.
    mkdirSync(join(f.seed, 'store/v11/files/00'), { recursive: true });
    writeFileSync(join(f.seed, 'store/v11/files/00/pkg'), 'package bytes');
    assert.deepEqual(seedPnpmCopy(f.seed, copy), { seeded: true });
    assert.equal(readFileSync(join(copy, 'store/v11/files/00/pkg'), 'utf8'), 'package bytes');
    assert.equal(readFileSync(join(copy, 'cache/session-file'), 'utf8'), 'kept');
  } finally {
    f.done();
  }
});

test("a session's own store is never replaced by a later seed", { skip }, () => {
  const f = fixture();
  try {
    const copy = join(f.dir, 'session', '.pnpm');
    assert.deepEqual(seedPnpmCopy(f.seed, copy), { seeded: true });
    writeFileSync(join(copy, 'store/mine'), 'x');
    // The seed is rebuilt with different contents, the session restarts.
    writeFileSync(join(f.seed, 'store/v11/files/00/pkg'), 'different bytes');
    assert.deepEqual(seedPnpmCopy(f.seed, copy), { seeded: false, reason: 'already present' });
    assert.equal(readFileSync(join(copy, 'store/mine'), 'utf8'), 'x');
    assert.equal(readFileSync(join(copy, 'store/v11/files/00/pkg'), 'utf8'), 'package bytes');
  } finally {
    f.done();
  }
});

test('a deny path inside the seed is refused', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mfms-root-')));
  try {
    assert.throws(
      () => new SeatbeltSandbox({ sessionId: 'wide-seed', root: join(dir, 'sandboxes'), pnpmSeed: homedir() }),
      (err: Error) => err instanceof SandboxIsolationError && /pnpmSeed/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

