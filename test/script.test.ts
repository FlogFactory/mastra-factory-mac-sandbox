import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { safeId, shq, buildCommandScript, buildEnvExports, pickEnv } from '../src/script.ts';
import { buildReadProbeScript } from '../src/script.ts';

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
