# Changelog

All notable changes to this package. It follows [Semantic Versioning](https://semver.org).

## 0.2.1 (2026-11-23)

- Fix: `mktemp` failed inside sessions ("mkstemp failed on /var/folders/… Operation not permitted"), which broke anything that shells out to it — in Factory 0.30 that is the Changes panel's diffs and file contents. macOS `mktemp` ignores `$TMPDIR` when no template is given and writes to the per-user temp dir, which the sandbox denies. Each session now gets a read-only `mktemp` shim at `<sessionRoot>/.bin`, put first on `PATH`; bare `mktemp`, `mktemp -d` and `mktemp -t prefix` create their file in the session's private `TMPDIR`, and an explicit template, `-p`, `--suffix` or `--` is handed to the system `mktemp` unchanged. No new write access: the shim dir is mounted read-only and the shared per-user temp dir stays denied.

## 0.2.0 (2026-11-23)

- Fix: `pnpm install` failed in every session with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` ("Operation not permitted"). pnpm 12 keeps its lock dirs in `$XDG_RUNTIME_DIR`, else a hard-coded `/tmp`, which the sandbox can't write. Every command now gets `XDG_RUNTIME_DIR` set to its private `TMPDIR`. No new write access.
- New `pnpmSeed` option: warm pnpm stores. Each session gets a copy-on-write clone of a host-filled pnpm store and metadata cache at `<sessionRoot>/.pnpm`, so its first `pnpm install` reuses packages instead of downloading them all, and the store no longer takes gigabytes of real disk per session. `store/` and `cache/` are cloned and published one at a time, so a subtree the seed could not provide is retried on the next start instead of being mistaken for an existing copy, and a seed that cannot be used is reported on `start()` rather than leaving the session cold without a trace. Measured in a real session on a 1,009-package workspace: `pnpm install` went from 3m 2.5s (and 2.4 GB of store per session) to 3.9s, plus 7.4s to clone at start, with next to no extra disk.

## 0.1.1 (2026-11-22)

- README: the comparison table leads with this package and lists the template default before Mastra's Seatbelt mode, with status markers.
- Tests: the macOS isolation tests skip with a clear reason when they're already inside a Seatbelt sandbox that refuses to nest (for example a Factory session), instead of failing. They never skip in CI.
- Releases are published from GitHub Actions with npm trusted publishing, so each version carries npm provenance.

## 0.1.0 (2026-11-22)

First version.

- `seatbeltFactorySandbox(options)`: a Mastra Factory `sandbox` callback.
- `SeatbeltSandbox`: a `MastraSandbox` that runs every command through Sandcastle's Seatbelt provider. Writes only in the session worktree; deny-by-default reads; per-command env on stdin; allow-listed env; open network.
- Fails closed: `start()` proves `~/.ssh`, other credential stores, the server's `.env`, `factoryDirs` and `denyRead` are unreadable, or refuses to start.
- `ResourceLimiter`: an optional in-process execution slot with free memory, free disk and load admission checks, behind the `ExecutionLimiter` interface.
- Unit tests, and macOS integration tests for the isolation table.
