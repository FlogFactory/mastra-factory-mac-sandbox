/**
 * The one-call helper for a Factory's `src/mastra/sandbox.ts`.
 */
import { resolve } from 'node:path';
import type { MastraFactorySandboxConfig } from '@mastra/factory';
import { hostProbe, ResourceLimiter, type ExecutionLimiter, type ResourceLimiterOptions } from './limiter.ts';
import { DEFAULT_ROOT, SeatbeltSandbox, type SeatbeltSandboxOptions } from './sandbox.ts';

export interface SeatbeltFactorySandboxOptions extends Omit<SeatbeltSandboxOptions, 'sessionId' | 'limiter'> {
  /**
   * The execution slot shared by every session this callback creates.
   * - omitted: a `ResourceLimiter` with one slot and the default admission checks;
   * - an object of `ResourceLimiterOptions`: a `ResourceLimiter` with those options;
   * - any `ExecutionLimiter`: used as is (for example one shared across processes);
   * - `false`: no slot.
   */
  limiter?: ExecutionLimiter | ResourceLimiterOptions | false;
}

const isLimiter = (x: unknown): x is ExecutionLimiter => typeof (x as ExecutionLimiter)?.acquire === 'function';

/** Returns Factory's `sandbox` callback: one `SeatbeltSandbox` per session, all sharing one slot. */
export function seatbeltFactorySandbox(options: SeatbeltFactorySandboxOptions = {}): MastraFactorySandboxConfig {
  const { limiter: l, ...rest } = options;
  const root = resolve(rest.root ?? DEFAULT_ROOT);
  const limiter = l === false ? undefined : isLimiter(l) ? l : new ResourceLimiter({ probe: hostProbe(root), ...l });
  return (ctx) => new SeatbeltSandbox({ ...rest, root, sessionId: ctx.sessionId, limiter });
}

