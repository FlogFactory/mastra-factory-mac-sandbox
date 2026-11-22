/**
 * macOS-only integration tests: the isolation table from the README, proved against real
 * Seatbelt. Every secret here is a fixture in a temporary dir; the real `~/.ssh` is only probed for
 * "can't list it", with output discarded inside the sandbox.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SeatbeltSandbox, SandboxIsolationError, ResourceLimiter } from '../src/index.ts';

const onMac = process.platform === 'darwin';
const GiB = 1024 ** 3;
const SECRET_MARK = 'FIXTURE_SECRET_VALUE_42';

describe('Seatbelt isolation (macOS)', { skip: !onMac && 'macOS only' }, () => {
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
