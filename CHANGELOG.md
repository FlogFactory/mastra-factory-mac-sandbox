# Changelog

All notable changes to this package. It follows [Semantic Versioning](https://semver.org).

## 0.1.0 (2026-11-22)

First version.

- `seatbeltFactorySandbox(options)`: a Mastra Factory `sandbox` callback.
- `SeatbeltSandbox`: a `MastraSandbox` that runs every command through Sandcastle's Seatbelt provider. Writes only in the session worktree; deny-by-default reads; per-command env on stdin; allow-listed env; open network.
- Fails closed: `start()` proves `~/.ssh`, other credential stores, the server's `.env`, `factoryDirs` and `denyRead` are unreadable, or refuses to start.
- `ResourceLimiter`: an optional in-process execution slot with free memory, free disk and load admission checks, behind the `ExecutionLimiter` interface.
- Unit tests, and macOS integration tests for the isolation table.
