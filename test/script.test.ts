import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeId, shq, buildCommandScript, buildEnvExports, buildMktempShim, pickEnv } from '../src/script.ts';
import { buildReadProbeScript } from '../src/script.ts';

/**
 * Run the generated shim with a stub `mktemp` that prints the argv it was handed, so the rewrite is
 * checked on any OS. Returns the argv lines.
 */
function runMktempShim(args: readonly string[], env: Record<string, string | undefined> = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'mfms-shim-'));
  try {
    const shim = join(dir, 'mktemp');
    writeFileSync(shim, buildMktempShim(), { mode: 0o755 });
    const stub = join(dir, 'real-mktemp');
    writeFileSync(stub, `#!/bin/bash\nif (( $# )); then printf '%s\\n' "$@"; fi\n`, { mode: 0o755 });
    const out = execFileSync('/bin/bash', [shim, ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', TMPDIR: '/private/session/tmp', MKTEMP_REAL: stub, ...env },
    });
    return out.split('\n').slice(0, -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('session ids become safe path and branch names', () => {
  assert.equal(safeId('sess/01:test'), 'sess-01-test');
  assert.equal(safeId('../x'), 'x');
  assert.throws(() => safeId('...'));
  assert.equal(safeId('a'.repeat(300)).length, 100);
});

test('shq quotes for bash, including single quotes', () => {
  const nasty = `a b'c"$(id);\``;
  assert.equal(execFileSync('/bin/bash', ['-c', `printf %s ${shq(nasty)}`], { encoding: 'utf8' }), nasty);
});

test('the command script reads env from stdin and passes args literally', () => {
  assert.equal(buildCommandScript('echo', ["it's"], 0), `eval "$(cat)"; export XDG_RUNTIME_DIR="$TMPDIR"; exec 'echo' 'it'\\''s' </dev/null`);
  assert.match(buildCommandScript('sleep', ['5'], 3), /alarm shift; exec @ARGV or die \$!' 3 'sleep' '5'/);
  const out = execFileSync('/bin/bash', ['-c', buildCommandScript('/bin/sh', ['-c', 'echo "$TOK|$1"', 'x', 'a;$(id)'], 0)], {
    input: buildEnvExports({ TOK: "s3cr'et" }) + '\n',
    encoding: 'utf8',
  });
  assert.equal(out, "s3cr'et|a;$(id)\n");
});

test('XDG_RUNTIME_DIR is always the private TMPDIR, even if the env names another dir', () => {
  // pnpm 12 keeps its lock dirs in $XDG_RUNTIME_DIR, else /tmp, which the sandbox can't write.
  const out = execFileSync('/bin/bash', ['-c', buildCommandScript('/bin/sh', ['-c', 'echo "$XDG_RUNTIME_DIR"'], 0)], {
    input: buildEnvExports({ XDG_RUNTIME_DIR: '/tmp' }) + '\n',
    env: { PATH: process.env.PATH, TMPDIR: '/private/sandbox/tmp' },
    encoding: 'utf8',
  });
  assert.equal(out, '/private/sandbox/tmp\n');
});

test('env exports drop invalid names and undefined values', () => {
  assert.equal(buildEnvExports({ OK: 'v', 'BAD-NAME': 'x', 'X;rm': 'y', U: undefined }), `export OK='v'`);
});

test('pickEnv copies only allow-listed names', () => {
  assert.deepEqual(pickEnv(['A', 'MISSING'], { A: '1', SECRET: '2' }), { A: '1' });
  assert.throws(() => pickEnv(['A=B'], {}), /invalid env name/);
});

test('the read probe names readable paths and skips missing ones, never printing contents', () => {
  const script = buildReadProbeScript(['/usr/bin', '/definitely/not/here', '/etc/hosts']);
  const out = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), ['/usr/bin', '/etc/hosts']);
});

test('the mktemp shim keeps template-less and -t calls inside TMPDIR', () => {
  const tmp = '/private/session/tmp';
  const cases: [string, string[], string[]][] = [
    ['no arguments', [], [`${tmp}/tmp.XXXXXX`]],
    ['-d', ['-d'], ['-d', `${tmp}/tmp.XXXXXX`]],
    ['-q', ['-q'], ['-q', `${tmp}/tmp.XXXXXX`]],
    ['-u', ['-u'], ['-u', `${tmp}/tmp.XXXXXX`]],
    ['-dq', ['-dq'], ['-dq', `${tmp}/tmp.XXXXXX`]],
    ['-t prefix', ['-t', 'probe'], [`${tmp}/probe.XXXXXX`]],
    ['-d -t prefix', ['-d', '-t', 'probe'], ['-d', `${tmp}/probe.XXXXXX`]],
    ['-t with Xs', ['-t', 'probe.XXXXXX'], [`${tmp}/probe.XXXXXX`]],
    ['-t with more Xs', ['-t', 'probe.XXXXXXX'], [`${tmp}/probe.XXXXXXX`]],
    ['prefix is not expanded', ['-t', '$(id)'], [`${tmp}/$(id).XXXXXX`]],
    ['explicit template', ['/tmp/x.XXXXXX'], ['/tmp/x.XXXXXX']],
    ['-d with explicit template', ['-d', '/tmp/x.XXXXXX'], ['-d', '/tmp/x.XXXXXX']],
    ['-p is not ours', ['-p', '/tmp'], ['-p', '/tmp']],
    ['--suffix is not ours', ['--suffix=.bak', 'x.XXXXXX'], ['--suffix=.bak', 'x.XXXXXX']],
    ['-- is not ours', ['--', 'x.XXXXXX'], ['--', 'x.XXXXXX']],
    ['-t with a slash', ['-t', 'a/b'], ['-t', 'a/b']],
    ['-t empty', ['-t', ''], ['-t', '']],
    ['-t without a value', ['-t'], ['-t']],
    ['-t jammed together', ['-tprobe'], ['-tprobe']],
    ['unknown flag', ['-z'], ['-z']],
  ];
  for (const [name, args, expected] of cases) assert.deepEqual(runMktempShim(args), expected, name);
});

test('the mktemp shim defers to the system mktemp when TMPDIR is unset', () => {
  assert.deepEqual(runMktempShim([], { TMPDIR: undefined }), []);
  assert.deepEqual(runMktempShim(['-d'], { TMPDIR: undefined }), ['-d']);
});

test('the command script puts the session shim dir first on PATH, after the env', () => {
  assert.equal(
    buildCommandScript('mktemp', [], 0, "/tmp/shims it's"),
    `eval "$(cat)"; export XDG_RUNTIME_DIR="$TMPDIR"; export PATH='/tmp/shims it'\\''s':"$PATH"; exec 'mktemp' </dev/null`,
  );
  const out = execFileSync('/bin/bash', ['-c', buildCommandScript('/bin/sh', ['-c', 'printf %s "$PATH"'], 0, '/private/session/bin')], {
    input: buildEnvExports({ PATH: '/usr/bin:/bin' }) + '\n',
    env: { PATH: process.env.PATH, TMPDIR: '/private/session/tmp' },
    encoding: 'utf8',
  });
  // A caller-set PATH cannot drop the shim dir.
  assert.equal(out, '/private/session/bin:/usr/bin:/bin');
});

