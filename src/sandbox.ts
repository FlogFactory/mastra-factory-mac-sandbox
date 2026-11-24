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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { MastraSandbox } from '@mastra/core/workspace';
import type { CommandResult, ExecuteCommandOptions, ProviderStatus } from '@mastra/core/workspace';
import { createSandbox, type MountConfig, type Sandbox } from '@ai-hero/sandcastle';
import { seatbelt } from '@ai-hero/sandcastle/sandboxes/seatbelt';
import type { ExecutionLimiter } from './limiter.ts';
import { buildCommandScript, buildEnvExports, buildMktempShim, buildReadProbeScript, pickEnv, safeId, shq } from './script.ts';
import { seedBrowsersCopy, seedPnpmCopy, type SeedResult } from './seed.ts';

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
  /**
   * A host dir whose `browsers/` holds Playwright's browsers (for example filled by
   * `PLAYWRIGHT_BROWSERS_PATH=<seed>/browsers npx playwright install chromium-headless-shell`
   * outside the sandbox, which writes `<seed>/browsers/chromium_headless_shell-<revision>/…`). Each
   * session gets its own copy-on-write clone of that `browsers/` at `<sessionRoot>/.browsers`,
   * mounted read-only, and Playwright uses it through `PLAYWRIGHT_BROWSERS_PATH`.
   * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set whenever this option is, so a session without a
   * usable seed reports a missing browser instead of downloading one. The seed itself stays
   * unreadable from inside. Default: none, Playwright uses the private HOME.
   *
   * Needs a Sandcastle whose `seatbelt()` accepts `extraProfile` (Chromium cannot register its
   * Mach rendezvous port otherwise); start() refuses to run a seeded session without it.
   */
  browserSeed?: string;
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Keep a session-internal dir out of `git status` in the session root. */
function excludeFromSessionRoot(sessionRoot: string, pattern: string): void {
  const exclude = join(sessionRoot, '.git', 'info', 'exclude');
  if (!(existsSync(exclude) && readFileSync(exclude, 'utf8').includes(pattern))) appendFileSync(exclude, `${pattern}\n`);
}

/** Resolve symlinks where the path exists, so checks compare real paths. */
function real(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Escape a host path for a Seatbelt string literal. */
function seatbeltLiteral(p: string): string {
  return `"${p.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The extra profile a seeded Chromium needs. `seatbelt()` appends it after its own rules, so these
 * win: the Mach allows beat the base `deny mach-lookup`, and the write deny covers the session's
 * copy even though it sits inside the writable home.
 */
export function browserSeedProfile(browsersDir: string): string {
  return [
    "; Chromium's Mach rendezvous port: without both rules Chromium hangs.",
    '(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer"))',
    '(allow mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer"))',
    `(deny file-write* (subpath ${seatbeltLiteral(browsersDir)}))`,
  ].join('\n');
}

/** `extraProfile` isn't in 0.14.0's types; the patch adds it at runtime, so it is detected there. */
type PatchedSeatbeltOptions = Parameters<typeof seatbelt>[0] & { extraProfile?: string };

export class SeatbeltSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = 'seatbelt';
  readonly provider = 'sandcastle-seatbelt';
  status: ProviderStatus = 'pending';
  /** Set by destroy() when Sandcastle kept the worktree (it had uncommitted changes). */
  preservedWorktreePath?: string;

  readonly #sessionRoot: string;
  readonly #binDir: string;
  readonly #timeoutMs: number;
  readonly #env: Record<string, string>;
  readonly #denyRead: string[];
  readonly #limiter?: ExecutionLimiter;
  readonly #pnpmSeed?: string;
  readonly #browserSeed?: string;
  #sb?: Sandbox;

  /** Cheap and side-effect free, as Factory requires: nothing touches disk until start(). */
  constructor(o: SeatbeltSandboxOptions) {
    super({ name: 'seatbelt' });
    this.id = o.sessionId;
    const root = resolve(o.root ?? DEFAULT_ROOT);
    this.#sessionRoot = join(root, safeId(o.sessionId));
    this.#binDir = join(this.#sessionRoot, '.bin');
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
    if (o.browserSeed !== undefined) {
      if (!isAbsolute(o.browserSeed)) throw new Error(`browserSeed must be absolute: ${o.browserSeed}`);
      // Sessions get a readable copy of the seed, so it must not be (or hold) anything secret.
      const rs = real(o.browserSeed);
      for (const p of this.#denyRead) {
        const rp = real(p);
        if (within(rs, rp) || within(rp, rs)) throw new SandboxIsolationError(`browserSeed ${o.browserSeed} overlaps deny path ${p}`);
      }
      this.#browserSeed = o.browserSeed;
      // Even when the seed turns out to be unusable: Playwright must report a missing browser
      // instead of downloading one into the session.
      this.#env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
    }
  }

  #pnpmSeedResult?: SeedResult;
  #browserSeedResult?: SeedResult;

  /** Set by start(): whether that start cloned the seed, and why not when it did not. */
  get pnpmSeedResult(): SeedResult | undefined {
    return this.#pnpmSeedResult;
  }

  /** Set by start() when `browserSeed` is configured: whether it cloned, and why not. */
  get browserSeedResult(): SeedResult | undefined {
    return this.#browserSeedResult;
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
    // The `mktemp` shim. macOS creates a template-less (or `-t`) temp file outside `$TMPDIR`,
    // which the profile denies, so commands get a shim first on `PATH`. It is written before the
    // sandbox exists because Sandcastle drops a mount whose path is not there yet, and mounted
    // read-only so the session gains no writable path and cannot replace it.
    mkdirSync(this.#binDir, { recursive: true });
    const shim = join(this.#binDir, 'mktemp');
    writeFileSync(shim, buildMktempShim());
    chmodSync(shim, 0o755);
    excludeFromSessionRoot(this.#sessionRoot, '/.bin/');
    const mounts: MountConfig[] = [{ hostPath: this.#binDir, sandboxPath: this.#binDir, readonly: true }];
    if (this.#pnpmSeed) {
      const copy = join(this.#sessionRoot, '.pnpm');
      excludeFromSessionRoot(this.#sessionRoot, '/.pnpm/');
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
    // When the seed is unusable the session still starts: Playwright then reports a missing
    // browser, which the agent can pass on, instead of downloading one.
    let probe: string | undefined;
    let extraProfile: string | undefined;
    if (this.#browserSeed) {
      const copy = join(this.#sessionRoot, '.browsers');
      excludeFromSessionRoot(this.#sessionRoot, '/.browsers/');
      this.#browserSeedResult = seedBrowsersCopy(this.#browserSeed, copy);
      const seedResult = this.#browserSeedResult;
      if (seedResult.reason && seedResult.reason !== 'already present') {
        console.warn(`browserSeed ${this.#browserSeed}: ${seedResult.reason}`);
      }
      // A restarted session already has its copy; it is just as usable as a fresh clone.
      if (seedResult.seeded || seedResult.reason === 'already present') {
        // Read-only, at its host path (this provider shows mounts where they live), and only this
        // session's copy: the seed is never mounted.
        mounts.push({ hostPath: copy, sandboxPath: copy, readonly: true });
        this.#env.PLAYWRIGHT_BROWSERS_PATH = copy;
        // Prove the provider honours extraProfile before trusting it: deny a file inside the
        // read-only `.bin` mount, which the profile otherwise allows reading. The probe goes there
        // because that directory is mounted; nothing else under the session root is visible inside.
        probe = join(this.#binDir, '.browser-seed-probe');
        writeFileSync(probe, '');
        extraProfile = `${browserSeedProfile(copy)}\n(deny file-read* (literal ${seatbeltLiteral(probe)}))`;
      }
    }
    let sb: Sandbox;
    try {
      const sandbox = seatbelt({ mounts, extraProfile } as PatchedSeatbeltOptions);
      sb = await createSandbox({
        cwd: this.#sessionRoot,
        branch: `session/${safeId(this.id)}`,
        sandbox,
      });
    } catch (err) {
      if (probe) rmSync(probe, { force: true });
      throw err;
    }
    try {
      if (probe) await this.#verifyBrowserSeed(sb, probe);
      await this.#verifyDenyRead(sb);
    } catch (err) {
      await sb.close().catch(() => undefined);
      this.status = 'error';
      throw err;
    } finally {
      // The deny rule that named it stays in the profile; a nonexistent path is harmless.
      if (probe) rmSync(probe, { force: true });
    }
    this.#sb = sb;
    this.setWorkingDirectory(sb.worktreePath);
    this.status = 'running';
  }

  /**
   * Fail closed: a seeded Chromium only works when the provider applies extraProfile. If the probe
   * is still readable, it was ignored, and Chromium would hang on its Mach rendezvous port.
   */
  async #verifyBrowserSeed(sb: Sandbox, probe: string): Promise<void> {
    const r = await sb.exec(`/bin/bash -c ${shq(buildReadProbeScript([probe]))}`, { stdin: '' });
    const readable = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (r.exitCode !== 0 && readable.length === 0 && r.stderr.trim()) {
      throw new SandboxIsolationError(`extraProfile check failed to run: ${r.stderr.trim().slice(0, 300)}`);
    }
    if (readable.length > 0) {
      throw new SandboxIsolationError(
        `this seatbelt() ignored extraProfile, so Chromium could not register its Mach port and ` +
          `would hang; refusing to start a seeded session. Apply the extraProfile patch to ` +
          `@ai-hero/sandcastle, or drop browserSeed.`,
      );
    }
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
      const r = await sb.exec(`/bin/bash -c ${shq(buildCommandScript(command, args, secs, this.#binDir))}`, {
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
    return 'Commands run in a macOS Seatbelt sandbox. You can write only inside the working directory and a private TMPDIR and HOME. Files outside them, including the server user\'s home, are unreadable. `ps` is not permitted. The network is open. `mktemp` (with or without `-d`/`-t`) creates its file in `TMPDIR`.';
  }
}
