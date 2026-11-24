/**
 * Warm seeds. The host keeps one (a pnpm `store/` and `cache/`, filled by `pnpm fetch` outside any
 * sandbox, or Playwright's `browsers/`), and each session gets its own copy-on-write clone of it.
 * Sessions write only their copy; nothing flows back into the seed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Clone a directory tree on APFS in one `clonefileat(2)` call: near-instant per file and no extra
 * disk until either side changes. `cp -c` and `ditto --clone` clone file by file, which is several
 * times slower for a pnpm store's ~100k files. Node has no binding, so this goes through the
 * system perl's `syscall`. `dst` must not exist; its parent must.
 */
export function cloneTree(src: string, dst: string): void {
  const SYS_clonefileat = 462; // xnu bsd/kern/syscalls.master, stable since macOS 10.12
  const AT_FDCWD = -2;
  try {
    execFileSync('/usr/bin/perl', ['-e', `syscall(${SYS_clonefileat}, ${AT_FDCWD}, $ARGV[0], ${AT_FDCWD}, $ARGV[1], 0) == 0 or die "$!\\n"`, src, dst], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    const why = String((err as { stderr?: Buffer }).stderr ?? '').trim() || (err as Error).message;
    throw new Error(`clonefileat ${src} -> ${dst}: ${why}`);
  }
}

const SUBTREES = ['cache', 'store'] as const;

export interface SeedResult {
  /** True when at least one subtree came from the seed during this call. */
  seeded: boolean;
  /** Why a subtree was not seeded, or `already present` when there was nothing to do. */
  reason?: string;
}

/**
 * Give a session its pnpm `store/` and `cache/` under `copyDir`, cloned from `seedDir` when the
 * session does not have that subtree yet. A subtree with content is kept: a restarted session keeps
 * the packages it added. A subtree left empty by a failed clone is retried on the next start, and
 * without a usable seed the dirs start empty, so pnpm downloads as usual.
 */
export function seedPnpmCopy(seedDir: string, copyDir: string): SeedResult {
  mkdirSync(dirname(copyDir), { recursive: true });
  mkdirSync(copyDir, { recursive: true });

  // Content means "this subtree is the session's now", whether it came from the seed or from the
  // session's own installs. An empty dir is what a failed clone leaves behind, so it gets retried.
  const pending = SUBTREES.filter((sub) => isEmpty(join(copyDir, sub)));
  if (pending.length === 0) return { seeded: false, reason: 'already present' };

  let seed: string;
  try {
    // Resolve once, so a seed rebuilt and swapped in meanwhile can't mix two versions.
    seed = realpathSync(seedDir);
  } catch (err) {
    for (const sub of pending) mkdirSync(join(copyDir, sub), { recursive: true });
    return { seeded: false, reason: `unseeded: ${(err as Error).message}` };
  }

  let seeded = false;
  const failures: string[] = [];
  for (const sub of pending) {
    const target = join(copyDir, sub);
    const staged = `${target}.partial`;
    try {
      rmSync(staged, { recursive: true, force: true });
      cloneTree(join(seed, sub), staged);
      // Publish only a complete subtree, and only over the empty dir checked above.
      rmSync(target, { recursive: true, force: true });
      renameSync(staged, target);
      seeded = true;
    } catch (err) {
      rmSync(staged, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      failures.push(`${sub}: ${(err as Error).message}`);
    }
  }
  return failures.length === 0 ? { seeded } : { seeded, reason: `unseeded: ${failures.join('; ')}` };
}

/** True when the path is missing or an empty directory. */
function isEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    // Unreadable means someone else's data: never treat it as ours to replace.
    return false;
  }
}

/**
 * Give a session Playwright's browsers: `copyDir` (the session's `.browsers`) is cloned from
 * `<seedDir>/browsers` when the session does not have it yet. A `copyDir` with content is kept, so a
 * restarted session keeps its copy. Without a usable seed the dir starts empty and Playwright
 * reports a missing browser instead of downloading one.
 */
export function seedBrowsersCopy(seedDir: string, copyDir: string): SeedResult {
  mkdirSync(dirname(copyDir), { recursive: true });
  if (!isEmpty(copyDir)) return { seeded: false, reason: 'already present' };

  let seed: string;
  try {
    // Resolve once, so a seed rebuilt and swapped in meanwhile can't mix two versions.
    seed = realpathSync(seedDir);
  } catch (err) {
    mkdirSync(copyDir, { recursive: true });
    return { seeded: false, reason: `unseeded: ${(err as Error).message}` };
  }

  // An empty dir is what a failed clone leaves behind; publishing over it is safe.
  const staged = `${copyDir}.partial`;
  try {
    rmSync(staged, { recursive: true, force: true });
    cloneTree(join(seed, 'browsers'), staged);
    rmSync(copyDir, { recursive: true, force: true });
    renameSync(staged, copyDir);
    return { seeded: true };
  } catch (err) {
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(copyDir, { recursive: true });
    return { seeded: false, reason: `unseeded: browsers: ${(err as Error).message}` };
  }
}

