import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceLimiter, admissionBlock, freeDiskBytes, type ResourceReading } from '../src/limiter.ts';

const GiB = 1024 ** 3;
const plenty: ResourceReading = { freeMemBytes: 8 * GiB, freeDiskBytes: 100 * GiB, load1: 0.5 };
const admission = { minFreeMemBytes: 3 * GiB, minFreeDiskBytes: 10 * GiB, maxLoad1: 6 };
const quiet = () => {};
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('admission checks memory, then disk, then load', () => {
  assert.equal(admissionBlock(plenty, admission), null);
  assert.match(admissionBlock({ ...plenty, freeMemBytes: GiB }, admission)!, /free memory/);
  assert.match(admissionBlock({ ...plenty, freeDiskBytes: GiB }, admission)!, /free disk/);
  assert.match(admissionBlock({ ...plenty, load1: 6 }, admission)!, /load/);
});

test('one slot: the second holder waits until the first releases', async () => {
  const l = new ResourceLimiter({ concurrency: 1, admission, probe: () => plenty, onBlocked: quiet });
  const a = await l.acquire({ holderId: 'a' });
  let bGot = false;
  const bP = l.acquire({ holderId: 'b' }).then((x) => { bGot = true; return x; });
  await tick(30);
  assert.equal(bGot, false);
  assert.deepEqual(l.snapshot(), { running: ['a'], waiting: ['b'], blockedReason: null });
  a.release();
  a.release(); // idempotent
  (await bP).release();
  assert.deepEqual(l.snapshot().running, []);
});

test('two slots run two at once', async () => {
  const l = new ResourceLimiter({ concurrency: 2, admission, probe: () => plenty, onBlocked: quiet });
  const [a, b] = await Promise.all([l.acquire({ holderId: 'a' }), l.acquire({ holderId: 'b' })]);
  assert.equal(l.snapshot().running.length, 2);
  a.release(); b.release();
});

test('waiters are served by priority, then age', async () => {
  const l = new ResourceLimiter({ admission, probe: () => plenty, onBlocked: quiet });
  const first = await l.acquire({ holderId: 'first' });
  const order: string[] = [];
  const take = (id: string, priority: number) => l.acquire({ holderId: id, priority }).then((x) => { order.push(id); x.release(); });
  const ps = [take('low-old', 100), take('high', 10), take('low-new', 100)];
  first.release();
  await Promise.all(ps);
  assert.deepEqual(order, ['high', 'low-old', 'low-new']);
});

test('a waiter stays queued while resources are short, then runs', async () => {
  let reading = { ...plenty, freeMemBytes: GiB };
  const reasons: string[] = [];
  const l = new ResourceLimiter({ admission, probe: () => reading, pollMs: 5, onBlocked: (r) => reasons.push(r) });
  let got = false;
  const p = l.acquire({ holderId: 'a' }).then((x) => { got = true; return x; });
  await tick(40);
  assert.equal(got, false);
  assert.match(l.snapshot().blockedReason!, /free memory/);
  assert.equal(reasons.length, 1, 'one report per distinct reason');
  reading = plenty;
  (await p).release();
  assert.equal(l.snapshot().blockedReason, null);
});

test('aborting a wait removes the waiter', async () => {
  const l = new ResourceLimiter({ admission, probe: () => plenty, onBlocked: quiet });
  const a = await l.acquire({ holderId: 'a' });
  const ac = new AbortController();
  const p = l.acquire({ holderId: 'b', signal: ac.signal });
  ac.abort(new Error('cancelled'));
  await assert.rejects(p, /cancelled/);
  assert.deepEqual(l.snapshot().waiting, []);
  a.release();
  await assert.rejects(l.acquire({ holderId: 'c', signal: ac.signal }), /cancelled/);
});

test('free disk works for a path that does not exist yet', () => {
  assert.ok(freeDiskBytes('/tmp/does/not/exist/yet') > 0);
});
