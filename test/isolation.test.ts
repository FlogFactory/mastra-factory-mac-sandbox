/**
 * macOS-only integration tests: the isolation table from the README, proved against real
 * Seatbelt. Every secret here is a fixture in a temporary dir; the real `~/.ssh` is only probed for
 * "can't list it", with output discarded inside the sandbox.
 */
import { describe, test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SeatbeltSandbox, SandboxIsolationError, ResourceLimiter } from '../src/index.ts';

const onMac = process.platform === 'darwin';
const GiB = 1024 ** 3;
const SECRET_MARK = 'FIXTURE_SECRET_VALUE_42';

/**
 * True when this process is already inside a Seatbelt sandbox that won't let it apply another
 * (`sandbox_apply: Operation not permitted`), as in a Factory session or review run. These tests
 * can't prove anything there; CI's macOS job runs them unsandboxed. Only that exact refusal
 * counts, so any other `sandbox-exec` failure still fails the tests below.
 */
function seatbeltNestingRefused(): boolean {
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'pipe' });
    return false;
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    return /sandbox_apply: Operation not permitted/.test(stderr);
  }
}

const hasPnpm = (() => {
  try {
    execFileSync('pnpm', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// In CI the job must prove isolation, so never skip there: a refusal fails loudly instead.
const skipReason = !onMac
  ? 'macOS only'
  : !process.env.CI && seatbeltNestingRefused()
    ? 'already inside a Seatbelt sandbox, which macOS will not nest; CI "Isolation tests (macOS)" runs these'
    : false;

describe('Seatbelt isolation (macOS)', { skip: skipReason }, () => {
  let dir: string, homeFixture: string, secretsDir: string, otherRepo: string;
  let limiter: ResourceLimiter, sb: SeatbeltSandbox;
  const sh = (script: string, opts: Parameters<SeatbeltSandbox['executeCommand']>[2] = {}) =>
    sb.executeCommand('/bin/sh', ['-c', script], opts);

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mfms-it-')));
    // A fake "home" credential store and project, under the real home dir, like ~/.ssh would be.
    homeFixture = realpathSync(mkdtempSync(join(homedir(), '.mfms-fixture-')));
    mkdirSync(join(homeFixture, '.ssh'));
    writeFileSync(join(homeFixture, '.ssh', 'id_fixture'), `${SECRET_MARK}\n`);
    mkdirSync(join(homeFixture, 'project'));
    writeFileSync(join(homeFixture, 'project', '.env'), `TOKEN=${SECRET_MARK}\n`);
    // A fake Factory secrets dir and another repo's .env.
    secretsDir = join(dir, 'factory-secrets');
    mkdirSync(secretsDir);
    writeFileSync(join(secretsDir, 'server.env'), `GITHUB_PRIVATE_KEY=${SECRET_MARK}\n`);
    otherRepo = join(dir, 'other-repo');
    mkdirSync(otherRepo);
    writeFileSync(join(otherRepo, '.env'), `API_KEY=${SECRET_MARK}\n`);

    process.env.MFMS_SERVER_ONLY = SECRET_MARK;
    limiter = new ResourceLimiter({
      admission: { minFreeMemBytes: 0, minFreeDiskBytes: 0, maxLoad1: Infinity },
      probe: () => ({ freeMemBytes: 8 * GiB, freeDiskBytes: 100 * GiB, load1: 0 }),
      onBlocked: () => {},
    });
    sb = new SeatbeltSandbox({
      sessionId: 'sess/01:it',
      root: join(dir, 'sandboxes'),
      commandTimeoutMs: 120_000,
      factoryDirs: [secretsDir],
      denyRead: [homeFixture, otherRepo],
      passEnv: ['LANG'],
      limiter,
    });
    await sb.start(); // also proves every deny path is unreadable, or it throws
  });

  after(async () => {
    delete process.env.MFMS_SERVER_ONLY;
    await sb?.destroy();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (homeFixture) rmSync(homeFixture, { recursive: true, force: true });
  });

  test('commands run in the session worktree, with literal args and streamed stdout', async () => {
    assert.ok(sb.workingDirectory!.startsWith(join(sb.sessionRoot, '.sandcastle', 'worktrees')));
    const lines: string[] = [];
    const r = await sb.executeCommand('/bin/sh', ['-c', 'pwd; echo "$1"', 'x', 'a b;$(id)'], { onStdout: (l) => lines.push(l) });
    assert.equal(r.success, true);
    assert.deepEqual(r.stdout.trim().split('\n'), [sb.workingDirectory, 'a b;$(id)']);
    assert.ok(lines.length >= 2);
  });

  test('writes inside the worktree work; writes outside it are blocked', async () => {
    assert.equal((await sh('echo ok > inside.txt && cat inside.txt')).stdout, 'ok\n');
    const outside = join(dir, 'outside.txt');
    assert.equal((await sh(`echo x > ${outside}`)).success, false);
    assert.equal(existsSync(outside), false);
    const inHome = join(homeFixture, 'planted.txt');
    assert.equal((await sh(`echo x > ${inHome}`)).success, false);
    assert.equal(existsSync(inHome), false);
  });

  test('the Factory secrets dir is unreadable', async () => {
    const ls = await sh(`ls ${secretsDir}`);
    assert.equal(ls.success, false);
    const cat = await sh(`cat ${join(secretsDir, 'server.env')}`);
    assert.equal(cat.success, false);
    assert.equal(cat.stdout.includes(SECRET_MARK), false);
  });

  test('~/.ssh-style dirs in the home dir are unreadable', async () => {
    const r = await sh(`cat ${join(homeFixture, '.ssh', 'id_fixture')}`);
    assert.equal(r.success, false);
    assert.equal(r.stdout.includes(SECRET_MARK), false);
    // The real ~/.ssh: only "can't list it", output discarded inside the sandbox.
    const real = await sh(`ls ${join(homedir(), '.ssh')} >/dev/null 2>&1`);
    assert.equal(real.success, false);
  });

  test('.env files elsewhere are unreadable', async () => {
    for (const p of [join(otherRepo, '.env'), join(homeFixture, 'project', '.env')]) {
      const r = await sh(`cat ${p}`);
      assert.equal(r.success, false, p);
      assert.equal(r.stdout.includes(SECRET_MARK), false, p);
    }
  });

  test('the server env is not passed; only the allow-list and per-command env are', async () => {
    const r = await sh('echo "[${MFMS_SERVER_ONLY:-unset}] [${LANG:-unset}]"');
    assert.equal(r.stdout, `[unset] [${process.env.LANG ?? 'en_US.UTF-8'}]\n`);
  });

  test('per-command env reaches the command, never the host command line, and does not persist', async () => {
    const token = 'ghs_' + 'F'.repeat(36);
    const p = sh('echo "$GH_TOKEN" > tok.txt; sleep 2', { env: { GH_TOKEN: token } });
    await new Promise((r) => setTimeout(r, 800));
    const ps = execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(ps.includes(token), false, 'token visible in host ps');
    assert.equal((await p).success, true);
    const read = await sh('cat tok.txt; echo "[${GH_TOKEN:-unset}]"');
    assert.equal(read.stdout, `${token}\n[unset]\n`);
  });

  test('git clone over HTTPS works', async () => {
    const r = await sh('git clone -q --depth 1 https://github.com/octocat/Hello-World.git hw && git -C hw log -1 --format=%H');
    assert.equal(r.success, true, r.stderr);
    assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
    assert.ok(readFileSync(join(sb.workingDirectory!, 'hw', 'README')).length > 0);
  });

  test('npm works (npm view left-pad version)', async () => {
    const r = await sh('npm view left-pad version');
    assert.equal(r.success, true, r.stderr);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  test('XDG_RUNTIME_DIR is the private TMPDIR, so runtime lock dirs are writable', async () => {
    const r = await sh('test "$XDG_RUNTIME_DIR" = "$TMPDIR" && mkdir "$XDG_RUNTIME_DIR/pnpm-store-operation-locks-$(id -u)" && echo ok');
    assert.equal(r.stdout, 'ok\n', r.stderr);
  });

  // CI's macOS runner has no pnpm; the XDG_RUNTIME_DIR test above proves the mechanism there.
  test('pnpm install works (it locks the store under XDG_RUNTIME_DIR, not /tmp)', { skip: hasPnpm ? false : 'pnpm is not on PATH' }, async () => {
    const r = await sh('mkdir pnpm-it && cd pnpm-it && echo \'{"name":"p","version":"1.0.0"}\' > package.json && pnpm install');
    assert.equal(r.success, true, r.stdout + r.stderr);
  });

  test('the slot is held only while a command runs', async () => {
    assert.deepEqual(limiter.snapshot().running, []);
    const p = sb.executeCommand('sleep', ['1']);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(limiter.snapshot().running, ['session:sess/01:it']);
    await p;
    assert.deepEqual(limiter.snapshot().running, []);
  });

  test('a timeout kills the command and is reported', async () => {
    const r = await sb.executeCommand('sleep', ['30'], { timeout: 1500 });
    assert.equal(r.success, false);
    assert.equal(r.timedOut, true);
    assert.ok(r.executionTimeMs! < 10_000);
  });

  test('start fails closed when a deny path is readable from inside', async () => {
    const bad = new SeatbeltSandbox({ sessionId: 'readable', root: join(dir, 'sandboxes'), denyRead: ['/usr/share'] });
    await assert.rejects(bad.start(), (err: Error) => err instanceof SandboxIsolationError && /\/usr\/share/.test(err.message));
    assert.equal(bad.status, 'error');
  });
});

describe('pnpm seed (macOS)', { skip: skipReason }, () => {
  let dir: string, seed: string, sb: SeatbeltSandbox;
  const sh = (script: string) => sb.executeCommand('/bin/sh', ['-c', script]);

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mfms-seed-it-')));
    seed = join(dir, 'seed');
    mkdirSync(join(seed, 'store'), { recursive: true });
    mkdirSync(join(seed, 'cache'), { recursive: true });
    writeFileSync(join(seed, 'store', 'marker'), 'from the seed\n');
    if (hasPnpm) {
      // A real seed: pnpm fetch, on the host, for a one-dependency project.
      const proj = join(dir, 'proj');
      mkdirSync(proj);
      writeFileSync(join(proj, 'package.json'), '{"name":"p","version":"1.0.0","dependencies":{"is-number":"7.0.0"}}');
      execFileSync('pnpm', ['install', '--lockfile-only', '--store-dir', join(seed, 'store'), '--cache-dir', join(seed, 'cache')], { cwd: proj, stdio: 'pipe' });
      execFileSync('pnpm', ['fetch', '--store-dir', join(seed, 'store'), '--cache-dir', join(seed, 'cache')], { cwd: proj, stdio: 'pipe' });
    }
    sb = new SeatbeltSandbox({ sessionId: 'seeded', root: join(dir, 'sandboxes'), pnpmSeed: seed, commandTimeoutMs: 120_000 });
    await sb.start();
  });

  after(async () => {
    await sb?.destroy();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('pnpm points at a session copy of the seed, which the session can write', async () => {
    const copy = join(sb.sessionRoot, '.pnpm');
    const r = await sh('echo "$pnpm_config_store_dir|$pnpm_config_cache_dir"; cat "$pnpm_config_store_dir/marker"; echo x > "$pnpm_config_store_dir/added" && echo wrote');
    assert.equal(r.stdout, `${join(copy, 'store')}|${join(copy, 'cache')}\nfrom the seed\nwrote\n`, r.stderr);
  });

  test('the seed itself is unreadable and unchanged', async () => {
    const r = await sh(`ls ${seed} >/dev/null 2>&1 && echo readable; echo x > ${join(seed, 'store', 'planted')} 2>/dev/null && echo writable; echo done`);
    assert.equal(r.stdout, 'done\n');
    assert.equal(existsSync(join(seed, 'store', 'added')), false);
    assert.equal(existsSync(join(seed, 'store', 'planted')), false);
  });

  test('offline pnpm install is served from the seed', { skip: hasPnpm ? false : 'pnpm is not on PATH' }, async () => {
    execFileSync('cp', [join(dir, 'proj', 'package.json'), join(dir, 'proj', 'pnpm-lock.yaml'), sb.workingDirectory!]);
    const r = await sh('pnpm install --offline --frozen-lockfile && test -f node_modules/is-number/package.json && echo installed');
    assert.match(r.stdout, /installed\n$/, r.stdout + r.stderr);
  });

  test('a restarted session keeps its own copy instead of re-seeding', async () => {
    await sb.destroy();
    sb = new SeatbeltSandbox({ sessionId: 'seeded', root: join(dir, 'sandboxes'), pnpmSeed: seed });
    await sb.start();
    assert.equal((await sh('cat "$pnpm_config_store_dir/added"')).stdout, 'x\n');
  });

  test('a seed inside a deny path is refused', () => {
    assert.throws(
      () => new SeatbeltSandbox({ sessionId: 'bad-seed', root: join(dir, 'sandboxes'), pnpmSeed: join(homedir(), '.ssh') }),
      (err: Error) => err instanceof SandboxIsolationError && /pnpmSeed/.test(err.message),
    );
  });

  test('a seed that cannot be used is reported on start, and pnpm still works', async () => {
    const warn = mock.method(console, 'warn', () => undefined);
    const missing = join(dir, 'no-seed-yet');
    const cold = new SeatbeltSandbox({ sessionId: 'unseeded', root: join(dir, 'sandboxes'), pnpmSeed: missing });
    try {
      await cold.start();
      const said = warn.mock.calls.map((c) => String(c.arguments[0])).filter((a) => a.startsWith('pnpmSeed '));
      assert.equal(said.length, 1, said.join('\n'));
      assert.match(said[0], /no-seed-yet/);
      assert.equal(cold.pnpmSeedResult?.seeded, false);
      assert.match(cold.pnpmSeedResult?.reason ?? '', /no-seed-yet/);
      const r = await cold.executeCommand('/bin/sh', ['-c', `echo x > "$pnpm_config_store_dir/added" && cat "$pnpm_config_store_dir/added"`]);
      assert.equal(r.stdout, 'x\n', r.stderr);
    } finally {
      warn.mock.restore();
      await cold.destroy();
    }
  });
});
