/**
 * Warm pnpm stores. The host keeps a seed (a pnpm `store/` and `cache/`, filled by `pnpm fetch`
 * outside any sandbox), and each session gets its own copy-on-write clone of it. Sessions write only
 * their copy; nothing flows back into the seed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
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

export interface SeedResult {
  seeded: boolean;
  reason?: string;
}

/**
 * Give a session its pnpm `store/` and `cache/` under `copyDir`, cloned from `seedDir` when the
 * session has none yet. A copy that already exists is kept: a restarted session keeps the packages
 * it added. Without a usable seed (none built yet, another volume), the dirs start empty and pnpm
 * downloads as usual.
 */
export function seedPnpmCopy(seedDir: string, copyDir: string): SeedResult {
  if (existsSync(join(copyDir, 'store'))) return { seeded: false, reason: 'already present' };
  mkdirSync(dirname(copyDir), { recursive: true });
  mkdirSync(copyDir, { recursive: true });
  let result: SeedResult = { seeded: true };
  try {
    // Resolve once, so a seed rebuilt and swapped in meanwhile can't mix two versions.
    const seed = realpathSync(seedDir);
    for (const sub of ['cache', 'store']) cloneTree(join(seed, sub), join(copyDir, sub));
  } catch (err) {
    result = { seeded: false, reason: `unseeded: ${(err as Error).message}` };
  }
  for (const sub of ['cache', 'store']) mkdirSync(join(copyDir, sub), { recursive: true });
  return result;
}
