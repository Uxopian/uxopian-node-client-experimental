// Offline unit tests for lib/variables.mjs — package variables (DESIGN §21).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  declaredVariables, resolveValues, scanPlaceholders, renderDir, lintVariables,
  variablesTable, publicValues, PLACEHOLDER_RE,
} from '../lib/variables.mjs';

const MANIFEST = {
  code: 'uxoai',
  variables: {
    gatewayUrl: { description: 'gateway as seen from FD', example: 'http://gateway-service:8085', required: true, pattern: '^https?://' },
    theme: { description: 'ui theme', default: 'light' },
    apiHint: { description: 'sensitive-ish hint', sensitive: true, default: null, required: false },
  },
};

function tmpl(files) {
  const dir = mkdtempSync(join(os.tmpdir(), 'uxc-vars-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test('declaredVariables: required derives from missing default; explicit flags win', () => {
  const d = declaredVariables(MANIFEST);
  assert.equal(d.gatewayUrl.required, true);
  assert.equal(d.theme.required, false);        // has a default
  assert.equal(d.apiHint.required, false);      // explicit required:false despite null default
  assert.equal(d.apiHint.sensitive, true);
});

test('resolveValues: precedence --var > --var-file > env > default; validation; unknown', () => {
  const env = { UXC_VAR_GATEWAY_URL: 'http://from-env:1', UXC_VAR_THEME: 'env-theme' };
  const r1 = resolveValues(MANIFEST, { env });
  assert.equal(r1.values.gatewayUrl, 'http://from-env:1'); // env fills required
  assert.equal(r1.values.theme, 'env-theme');              // env beats default
  const r2 = resolveValues(MANIFEST, { vars: { gatewayUrl: 'http://cli:2' }, varFile: { gatewayUrl: 'http://file:3', theme: 'dark' }, env });
  assert.equal(r2.values.gatewayUrl, 'http://cli:2');      // --var wins
  assert.equal(r2.values.theme, 'dark');                   // var-file beats env
  const r3 = resolveValues(MANIFEST, { env: {} });
  assert.deepEqual(r3.missing, ['gatewayUrl']);            // required, nothing supplied
  assert.equal(r3.values.theme, 'light');                  // default applies
  const r4 = resolveValues(MANIFEST, { vars: { gatewayUrl: 'ftp://nope' }, env: {} });
  assert.equal(r4.invalid[0].name, 'gatewayUrl');          // pattern violation
  const r5 = resolveValues(MANIFEST, { vars: { gatewayUrl: 'http://x', typo: '1' }, env: {} });
  assert.deepEqual(r5.unknown, ['typo']);
});

test('render: substitutes everywhere except manifest/registry; two-phase abort writes NOTHING', () => {
  const dir = tmpl({
    'uxopian-project.json': JSON.stringify(MANIFEST),
    'registry.json': '{"resources":[]}',
    'assets/infra/Gateway.xml': '<url>{{uxc:gatewayUrl}}</url>',
    'fd/scripts/x/x.js': 'const EP = "{{uxc:gatewayUrl}}"; const T = `${SCOPE}`; // ${} untouched',
  });
  try {
    const r = renderDir(dir, { gatewayUrl: 'http://real:8085' });
    assert.equal(r.replaced, 2);
    assert.match(readFileSync(join(dir, 'assets/infra/Gateway.xml'), 'utf8'), /http:\/\/real:8085/);
    const js = readFileSync(join(dir, 'fd/scripts/x/x.js'), 'utf8');
    assert.match(js, /http:\/\/real:8085/);
    assert.match(js, /\$\{SCOPE\}/);            // JS template literals SURVIVE (the ${} collision case)
    // strict abort: unresolved -> throws AND writes nothing
    writeFileSync(join(dir, 'fd/a.json'), '{"v":"{{uxc:gatewayUrl}}","w":"{{uxc:ghost}}"}');
    assert.throws(() => renderDir(dir, { gatewayUrl: 'http://x' }), /unresolved package variables[\s\S]*ghost/);
    assert.match(readFileSync(join(dir, 'fd/a.json'), 'utf8'), /\{\{uxc:gatewayUrl\}\}/); // untouched
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lint: undeclared placeholders, unused declarations, forbidden files', () => {
  const dir = tmpl({
    'uxopian-project.json': JSON.stringify({ ...MANIFEST, description: 'oops {{uxc:gatewayUrl}}' }),
    'fd/y.txt': 'uses {{uxc:gatewayUrl}} and {{uxc:notDeclared}}',
  });
  try {
    const l = lintVariables(MANIFEST, dir);
    assert.deepEqual(l.undeclared, ['notDeclared']);
    assert.deepEqual(l.unused, ['apiHint', 'theme']);
    assert.deepEqual(l.forbidden, ['uxopian-project.json']); // placeholder in the manifest = error
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sensitive values never leak into tables or public views', () => {
  const values = { gatewayUrl: 'http://x', apiHint: 'SUPERSECRET' };
  const table = variablesTable(MANIFEST, values);
  assert.ok(!JSON.stringify(table).includes('SUPERSECRET'));
  assert.equal(table.find((r) => r.name === 'apiHint').value, '(sensitive)');
  const pub = publicValues(MANIFEST, values);
  assert.equal(pub.apiHint, '__sensitive__');
  assert.equal(pub.gatewayUrl, 'http://x');
});

test('placeholder regex: exact syntax only — no collision with ${}, {{ }}, or [[${…}]]', () => {
  const hits = (s) => [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
  assert.deepEqual(hits('a {{uxc:one}} b {{uxc:two_2}} c'), ['one', 'two_2']);
  assert.deepEqual(hits('`${SCOPE}` [[${flowerDocsService.extract(x)}]] {{ .Values.x }} {{uxc:}} {{uxc: spaced}}'), []);
});
