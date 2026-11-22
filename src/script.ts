/**
 * Small, pure helpers for building the command a sandbox runs. Kept separate so they can be
 * unit-tested on any OS.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote a string for bash. */
export const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A path- and git-ref-safe version of a Factory session id. */
export function safeId(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  if (!s) throw new Error(`unusable session id: ${JSON.stringify(id)}`);
  return s;
}

/**
 * The bash script for one command.
 *
 * Env arrives on stdin as `export` lines, so values never appear on a command line (which any
 * local user can read with `ps`). It is read from fd 0 with `cat`, because Seatbelt denies opening
 * `/dev/stdin` by path. An optional timeout is a perl `alarm` that kills the command.
 *
 * `XDG_RUNTIME_DIR` is set to the private `TMPDIR` after the env, so nothing can point it
 * elsewhere. Tools that keep runtime locks there otherwise fall back to a hard-coded `/tmp`, which
 * the sandbox can't write: pnpm 12 fails every install with ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK.
 */
export function buildCommandScript(command: string, args: readonly string[], timeoutSecs: number): string {
  const argv = [command, ...args].map(shq).join(' ');
  const run = timeoutSecs > 0
    ? `exec /usr/bin/perl -e 'alarm shift; exec @ARGV or die $!' ${timeoutSecs} ${argv}`
    : `exec ${argv}`;
  return `eval "$(cat)"; export XDG_RUNTIME_DIR="$TMPDIR"; ${run} </dev/null`;
}

/** `export NAME='value'` lines for every valid name with a string value. */
export function buildEnvExports(env: Record<string, string | undefined>): string {
  return Object.entries(env)
    .filter((e): e is [string, string] => ENV_NAME.test(e[0]) && typeof e[1] === 'string')
    .map(([k, v]) => `export ${k}=${shq(v)}`)
    .join('\n');
}

/** Copy only the allow-listed names from `source` (normally `process.env`). */
export function pickEnv(names: readonly string[], source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw new Error(`invalid env name in allow-list: ${JSON.stringify(name)}`);
    const v = source[name];
    if (typeof v === 'string') out[name] = v;
  }
  return out;
}

/**
 * A script that tries to read each path and prints the ones it could read, one per line.
 * Paths that don't exist are skipped. Output is paths only, never contents.
 */
export function buildReadProbeScript(paths: readonly string[]): string {
  return paths
    .map((p) => {
      const q = shq(p);
      return `if [ -d ${q} ]; then ls ${q} >/dev/null 2>&1 && echo ${q}; elif [ -e ${q} ]; then head -c 1 ${q} >/dev/null 2>&1 && echo ${q}; fi`;
    })
    .join('\n');
}
