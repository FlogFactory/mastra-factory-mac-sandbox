# Threat model

## Who and what

- **Asset:** the Mac running a self-hosted Mastra Factory, and the secrets on it: the Factory's own secrets and data (GitHub App key, auth secrets, its database), the server user's SSH keys and cloud credentials, and other projects' `.env` files.
- **Adversary:** an agent session that runs commands the owner didn't intend, because of a bad plan, a prompt injection in an issue, a dependency's install script, or a malicious repo it cloned.
- **Goal of this package:** whatever a session runs, it can't read those secrets and can't change anything outside its own worktree.

## What it protects

| Threat | How |
|---|---|
| Reading the Factory's secrets or data | Sandcastle's Seatbelt profile denies file reads by default. Allowed: system dirs (`/bin`, `/usr`, `/System`, `/Library`, `/opt`, parts of `/private`), each `PATH` dir (never the home dir or an ancestor of it), the worktree, and a private `HOME` and `TMPDIR`. `start()` proves `factoryDirs`, `denyRead` and the defaults are unreadable, and refuses to start otherwise. |
| Reading `~/.ssh`, cloud credentials, other `.env` files | Same deny-by-default rule; the home dir isn't readable. |
| Writing outside the worktree (planting a launch agent, editing another repo, changing the Factory) | Writes are allowed only in the worktree, its git dirs, the private `HOME` and `TMPDIR`, and (with `pnpmSeed`) the session's own pnpm copy at `<sessionRoot>/.pnpm`. Git control files Sandcastle marks read-only stay read-only. |
| Poisoning other sessions' packages (with `pnpmSeed`) | The seed is never mounted: the host clones it into each session's own `.pnpm` before the sandbox starts, so a session can neither read nor write the seed, and what it writes into its copy reaches no other session. Whoever fills the seed decides what sessions start with, so fill it outside any sandbox from trusted lockfiles. A seed that overlaps a deny path is refused. |
| Secrets leaking through the environment | Commands get only `env`, `passEnv` names, Factory's runtime env and the per-command env. The server's own env never reaches them. |
| Secrets leaking through `ps` | Per-command env is written to the command's stdin as `export` lines, never put in argv. |
| Escaping through a container engine | Sandcastle denies the Docker, Colima, OrbStack, Lima and Rancher sockets and dirs. |
| Signalling host processes | Seatbelt allows signals only within the same sandbox. |
| Runaway commands | Each command has a timeout (default 15 min, capped even if Factory asks for longer), and its process group is killed when it exits or times out. |
| Many heavy commands at once | The execution slot limits concurrency and waits while free memory, free disk or load are short. |

## What it doesn't protect

- **Network egress.** The network is open, including the host's `localhost`, because agents need `git` and package registries. Anything a command *can* read, it can send anywhere; the read restrictions are what keep secrets in. Services on `localhost` (including the Factory's own API) are reachable; protect them with their own auth.
- **What the sandbox is given.** Factory's per-command env (for example a short-lived GitHub token) is readable by that command by design. Scope those credentials narrowly.
- **CPU and memory abuse beyond admission checks.** Admission runs *before* a command starts. A command that then uses all memory or CPU isn't throttled; only the timeout stops it. There are no cgroups on macOS.
- **Disk filling** inside the worktree or private temp dir.
- **Readable system and toolchain dirs.** Anything you put under `/opt`, `/Library`, `/usr/local` or a `PATH` dir is readable. Don't keep secrets there; the start-up probe catches it if you list them in `denyRead`.
- **Seeing other processes.** Seatbelt can't fully hide the host's process list.
- **Kernel, Seatbelt or Sandcastle bugs.** This is a policy enforced by the macOS kernel. A kernel exploit escapes it. Keep macOS updated.
- **A compromised server process.** The Factory itself runs unsandboxed; this only isolates the commands it runs for agents.
- **Other operating systems.** It runs only on macOS 14+, and never falls back to unsandboxed execution.

## `sandbox-exec` is deprecated

Apple marks `sandbox-exec` and the Seatbelt profile language deprecated, and documents neither. They still work on current macOS and are used by several developer tools. If Apple removes them, `start()` will throw (Sandcastle checks Seatbelt is usable and never falls back). The CI runs the isolation tests on `macos-latest` so a breaking macOS change shows up there.

## Tested

`test/isolation.test.ts` proves, against real Seatbelt, using temporary fixture dirs:

- writes outside the worktree fail, including under the home dir;
- a fake Factory secrets dir can't be listed or read;
- a fake `~/.ssh`-style dir under the home dir can't be read, and the real `~/.ssh` can't be listed (output discarded inside the sandbox);
- `.env` files in other dirs can't be read;
- the server's env isn't passed, and per-command env never shows in `ps`;
- `git clone` over HTTPS and `npm view` work;
- `start()` refuses when a deny path is readable;
- with `pnpmSeed`, the session writes only its own copy, the seed stays unreadable and unchanged, and a seed inside a deny path is refused.
