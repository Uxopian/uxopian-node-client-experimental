// Offline tests for the output modes (#95): agent detection (env × flags), compact vs pretty JSON,
// the JSON error envelope, and a few commands' result shape in agent mode via the real dispatcher
// (spawned with a temp UXC_HOME — hermetic, same pattern as test/cli.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { agentDetected, outputMode, out, errorEnvelope } from '../lib/output.mjs';
import { CLIENT_VERSION } from '../lib/version.mjs';

test('agentDetected: UXC_AGENT wins both ways, else CLAUDECODE=1', () => {
  assert.equal(agentDetected({}), false);
  assert.equal(agentDetected({ CLAUDECODE: '1' }), true);
  assert.equal(agentDetected({ CLAUDECODE: '0' }), false);
  assert.equal(agentDetected({ UXC_AGENT: '1' }), true);
  assert.equal(agentDetected({ UXC_AGENT: 'yes' }), true);
  assert.equal(agentDetected({ UXC_AGENT: '0', CLAUDECODE: '1' }), false, 'UXC_AGENT=0 disables detection');
  assert.equal(agentDetected({ UXC_AGENT: 'false', CLAUDECODE: '1' }), false);
  assert.equal(agentDetected({ UXC_AGENT: '', CLAUDECODE: '1' }), true, 'empty UXC_AGENT = unset');
});

test('outputMode: the env × flags matrix', () => {
  const human = { json: false, compact: false };
  const pretty = { json: true, compact: false };
  const compact = { json: true, compact: true };
  const pick = (m) => ({ json: m.json, compact: m.compact });
  const envs = { none: {}, agent: { UXC_AGENT: '1' }, claude: { CLAUDECODE: '1' }, off: { UXC_AGENT: '0', CLAUDECODE: '1' } };
  const matrix = [
    // [env, flags, expected]
    ['none', {}, human], ['none', { json: true }, pretty], ['none', { human: true }, human],
    ['agent', {}, compact], ['agent', { json: true }, compact], ['agent', { human: true }, human],
    ['claude', {}, compact], ['claude', { json: true }, compact], ['claude', { human: true }, human],
    ['off', {}, human], ['off', { json: true }, pretty], ['off', { human: true }, human],
    ['agent', { json: true, human: true }, human], // --human wins
  ];
  for (const [env, flags, want] of matrix) {
    assert.deepEqual(pick(outputMode(flags, envs[env])), want, `${env} ${JSON.stringify(flags)}`);
  }
});

function capture(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return logs;
}

test('out(): compact prints one line, pretty indents; human mode prints no result', () => {
  const obj = { a: 1, b: [1, 2] };
  const c = capture(() => out({}, { json: true, compact: true }).result(obj));
  assert.deepEqual(c, ['{"a":1,"b":[1,2]}']);
  const p = capture(() => out({}, { json: true, compact: false }).result(obj));
  assert.equal(p.length, 1);
  assert.match(p[0], /\n {2}"a": 1/);
  const h = capture(() => { const o = out({}, { json: false }); o.result(obj); o.line('hi'); });
  assert.deepEqual(h, ['hi']);
  // JSON mode: line/note/table are suppressed
  const j = capture(() => { const o = out({}, { json: true, compact: true }); o.line('x'); o.note('y'); o.table([{ a: 1 }], [{ key: 'a' }]); });
  assert.deepEqual(j, []);
});

test('out(flags) without a mode keeps the legacy behaviour (library callers ignore detection)', () => {
  const prev = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  try {
    assert.equal(out({}).json, false);
    assert.equal(out({ json: true }).json, true);
    assert.equal(out({ json: true }).compact, false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prev;
  }
});

test('errorEnvelope: ok:false + message + code + explanation + exitCode', () => {
  assert.deepEqual(errorEnvelope('boom'), { ok: false, error: 'boom', code: null, explanation: null, exitCode: 2 });
  const e = Object.assign(new Error('nope'), { code: 'E_LOCK', explanation: 'wait' });
  assert.deepEqual(errorEnvelope(e, 1), { ok: false, error: 'nope', code: 'E_LOCK', explanation: 'wait', exitCode: 1 });
});

test('every command module ends in a result() (help is the documented exemption)', () => {
  const dir = resolve('lib/commands');
  const missing = readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && f !== 'help.mjs')
    .filter((f) => !/\.result\(/.test(readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(missing, [], 'these commands print human output but never call out.result');
});

// ---- the real dispatcher ------------------------------------------------------------------
const UXC = resolve('bin/uxc.mjs');

/** Spawn uxc hermetically. `env` overrides; agent detection is OFF unless the test turns it on. */
function uxc(args, { env = {}, home } = {}) {
  const dir = home ?? mkdtempSync(join(os.tmpdir(), 'uxc-mode-'));
  try {
    const r = spawnSync(process.execPath, [UXC, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        UXC_HOME: dir, HOME: dir, USERPROFILE: dir,
        UXC_TARGET: '', UXC_URL: '', UXC_CORE_URL: '', UXC_AI_URL: '', UXC_GUI_URL: '',
        UXC_SCOPE: '', UXC_USER: '', UXC_PASSWORD: '',
        UXC_AGENT: '', CLAUDECODE: '',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally { if (!home) rmSync(dir, { recursive: true, force: true }); }
}

test('uxc version: human when piped without an agent; compact JSON under CLAUDECODE=1 / UXC_AGENT=1', () => {
  const piped = uxc(['version']); // spawnSync stdout is a pipe: non-TTY alone must NOT switch
  assert.equal(piped.status, 0);
  assert.equal(piped.stdout.trim(), CLIENT_VERSION);

  for (const env of [{ CLAUDECODE: '1' }, { UXC_AGENT: '1' }]) {
    const r = uxc(['version'], { env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `{"version":"${CLIENT_VERSION}"}\n`, JSON.stringify(env));
  }
});

test('uxc version: --human beats the agent; UXC_AGENT=0 disables; --json alone is pretty', () => {
  assert.equal(uxc(['version', '--human'], { env: { CLAUDECODE: '1' } }).stdout.trim(), CLIENT_VERSION);
  assert.equal(uxc(['version'], { env: { CLAUDECODE: '1', UXC_AGENT: '0' } }).stdout.trim(), CLIENT_VERSION);
  const pretty = uxc(['version', '--json']);
  assert.equal(pretty.stdout, `{\n  "version": "${CLIENT_VERSION}"\n}\n`);
  const compact = uxc(['version', '--json'], { env: { UXC_AGENT: '1' } });
  assert.equal(compact.stdout, `{"version":"${CLIENT_VERSION}"}\n`);
});

test('uxc target add + target ls in agent mode: one JSON line each, credentials masked', () => {
  const home = mkdtempSync(join(os.tmpdir(), 'uxc-mode-'));
  try {
    const env = { UXC_AGENT: '1' };
    const add = uxc(['target', 'add', 't1', '--core', 'http://h:8080/core', '--gui', 'http://h:8080/gui',
      '--ai', 'http://h:8081/ai', '--scope', 'S', '--user', 'u', '--password', 'secret'], { env, home });
    assert.equal(add.status, 0, add.stderr);
    const lines = add.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `stdout must be the result line only: ${add.stdout}`);
    const added = JSON.parse(lines[0]);
    assert.equal(added.name, 't1');
    assert.equal(added.scope, 'S');

    const ls = uxc(['target', 'ls'], { env, home });
    assert.equal(ls.status, 0, ls.stderr);
    assert.equal(ls.stdout.trim().split('\n').length, 1);
    const rows = JSON.parse(ls.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 't1');
    assert.equal(rows[0].user, 'u');
    assert.notEqual(rows[0].password, 'secret');
    assert.doesNotMatch(ls.stdout, /secret/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('errors in agent mode: {"ok":false,…} on stdout, the text still on stderr, exit code kept', () => {
  const r = uxc(['push', 'someid'], { env: { CLAUDECODE: '1' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no uxopian package here/);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, false);
  assert.match(env.error, /no uxopian package here/);
  assert.equal(env.exitCode, 2);
  assert.ok('code' in env && 'explanation' in env);

  const unknown = uxc(['frobnicate'], { env: { UXC_AGENT: '1' } });
  assert.equal(unknown.status, 2);
  assert.match(JSON.parse(unknown.stdout).error, /unknown command/);

  const human = uxc(['push', 'someid']);
  assert.equal(human.status, 2);
  assert.equal(human.stdout, '', 'human mode: errors stay on stderr only');
});

test('uxc help stays text in agent mode and documents the env vars', () => {
  const r = uxc(['help'], { env: { CLAUDECODE: '1' } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^uxc — /);
  assert.match(r.stdout, /UXC_AGENT=1/);
  assert.match(r.stdout, /--human/);
});
