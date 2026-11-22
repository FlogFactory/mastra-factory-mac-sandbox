/**
 * SeatbeltSandbox: a Mastra Factory session sandbox that runs every command through Sandcastle's
 * macOS Seatbelt provider.
 *
 * Each session gets a small "session root" git repo under `root`. Sandcastle makes a worktree of
 * it, and Factory clones the product repo inside that worktree. Sandcastle's Seatbelt profile is
 * deny-by-default: commands can read the system toolchain and write only the worktree and a
 * private HOME and TMPDIR. On start, the sandbox also proves that every configured deny path is
 * unreadable from inside, and refuses to start if one is not.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { MastraSandbox } from '@mastra/core/workspace';
import type { CommandResult, ExecuteCommandOptions, ProviderStatus } from '@mastra/core/workspace';
import { createSandbox, type Sandbox } from '@ai-hero/sandcastle';
import { seatbelt } from '@ai-hero/sandcastle/sandboxes/seatbelt';
import type { ExecutionLimiter } from './limiter.ts';
import { buildCommandScript, buildEnvExports, buildReadProbeScript, pickEnv, safeId, shq } from './script.ts';
import { seedPnpmCopy, type SeedResult } from './seed.ts';

export const DEFAULT_ROOT = join(homedir(), '.factory-sandboxes');
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_ENV: Readonly<Record<string, string>> = { LANG: 'en_US.UTF-8', GIT_TERMINAL_PROMPT: '0' };

/** Credential stores in the server user's home that the sandbox must never read. */
export function defaultDenyRead(home = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.docker', '.kube', '.config/gh', '.config/gcloud']
    .map((p) => join(home, p));
}

export class SandboxIsolationError extends Error {
  override name = 'SandboxIsolationError';
}

export interface SeatbeltSandboxOptions {
  /** Factory's session id; also the sandbox id. */
  sessionId: string;
  /** Parent dir for session roots. Default `~/.factory-sandboxes`. Avoid spaces. */
  root?: string;
  /** Upper bound for any one command, in ms, even if Factory asks for longer. Default 15 min. */
  commandTimeoutMs?: number;
  /** Non-secret env every command gets. Default `LANG` and `GIT_TERMINAL_PROMPT=0`. */
  env?: Record<string, string>;
  /** Names copied from the server's own env (an allow-list). Default none. */
  passEnv?: readonly string[];
  /** Your Factory's data and secrets dirs. Checked unreadable on start. */
  factoryDirs?: readonly string[];
  /** More paths that must be unreadable. Added to `defaultDenyRead()` and the server's `./.env`. */
  denyRead?: readonly string[];
  /** The execution slot. Omit to run commands without one. */
  limiter?: ExecutionLimiter;
  /**
   * A host dir holding a pnpm `store/` and `cache/` (for example filled by `pnpm fetch`). Each
   * session then gets its own copy-on-write clone of it at `<sessionRoot>/.pnpm`, and pnpm uses that
   * copy. The seed itself stays unreadable from inside. Default: none, pnpm uses the private HOME.
   */
  pnpmSeed?: string;
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Resolve symlinks where the path exists, so checks compare real paths. */
function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export class SeatbeltSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = 'seatbelt';
  readonly provider = 'sandcastle-seatbelt';
  status: ProviderStatus = 'pending';
  /** Set by destroy() when Sandcastle kept the worktree (it had uncommitted changes). */
  preservedWorktreePath?: string;

  readonly #sessionRoot: string;
  readonly #timeoutMs: number;
  readonly #env: Record<string, string>;
  readonly #denyRead: string[];
  readonly #limiter?: ExecutionLimiter;
  readonly #pnpmSeed?: string;
  #sb?: Sandbox;

  /** Cheap and side-effect free, as Factory requires: nothing touches disk until start(). */
  constructor(o: SeatbeltSandboxOptions) {
    super({ name: 'seatbelt' });
    this.id = o.sessionId;
    const root = resolve(o.root ?? DEFAULT_ROOT);
    this.#sessionRoot = join(root, safeId(o.sessionId));
    this.#timeoutMs = o.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    if (!(this.#timeoutMs > 0)) throw new Error('commandTimeoutMs must be positive');
    this.#env = { ...DEFAULT_ENV, ...pickEnv(o.passEnv ?? [], process.env), ...o.env };
    this.#limiter = o.limiter;
    const deny = [...defaultDenyRead(), join(process.cwd(), '.env'), ...(o.factoryDirs ?? []), ...(o.denyRead ?? [])];
    for (const p of deny) {
      if (!isAbsolute(p)) throw new Error(`deny path must be absolute: ${p}`);
      const rp = real(p);
      const rroot = real(root);
      if (within(rp, rroot) || within(rroot, rp)) {
        throw new SandboxIsolationError(`sandbox root ${root} overlaps deny path ${p}; put the sandboxes somewhere else`);
      }
    }
    this.#denyRead = [...new Set(deny)];
    if (o.pnpmSeed !== undefined) {
      if (!isAbsolute(o.pnpmSeed)) throw new Error(`pnpmSeed must be absolute: ${o.pnpmSeed}`);
      // Sessions get a readable copy of the seed, so it must not be (or hold) anything secret.
      const rs = real(o.pnpmSeed);
      for (const p of this.#denyRead) {
        const rp = real(p);
        if (within(rs, rp) || within(rp, rs)) throw new SandboxIsolationError(`pnpmSeed ${o.pnpmSeed} overlaps deny path ${p}`);
      }
      this.#pnpmSeed = o.pnpmSeed;
      const copy = join(this.#sessionRoot, '.pnpm');
      this.#env.pnpm_config_store_dir = join(copy, 'store');
      this.#env.pnpm_config_cache_dir = join(copy, 'cache');
    }
  }

  #pnpmSeedResult?: SeedResult;

  /** Set by start(): whether that start cloned the seed, and why not when it did not. */
  get pnpmSeedResult(): SeedResult | undefined {
    return this.#pnpmSeedResult;
  }

  get sessionRoot(): string {
    return this.#sessionRoot;
  }

  /** The paths start() proves unreadable. */
  get denyReadPaths(): readonly string[] {
    return this.#denyRead;
  }

  async start(): Promise<void> {
    if (this.#sb) return;
    mkdirSync(this.#sessionRoot, { recursive: true });
    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: this.#sessionRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!existsSync(join(this.#sessionRoot, '.git'))) {
      git('init', '-q', '-b', 'main');
      // Agent commits must not inherit the server user's global commit signing.
      git('config', 'commit.gpgsign', 'false');
      git('-c', 'user.name=factory-sandbox', '-c', 'user.email=sandbox@localhost.invalid', '-c', 'commit.gpgsign=false',
        'commit', '-q', '--allow-empty', '-m', 'session root');
    }
    const mounts = [];
    if (this.#pnpmSeed) {
      const copy = join(this.#sessionRoot, '.pnpm');
      const exclude = join(this.#sessionRoot, '.git', 'info', 'exclude');
      if (!(existsSync(exclude) && readFileSync(exclude, 'utf8').includes('/.pnpm/'))) appendFileSync(exclude, '/.pnpm/\n');
      this.#pnpmSeedResult = seedPnpmCopy(this.#pnpmSeed, copy);
      const seedResult = this.#pnpmSeedResult;
      // A configured seed that did not seed is the operator's problem, not the session's: say so
      // once instead of letting the session run cold without a trace.
      if (seedResult.reason && seedResult.reason !== 'already present') {
        console.warn(`pnpmSeed ${this.#pnpmSeed}: ${seedResult.reason}`);
      }

      // Writable, and only this session's copy: the seed is never mounted.
      mounts.push({ hostPath: copy, sandboxPath: copy });
    }
    const sb = await createSandbox({
      cwd: this.#sessionRoot,
      branch: `session/${safeId(this.id)}`,
      sandbox: seatbelt({ mounts }),
    });
    try {
      await this.#verifyDenyRead(sb);
    } catch (err) {
      await sb.close().catch(() => undefined);
      this.status = 'error';
      throw err;
    }
    this.#sb = sb;
    this.setWorkingDirectory(sb.worktreePath);
    this.status = 'running';
  }

  /** Fail closed: if any deny path is readable from inside, the sandbox doesn't start. */
  async #verifyDenyRead(sb: Sandbox): Promise<void> {
    const r = await sb.exec(`/bin/bash -c ${shq(buildReadProbeScript(this.#denyRead))}`, { stdin: '' });
    const readable = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (r.exitCode !== 0 && readable.length === 0 && r.stderr.trim()) {
      throw new SandboxIsolationError(`deny-path check failed to run: ${r.stderr.trim().slice(0, 300)}`);
    }
    if (readable.length > 0) {
      throw new SandboxIsolationError(`readable from inside the sandbox, refusing to start: ${readable.join(', ')}`);
    }
  }

  async executeCommand(command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<CommandResult> {
    await this.ensureRunning();
    const sb = this.#sb!;
    // Static env, then Factory's runtime env, then this command's env (e.g. a short-lived GH_TOKEN).
    const env = { ...this.#env, ...this.getEnv(), ...(options.env ?? {}) };
    const limitMs = Math.min(options.timeout ?? this.#timeoutMs, this.#timeoutMs);
    const secs = Math.max(1, Math.ceil(limitMs / 1000));
    const lease = await this.#limiter?.acquire({
      holderId: `session:${this.id}`,
      label: `${command} ${args.join(' ')}`.slice(0, 200),
      priority: 50,
      signal: options.abortSignal,
    });
    const t = Date.now();
    try {
      const r = await sb.exec(`/bin/bash -c ${shq(buildCommandScript(command, args, secs))}`, {
        cwd: options.cwd ?? this.workingDirectory,
        stdin: buildEnvExports(env) + '\n',
        onLine: options.onStdout ? (line: string) => options.onStdout!(line + '\n') : undefined,
      });
      const ms = Date.now() - t;
      // A command killed by the alarm comes back as a plain non-zero exit; infer it from elapsed time.
      const timedOut = r.exitCode !== 0 && ms >= secs * 1000;
      return { success: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, executionTimeMs: ms, timedOut, command, args };
    } finally {
      lease?.release();
    }
  }

  /** Sessions are long-lived; Factory calls destroy() to retire them. */
  async stop(): Promise<void> {}

  async destroy(): Promise<void> {
    if (this.#sb) {
      const res = await this.#sb.close();
      this.preservedWorktreePath = res?.preservedWorktreePath;
      this.#sb = undefined;
    }
    this.status = 'destroyed';
  }

  getInstructions(): string {
    return 'Commands run in a macOS Seatbelt sandbox. You can write only inside the working directory and a private TMPDIR and HOME. Files outside them, including the server user\'s home, are unreadable. `ps` is not permitted. The network is open.';
  }
}
