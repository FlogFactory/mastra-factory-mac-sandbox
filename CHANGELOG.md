# Changelog

All notable changes to this package. It follows [Semantic Versioning](https://semver.org).

## Unreleased

- Fix: `pnpm install` failed in every session with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` ("Operation not permitted"). pnpm 12 keeps its lock dirs in `$XDG_RUNTIME_DIR`, else a hard-coded `/tmp`, which the sandbox can't write. Every command now gets `XDG_RUNTIME_DIR` set to its private `TMPDIR`. No new write access.
- New `pnpmSeed` option: warm pnpm stores. Each session gets a copy-on-write clone of a host-filled pnpm store and metadata cache at `<sessionRoot>/.pnpm`, so its first `pnpm install` reuses packages instead of downloading them all, and the store no longer takes gigabytes of real disk per session. Measured on a 1,009-package workspace: cold install 19s and 2.4 GB per session; clone 8.5s plus install 3s, and next to no extra disk.

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
