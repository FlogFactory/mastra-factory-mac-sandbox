/**
 * The execution slot: how many sandboxed commands may run at once on this machine, with admission
 * checks on free memory, free disk and load before a command starts.
 *
 * A sandbox holds a slot for one command only, so a session that sits waiting for a plan approval
 * never blocks other work. Any object with `acquire()` works; `ResourceLimiter` is the in-process
 * default. If you run more than one Factory process on a machine, give each the same external
 * limiter (for example one backed by SQLite) instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { availableParallelism, freemem, loadavg } from 'node:os';

export interface SlotRequest {
  /** Who holds the slot, e.g. `session:<id>`. */
  holderId: string;
  /** What it runs, for logs. */
  label?: string;
  /** Lower runs first. Default 100; sandbox commands use 50. */
  priority?: number;
  /** Abort waiting; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface Lease {
  release(): void;
}

/** The pluggable interface. */
export interface ExecutionLimiter {
  acquire(req: SlotRequest): Promise<Lease>;
}

export interface AdmissionLimits {
  minFreeMemBytes: number;
  minFreeDiskBytes: number;
  /** A command waits while the 1-minute load average is at or above this. */
  maxLoad1: number;
}

export interface ResourceReading {
  freeMemBytes: number;
  freeDiskBytes: number;
  load1: number;
}

export type ResourceProbe = () => ResourceReading;

const GiB = 1024 ** 3;

/** Free + inactive + speculative + purgeable pages: memory macOS can hand out without swapping. */
export function macFreeMemBytes(): number {
  const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' });
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const pages = (label: string) => Number(out.match(new RegExp(`Pages ${label}:\\s+(\\d+)`))?.[1] ?? 0);
  return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * pageSize;
}

/** Free bytes on the volume holding `path` (or its nearest existing ancestor). */
export function freeDiskBytes(path: string): number {
  let p = resolve(path);
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = statfsSync(p);
  return s.bavail * s.bsize;
}

/** Reads this machine. `diskPath` is a path on the volume that holds the sandboxes. */
export function hostProbe(diskPath: string): ResourceProbe {
  return () => ({
    freeMemBytes: process.platform === 'darwin' ? macFreeMemBytes() : freemem(),
    freeDiskBytes: freeDiskBytes(diskPath),
    load1: loadavg()[0] ?? 0,
  });
}

/** Why a command must wait, or null if it may start. */
export function admissionBlock(r: ResourceReading, l: AdmissionLimits): string | null {
  if (r.freeMemBytes < l.minFreeMemBytes) return `free memory ${(r.freeMemBytes / GiB).toFixed(1)} GiB < ${(l.minFreeMemBytes / GiB).toFixed(1)} GiB`;
  if (r.freeDiskBytes < l.minFreeDiskBytes) return `free disk ${(r.freeDiskBytes / GiB).toFixed(1)} GiB < ${(l.minFreeDiskBytes / GiB).toFixed(1)} GiB`;
  if (r.load1 >= l.maxLoad1) return `load ${r.load1.toFixed(2)} >= ${l.maxLoad1}`;
  return null;
}

export const defaultAdmission = (): AdmissionLimits => ({
  minFreeMemBytes: 2 * GiB,
  minFreeDiskBytes: 5 * GiB,
  maxLoad1: availableParallelism(),
});

export interface ResourceLimiterOptions {
  /** Commands that may run at once. Default 1. */
  concurrency?: number;
  /** Default: 2 GiB free memory, 5 GiB free disk, load below the CPU count. */
  admission?: AdmissionLimits;
  /** Default: `hostProbe(process.cwd())`; the factory helper passes the sandbox root. */
  probe?: ResourceProbe;
  /** How often a blocked waiter re-checks resources, in ms. Default 500. */
  pollMs?: number;
  /** Called once per distinct reason while the head of the queue is blocked. Default: console.warn. */
  onBlocked?: (reason: string, req: SlotRequest) => void;
}

interface Waiter {
  req: SlotRequest;
  seq: number;
  resolve: (lease: Lease) => void;
  reject: (err: unknown) => void;
}

/** In-process limiter: a priority queue (then FIFO) with admission checks. */
export class ResourceLimiter implements ExecutionLimiter {
  readonly #concurrency: number;
  readonly #admission: AdmissionLimits;
  readonly #probe: ResourceProbe;
  readonly #pollMs: number;
  readonly #onBlocked: (reason: string, req: SlotRequest) => void;
  #running = new Set<SlotRequest>();
  #queue: Waiter[] = [];
  #seq = 0;
  #timer?: NodeJS.Timeout;
  #lastBlock: string | null = null;

  constructor(o: ResourceLimiterOptions = {}) {
    this.#concurrency = o.concurrency ?? 1;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1) throw new Error('concurrency must be a positive integer');
    this.#admission = o.admission ?? defaultAdmission();
    this.#probe = o.probe ?? hostProbe(process.cwd());
    this.#pollMs = o.pollMs ?? 500;
    this.#onBlocked = o.onBlocked ?? ((reason, req) => console.warn(`[sandbox] ${req.holderId} waiting for resources: ${reason}`));
  }

  acquire(req: SlotRequest): Promise<Lease> {
    if (req.signal?.aborted) return Promise.reject(req.signal.reason);
    return new Promise<Lease>((resolve, reject) => {
      const w: Waiter = { req, seq: this.#seq++, resolve, reject };
      this.#queue.push(w);
      this.#queue.sort((a, b) => (a.req.priority ?? 100) - (b.req.priority ?? 100) || a.seq - b.seq);
      req.signal?.addEventListener('abort', () => {
        const i = this.#queue.indexOf(w);
        if (i >= 0) {
          this.#queue.splice(i, 1);
          reject(req.signal!.reason);
          this.#pump();
        }
      }, { once: true });
      this.#pump();
    });
  }

  /** What is running and waiting, for status pages and tests. */
  snapshot(): { running: string[]; waiting: string[]; blockedReason: string | null } {
    return {
      running: [...this.#running].map((r) => r.holderId),
      waiting: this.#queue.map((w) => w.req.holderId),
      blockedReason: this.#lastBlock,
    };
  }

  #pump(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    while (this.#queue.length > 0 && this.#running.size < this.#concurrency) {
      const head = this.#queue[0]!;
      let block: string | null;
      try {
        block = admissionBlock(this.#probe(), this.#admission);
      } catch (err) {
        // A probe that can't read the machine shouldn't wedge the queue forever.
        block = null;
        this.#onBlocked(`resource probe failed, admitting: ${(err as Error).message}`, head.req);
      }
      if (block) {
        if (block !== this.#lastBlock) this.#onBlocked(block, head.req);
        this.#lastBlock = block;
        this.#timer = setTimeout(() => this.#pump(), this.#pollMs);
        return;
      }
      this.#lastBlock = null;
      this.#queue.shift();
      this.#running.add(head.req);
      let released = false;
      head.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.#running.delete(head.req);
          this.#pump();
        },
      });
    }
  }
}
