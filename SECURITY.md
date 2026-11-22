# Security policy

This package is a security boundary, so reports are welcome.

## Reporting a problem

Please **don't open a public issue** for a way around the sandbox. Use GitHub's private vulnerability reporting instead: the repository's **Security** tab, then **Report a vulnerability**.

Include:
- macOS version, Node version, and the versions of this package, `@ai-hero/sandcastle` and `@mastra/factory`;
- what a sandboxed command could do that it shouldn't (read, write, env, process), and the smallest command that shows it;
- whether the problem is in this package, in Sandcastle's Seatbelt profile, or in macOS.

You should get a reply within a week. Fixes for confirmed problems ship as a patch release with a CHANGELOG entry crediting you, unless you'd rather not be named.

Problems in Sandcastle's profile itself also go to Sandcastle's maintainers; we'll help pass them on.

## In scope

- Reading a path the threat model says is unreadable, or writing outside the worktree.
- Server env or per-command secrets reaching a command line, a log, or another session.
- `start()` succeeding when a deny path is readable.

Out of scope: the limits listed under "What it doesn't protect" in [THREAT_MODEL.md](THREAT_MODEL.md), such as network egress.

## Supported versions

Only the latest release gets fixes.
