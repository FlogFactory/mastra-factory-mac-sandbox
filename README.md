# mastra-factory-mac-sandbox

A session sandbox for a self-hosted [Mastra Factory](https://factory.mastra.ai) on a Mac. Every command an agent runs goes through [Sandcastle](https://github.com/ai-hero-dev/sandcastle)'s macOS Seatbelt provider, so agents:

- write only inside their session's worktree (plus a private `HOME` and `TMPDIR`);
- get a `mktemp` that works (macOS's own writes to a shared temp dir the sandbox denies), so tools that shell out to it keep working;
- **can't read** `~/.ssh`, your Factory's secrets and data dirs, or `.env` files in other projects;
- get an allow-listed environment, never the server's own; per-command credentials (Factory's GitHub token) arrive on stdin, never on a command line;
- keep the network, so `git clone`, `npm install` and `pnpm install` work;
- run through an optional execution slot with memory, disk and load checks.

It exists because Mastra's own `LocalSandbox` Seatbelt mode has no deny-read paths ([mastra-ai/mastra#31128](https://github.com/mastra-ai/mastra/issues/31128)). If that lands upstream, you may not need this.

**macOS only** (macOS 14 or later). It never falls back to running commands unsandboxed: on another OS, `start()` throws.

## Install

```bash
npm install mastra-factory-mac-sandbox
```

Requires Node 22.18 or later, `@mastra/factory` 0.30+ and `@mastra/core` 1.85+ (peer dependencies).

## Use it

Factory's docs put a custom sandbox in `src/mastra/sandbox.ts`, imported by `src/mastra/index.ts` as the `sandbox` option. Replace that file with:

```ts
import { seatbeltFactorySandbox } from 'mastra-factory-mac-sandbox';

export const sandbox = seatbeltFactorySandbox({
  factoryDirs: ['/path/to/your/factory/data', '/path/to/your/factory/secrets'],
});
```

In `src/mastra/index.ts`, pass it as the Factory's `sandbox` option in place of the template's `LocalFactorySandbox`.

On each session's `start()`, the sandbox runs a probe inside Seatbelt and **refuses to start** if any deny path (the defaults plus `factoryDirs` and `denyRead`) can be read.

### `mktemp`

macOS `mktemp` without a template ignores `$TMPDIR`: it writes to the per-user temp dir (`/var/folders/…/T`), which the sandbox denies because that dir is shared. Any tool that shells out to bare `mktemp` therefore failed inside a session; in Factory 0.30 that is the Changes panel's diffs and file contents.

Each session gets a read-only `mktemp` shim at `<sessionRoot>/.bin`, first on `PATH`. Bare `mktemp`, `mktemp -d`, `mktemp -t prefix` (and `-q`/`-u`) create their file under the session's private `TMPDIR`. Anything else — an explicit template, `-p`, `--suffix`, `--`, an unknown flag — goes to the system `mktemp` unchanged, so the shim never changes a call it doesn't understand.

It is a convenience, not a security boundary: a command that sets `PATH` itself, calls `/usr/bin/mktemp` directly, or overwrites the shim's directory would bypass it. The shim dir is mounted read-only, so the session can't rewrite the shim, and the shared per-user temp dir stays denied. Point `MKTEMP_REAL` at another binary to replace the one it delegates to (that is the test seam).

## Options

`seatbeltFactorySandbox(options)` returns a `MastraFactorySandboxConfig` (Factory's `sandbox` callback). All options are optional.

| Option | Default | What it does |
|---|---|---|
| `root` | `~/.factory-sandboxes` | Parent dir for per-session roots. Avoid spaces. Must not overlap a deny path. |
| `commandTimeoutMs` | 15 min | Upper bound for any one command, even if Factory asks for longer. |
| `env` | `LANG=en_US.UTF-8`, `GIT_TERMINAL_PROMPT=0` | Non-secret env every command gets. `HOME`, `TMPDIR` and `XDG_RUNTIME_DIR` (set to `TMPDIR`, so pnpm's locks land there instead of `/tmp`) always point at the sandbox's private dirs. |
| `passEnv` | `[]` | Names copied from the server's env. Nothing else from the server's env reaches a command. |
| `factoryDirs` | `[]` | Your Factory's data and secrets dirs. Proved unreadable on start. |
| `denyRead` | `[]` | More paths to prove unreadable, added to the defaults: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.kube`, `~/.config/gh`, `~/.config/gcloud` and the server's `./.env`. |
| `pnpmSeed` | none | A host dir holding a pnpm `store/` and `cache/`, for example filled by `pnpm fetch --store-dir <seed>/store --cache-dir <seed>/cache` outside the sandbox. Each session gets its own copy-on-write clone at `<sessionRoot>/.pnpm` (one `clonefileat` per subtree, `store/` and `cache/`, and no extra disk until either side changes), and pnpm uses it through `pnpm_config_store_dir` and `pnpm_config_cache_dir`. Packages missing from the seed download into the session's copy; nothing flows back. A restarted session keeps its copy, and a subtree the seed could not provide is retried on the next start. When the seed cannot be used, `start()` warns once with the reason (`pnpmSeedResult` has it too) instead of leaving the session cold without a trace. The seed must be on the same APFS volume as `root`; otherwise sessions start with an empty copy. Must not overlap a deny path. |
| `browserSeed` | none | A host dir holding Playwright's `browsers/`, filled with `PLAYWRIGHT_BROWSERS_PATH=<seed> npx playwright install chromium-headless-shell` outside the sandbox. Each session gets a copy-on-write clone at `<sessionRoot>/.browsers`, mounted read-only, and Playwright uses it through `PLAYWRIGHT_BROWSERS_PATH`; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` keeps an unseeded session from downloading. `start()` warns once when the seed cannot be used (`browserSeedResult` has it too) and the session still starts. Needs the `extraProfile` patch (see [Chromium](#chromium)). Must not overlap a deny path. |
| `limiter` | one shared `ResourceLimiter` | The execution slot (below). Pass `ResourceLimiterOptions`, your own `ExecutionLimiter`, or `false` for none. |

### Chromium

Playwright downloads a browser into its cache the first time a test launches one. Inside the sandbox that cache is unreadable (the server's `~/.cache/ms-playwright` is outside it) and the download fails, so a headless test either hangs or dies. `browserSeed` fixes that the same way `pnpmSeed` fixes installs:

```sh
# On the host, once:
export PLAYWRIGHT_BROWSERS_PATH=/path/to/browser-seed
npx playwright install chromium-headless-shell
```

Pass that dir as `browserSeed`. Each session gets a copy-on-write clone at `<sessionRoot>/.browsers`, mounted read-only, and Playwright uses it through `PLAYWRIGHT_BROWSERS_PATH`; `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is always set when the option is, so a session without the seed reports a missing browser instead of downloading one. The seed itself is never mounted, and must be on the same APFS volume as `root` and outside every deny path.

Chromium also needs to register and look up its Mach rendezvous port, which the default profile denies, so `browserSeed` appends two rules to the Seatbelt profile through Sandcastle's `seatbelt({ extraProfile })`. That option is **not** in `@ai-hero/sandcastle@0.14.0`: it comes from a patch in the consumer repo. Without the patch, a seeded `start()` proves the rules were ignored and refuses to start with a clear `SandboxIsolationError`, rather than letting Chromium hang.

Both rules are process-wide name prefixes, so any process in any session can register or look up under them; see `THREAT_MODEL.md`.

### The execution slot

A sandbox takes a slot for the length of one command, not the session, so a session waiting hours for a plan approval never blocks other work. The default `ResourceLimiter` is in-process:

- `concurrency`: commands at once, default 1;
- `admission`: a command waits while free memory is under 2 GiB, free disk (on the volume holding `root`) is under 5 GiB, or the 1-minute load is at or above the CPU count;
- waiters are served by priority, then age; aborting a command's signal removes it from the queue;
- `onBlocked(reason)`: called once per distinct reason; defaults to `console.warn`.

To share a slot across processes, implement `ExecutionLimiter` (`acquire(req) → Promise<{ release() }>`) over something they share, such as a SQLite table, and pass it as `limiter`.

### Lower level

`new SeatbeltSandbox({ sessionId, ...options, limiter })` is the sandbox class itself (a `MastraSandbox`). It also exposes `sessionRoot`, `denyReadPaths`, `pnpmSeedResult` and `browserSeedResult` (whether `start()` seeded each copy, and why not) and, after `destroy()`, `preservedWorktreePath` when Sandcastle kept a worktree with uncommitted changes. Sandcastle keeps the session root on disk; clean up `root` yourself when sessions are done.

## How it compares

Tested on macOS with Factory 0.30:

✅ safe or working · ❌ unsafe or broken · ⚠️ open by design (see [THREAT_MODEL.md](THREAT_MODEL.md))

| Check | This package | `LocalFactorySandbox` (template default) | Mastra `LocalSandbox`, `isolation: 'seatbelt'` |
|---|---|---|---|
| Write outside the session folder | ✅ blocked | ❌ allowed | ✅ blocked |
| Server env in commands | ✅ not passed | ❌ passed | ✅ not passed |
| Read the secrets dir, `~/.ssh`, other `.env` | ✅ blocked | ❌ allowed | ❌ **allowed** |
| `npm` | ✅ works | ✅ works | ❌ fails (can't write its cache) |
| `git clone` over HTTPS | ✅ works | ✅ works | ✅ works |
| Network | ⚠️ open | ⚠️ open | ⚠️ open |
| Per-command env | ✅ stdin, not argv | ⚠️ process env | ⚠️ process env |

`LocalFactorySandbox` runs commands directly on the host with no OS isolation. Mastra's Seatbelt mode allows all reads ("macOS sandbox limitation" in its profile) and restricts only writes. Sandcastle's profile denies reads by default and allows the system toolchain, your `PATH` dirs and the worktree.

## What it doesn't protect

Network egress, CPU and memory abuse beyond the admission checks, and kernel or Seatbelt bugs. See [THREAT_MODEL.md](THREAT_MODEL.md). Apple marks `sandbox-exec` deprecated; it still works on current macOS.

## Develop

```bash
npm install
```

```bash
npm test
```

```bash
npm run check
```

`npm test` runs unit tests everywhere and the Seatbelt isolation tests on macOS (they need network for `git clone` and `npm view`). Report security problems as described in [SECURITY.md](SECURITY.md).

To release: bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, tag `vX.Y.Z`, then `npm publish` on a Mac (`prepublishOnly` runs the typecheck and all tests, including the isolation tests; `prepack` builds `dist/`).

## License

MIT. Sandcastle is MIT; Mastra is Apache-2.0 and is a peer dependency, not bundled.
