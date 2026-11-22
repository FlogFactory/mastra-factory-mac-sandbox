# AGENTS.md

`mastra-factory-mac-sandbox` is a small TypeScript library: a Sandcastle + macOS Seatbelt session sandbox for self-hosted Mastra Factory. Factory owners drop it into their `src/mastra/sandbox.ts`. It is a security boundary, so isolation comes before convenience.

## Layout
- `src/sandbox.ts`: `SeatbeltSandbox`, the `MastraSandbox` that runs every command through Sandcastle's Seatbelt provider, and the start-up deny-read check.
- `src/factory.ts`: `seatbeltFactorySandbox()`, the one-call Factory `sandbox` callback.
- `src/limiter.ts`: the `ExecutionLimiter` interface and the in-process `ResourceLimiter` (memory, disk, load admission).
- `src/script.ts`: pure helpers that build the bash script and env exports.
- `src/index.ts`: the public API. Anything exported here is public; change it only when the issue asks.
- Tests: `test/`, using `node:test`. `isolation.test.ts` runs only on macOS and proves the isolation table against real Seatbelt, using temporary fixture dirs; the rest are unit tests that run anywhere.
- Docs: `README.md`, `THREAT_MODEL.md`, `SECURITY.md`, `CHANGELOG.md`.

## Commands
Node 22.18 or later (TypeScript runs directly through Node's type stripping). Install with `npm ci`.
- `npm test`: all tests. The macOS isolation tests need network (`git clone`, `npm view`). Run it before opening a PR.
  - Inside a Factory session the isolation tests skip themselves: macOS won't nest Seatbelt, so they can't run in Factory's own sandbox. CI's `Isolation tests (macOS)` job is the proof for a change; check it passed on the PR's head. Never work around the skip (no weaker profile, no running outside the sandbox).
- `npm run check`: typecheck (`tsc --noEmit`). Run it before opening a PR.
- `npm run build`: compile to `dist/` for publishing.

These are the only commands. Don't add tools or dependencies unless the issue asks for them.

## Conventions
- ESM, strict TypeScript, erasable syntax only (no enums, no parameter properties); relative imports end in `.ts`.
- Match the surrounding code; there is no formatter. Comments explain why, not what.
- Never weaken isolation to make a test pass. A change that widens what a command can read, write or see needs a matching update to `THREAT_MODEL.md` and an isolation test.
- Never put secrets in argv, logs or test output. Tests use fixture secrets in temporary dirs, never real credential files.
- When behaviour changes, update its docs and `CHANGELOG.md`, and add or adjust a test in the same change.
- Keep changes to what the issue asks for; mention anything else you notice in the PR instead of changing it.

## How to work
<!-- Keep this section as is: it hooks the Factory's skills into plans. -->
- **Plans name the skill the build follows.**
  - A bug: `diagnosing-bugs`. The plan includes the reproduction command, its failing output, and the ranked hypotheses.
  - New or changed behaviour: `tdd`. The plan names the seams under test.
  - A new module or a changed interface: `codebase-design`, and only then.
- Write the pull request with `file-pr`.
- Use the terms in `CONTEXT.md` if the repo has one. If your change adds a domain term, add it there in the same PR.

## Don't touch
- `LICENSE`, `SECURITY.md`, `.github/workflows/`, `package-lock.json` (except through `npm install` when the issue adds a dependency), `dist/`.

## Pull requests
- One issue per PR. Reference the issue (`Fixes #N`) in the description.
- `main` is protected: a PR needs an approving review from the owner, who merges.
