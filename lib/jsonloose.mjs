// Tolerant JSON for MODEL OUTPUT (#122). An agent asked for JSON answers with a ```json fence, a
// sentence before it, a trailing comma, “smart quotes” or 'single quotes' — the content is right,
// the formatting slipped, and a strict JSON.parse fails a test that only checks the content.
//
// parseLooseJson(text) -> { value, repaired: [notes] } returns the FIRST JSON value of the text:
//   1. the whole text, strict JSON.parse            -> repaired: []   (nothing was touched)
//   2. the first ``` fenced block (```json or bare)  -> strict, else tolerant
//   3. the first `{` / `[` that parses tolerantly    (prose before/after ignored)
// The tolerant parser is a small recursive-descent reader — NEVER eval/Function — that accepts, and
// notes, what models commonly emit: trailing commas, smart-quote and single-quote string delimiters
// (a single quote closes only where a delimiter follows, so `'it's'` stays one string — an
// unclosable one is refused as ambiguous), unquoted identifier keys, raw line breaks inside a string,
// Python True/False/None. An embedded SCALAR is never guessed ("the answer is 42" is not JSON);
// a scalar is only returned when the whole text (or a fence) is that scalar.
// Throws an Error whose message says why (no JSON found / where the repair gave up).
//
// matchLoose(re, text) -> { pass, via: 'text'|'json'|'json-repaired'|null, repaired }
// The `--expect` content assertion: the regex on the raw text first; then on the strict JSON
// re-serialization (compact and 2-space pretty); only then on the loosely-parsed value. `via` and
// `repaired` say which path matched, so a pass that needed a repair is REPORTED, never silent.

const SMART_OPEN = { '“': ['”', '“', '"'], '”': ['”'], '‘': ['’', "'"], '’': ['’'] };
const MAX_CANDIDATES = 200;

/** Tolerant parse of ONE value starting at src[start] -> { value, end, notes:Set }. Throws SyntaxError. */
function tolerantAt(src, start) {
  let i = start;
  const notes = new Set();
  const fail = (msg) => { throw new SyntaxError(`${msg} at offset ${i}`); };
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const ID = /[A-Za-z_$][\w$-]*/y;
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const delimAfter = (j) => {
    while (j < src.length && /\s/.test(src[j])) j++;
    return j >= src.length || ',:}]'.includes(src[j]);
  };

  const put = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });

  function str() {
    const open = src[i];
    let closers;
    let single = false;
    if (open === '"') closers = ['"'];
    else if (open === "'") { closers = ["'"]; single = true; notes.add('single-quoted strings'); }
    else if (SMART_OPEN[open]) {
      closers = SMART_OPEN[open];
      single = open === '‘' || open === '’';
      notes.add('smart quotes as string delimiters');
    } else fail('expected a string');
    i++;
    let out = '';
    for (;;) {
      if (i >= src.length) fail(single ? 'unterminated single-quoted string (ambiguous apostrophe)' : 'unterminated string');
      const c = src[i];
      if (c === '\\') {
        const e = src[i + 1];
        const map = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (e !== undefined && Object.hasOwn(map, e)) { out += map[e]; i += 2; continue; }
        notes.add('unknown escape kept literally');
        out += e ?? '';
        i += 2;
        continue;
      }
      // a single quote only closes where a delimiter follows: `'it's fine'` keeps its apostrophe
      if (closers.includes(c) && (!single || delimAfter(i + 1))) { i++; return out; }
      if (c === '\n' || c === '\r') notes.add('raw line break inside a string');
      out += c;
      i++;
    }
  }

  function value() {
    ws();
    const c = src[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"' || c === "'" || SMART_OPEN[c]) return str();
    NUM.lastIndex = i;
    const n = NUM.exec(src);
    if (n && n[0] !== '-') { i += n[0].length; return Number(n[0]); }
    ID.lastIndex = i;
    const w = ID.exec(src);
    if (w) {
      const lit = { true: true, false: false, null: null };
      const py = { True: true, False: false, None: null };
      if (Object.hasOwn(lit, w[0])) { i += w[0].length; return lit[w[0]]; }
      if (Object.hasOwn(py, w[0])) { i += w[0].length; notes.add('Python literals (True/False/None)'); return py[w[0]]; }
    }
    return fail(`unexpected ${c === undefined ? 'end of text' : JSON.stringify(c)}`);
  }

  function object() {
    i++; // {
    const obj = {};
    let first = true;
    for (;;) {
      ws();
      if (src[i] === '}') {
        if (!first) notes.add('trailing commas');
        i++;
        return obj;
      }
      let key;
      const c = src[i];
      if (c === '"' || c === "'" || SMART_OPEN[c]) key = str();
      else {
        ID.lastIndex = i;
        const w = ID.exec(src);
        if (!w) fail('expected a key');
        key = w[0];
        i += key.length;
        notes.add('unquoted keys');
      }
      ws();
      if (src[i] !== ':') fail('expected ":"');
      i++;
      put(obj, key, value());
      ws();
      if (src[i] === ',') { i++; first = false; continue; }
      if (src[i] === '}') { i++; return obj; }
      fail('expected "," or "}"');
    }
  }

  function array() {
    i++; // [
    const arr = [];
    let first = true;
    for (;;) {
      ws();
      if (src[i] === ']') {
        if (!first) notes.add('trailing commas');
        i++;
        return arr;
      }
      arr.push(value());
      ws();
      if (src[i] === ',') { i++; first = false; continue; }
      if (src[i] === ']') { i++; return arr; }
      fail('expected "," or "]"');
    }
  }

  const v = value();
  return { value: v, end: i, notes };
}

/** Strict, then tolerant, over a whole (sub)text that should BE one value. -> { value, notes } | throws */
function parseWhole(s) {
  try { return { value: JSON.parse(s), notes: [] }; } catch { /* tolerant below */ }
  const t = s.trim();
  const r = tolerantAt(t, 0);
  if (t.slice(r.end).trim()) throw new SyntaxError(`unexpected text after the value at offset ${r.end}`);
  return { value: r.value, notes: [...r.notes] };
}

/** First embedded object/array of `s` that parses tolerantly. -> { value, notes, start, end } | throws */
function firstEmbedded(s) {
  let firstErr = null;
  let tried = 0;
  for (let k = 0; k < s.length && tried < MAX_CANDIDATES; k++) {
    if (s[k] !== '{' && s[k] !== '[') continue;
    tried++;
    try {
      const r = tolerantAt(s, k);
      return { value: r.value, notes: [...r.notes], start: k, end: r.end };
    } catch (e) { firstErr ??= e; }
  }
  if (firstErr) throw new Error(`found a JSON-looking value but could not repair it: ${firstErr.message}`);
  throw new Error('no JSON object or array found in the text');
}

/**
 * The first JSON value of a model's output. -> { value, repaired: string[] } — `repaired` is empty
 * when the text was strict JSON as a whole, otherwise it names every tolerance applied. Never evals.
 */
export function parseLooseJson(text) {
  const s = String(text ?? '');
  if (!s.trim()) throw new Error('empty text — no JSON to parse');
  try { return { value: JSON.parse(s), repaired: [] }; } catch { /* not strict as a whole */ }

  const fence = /```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)```/.exec(s);
  if (fence) {
    const body = fence[2];
    const tag = fence[1] ? `\`\`\`${fence[1]}` : '```';
    let r;
    try { r = parseWhole(body); } catch {
      try { r = firstEmbedded(body); } catch (e) { throw new Error(`a ${tag} fenced block was found but ${e.message}`); }
    }
    return { value: r.value, repaired: [`unwrapped a ${tag} fenced block`, ...r.notes] };
  }

  const trimmed = s.trim();
  if (trimmed !== s) {
    try { return { value: JSON.parse(trimmed), repaired: [] }; } catch { /* fall through */ }
  }
  const r = firstEmbedded(s);
  const notes = [];
  if (s.slice(0, r.start).trim() || s.slice(r.end).trim()) notes.push('ignored prose around the JSON');
  return { value: r.value, repaired: [...notes, ...r.notes] };
}

/**
 * The `--expect` content assertion with formatting tolerance. Strict paths first, loose last.
 * -> { pass, via: 'text'|'json'|'json-repaired'|null, repaired: string[] }
 */
export function matchLoose(re, text) {
  const rx = re instanceof RegExp ? re : new RegExp(re);
  const test = (s) => { rx.lastIndex = 0; return rx.test(s); };
  const s = String(text ?? '');
  if (test(s)) return { pass: true, via: 'text', repaired: [] };
  const forms = (v) => [JSON.stringify(v), JSON.stringify(v, null, 2)];
  let strict;
  try { strict = JSON.parse(s.trim()); } catch { strict = undefined; }
  if (strict !== undefined) {
    if (forms(strict).some(test)) return { pass: true, via: 'json', repaired: [] };
    return { pass: false, via: null, repaired: [] }; // strict JSON already: nothing to repair
  }
  let loose;
  try { loose = parseLooseJson(s); } catch { return { pass: false, via: null, repaired: [] }; }
  if (forms(loose.value).some(test)) return { pass: true, via: 'json-repaired', repaired: loose.repaired };
  return { pass: false, via: null, repaired: [] };
}
