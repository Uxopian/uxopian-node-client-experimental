// uxc @include — build-time script composition for fd.handler / fd.script sources.
//
// A source line of the form
//     // @include <relpath>
// is replaced by the referenced file's content, wrapped in BEGIN/END markers. Expansion
// happens in readLocal, so every uxc view of the resource (status hash, diff, push, export)
// sees the EXPANDED script and the server receives a self-contained body — no runtime
// coupling, nothing new to install server-side. <relpath> is resolved against the directory
// of the file containing the directive and must stay inside the package root.
//
// Recursion is allowed (an included file may itself @include) with cycle detection and a
// depth cap. A missing include file is a hard error — silently pushing a half-expanded
// handler would be a debugging nightmare.
//
// writeLocal counterpart: isExpansionOf(localBytes, serverBytes, filePath, pkgDir) lets pull
// skip overwriting a directive-bearing source whose expansion already equals the server copy
// (otherwise every pull would flatten the directive into expanded text and kill the sharing).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';

// `// @include <relpath> strip` (0.15+): the included file is shipped WITHOUT its full-line comments
// (lines that are only a `//` comment) and with runs of blank lines collapsed. Motivation: the FD
// server refuses handler scripts over ~1 MB (nginx 413 on /core/rest/files/tmp) and a package whose
// shared libraries carry heavy design commentary hits that ceiling with room to spare in code alone.
// The source files keep every comment; only the expanded body loses them. Inline comments (code
// then `//`) are never touched — a `//` inside a string literal would make stripping unsafe.
//
// 0.17+: `strip` also drops FULL-LINE BLOCK comments — a `/* … */` (JSDoc included) that opens at the
// start of a line and whose first `*/` is the last thing on its line. That shape cannot sit inside a
// single- or double-quoted string, so no tokenizer is needed; a block followed by code on its
// closing line, an unclosed block, or a block opened after code are left exactly as they are.
// Same limit as the `//` strip: a template-literal line that starts with `/*` or `//` is treated as a
// comment (ES5 handler code has no template literals; a browser part that embeds CSS in one loses
// only CSS comments). (Measured on the po package: 20 kB of `/** … */` per handler that the line strip kept.)
const DIRECTIVE = /^[ \t]*\/\/[ \t]*@include[ \t]+(\S+)(?:[ \t]+(strip))?[ \t]*\r?$/; // \r?: CRLF-authored files must not push the directive VERBATIM
const MAX_DEPTH = 8;
export const INCLUDE_STRIP_MIN_CLIENT = '0.15.0';
/** The client version whose `strip` also drops full-line block comments. A package that relies on
 *  it to fit under the server body limit should pin minClientVersion >= this (an older client
 *  composes a larger body, never a broken one). */
export const INCLUDE_STRIP_BLOCKS_MIN_CLIENT = '0.17.0';

const MARKER_LINE = /^[ \t]*\/\/ (>>>|<<<) uxc:include /;

/** Index of the line that closes the block comment opening at the START of `lines[start]`, when that
 *  block is FULL-LINE: its first `*\/` is followed by nothing but blanks. -1 otherwise (block followed
 *  by code, or never closed) — the caller then keeps the lines untouched. */
function fullLineBlockEnd(lines, start) {
  const open = lines[start].indexOf('/*');
  for (let j = start; j < lines.length; j++) {
    const close = lines[j].indexOf('*/', j === start ? open + 2 : 0);
    if (close < 0) continue;
    return /^[ \t]*\r?$/.test(lines[j].slice(close + 2)) ? j : -1;
  }
  return -1;
}

/** Drop full-line `//` comments and full-line block comments, collapse blank-line runs.
 *  uxc:include markers are kept (they delimit blocks for pull's isExpansionOf and for a human
 *  reading the server copy). */
export function stripFullLineComments(text) {
  const lines = String(text).split('\n');
  const out = [];
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*\/\//.test(line) && !MARKER_LINE.test(line)) continue;
    if (/^[ \t]*\/\*/.test(line)) {
      const end = fullLineBlockEnd(lines, i);
      if (end >= 0) { i = end; continue; }
    }
    if (/^[ \t]*\r?$/.test(line)) { blank++; if (blank > 1) continue; } else blank = 0;
    out.push(line);
  }
  return out.join('\n');
}

/** The client version that introduced @include. A package whose sources carry directives must
 *  pin minClientVersion >= this — OLDER clients expand nothing and push the directive line
 *  verbatim, a silently broken script (mp publish lints for it). */
export const INCLUDE_MIN_CLIENT = '0.12.0';

export function hasIncludeDirective(bytes) {
  return String(bytes).split('\n').some((l) => DIRECTIVE.test(l));
}

/** Package-relative paths of script/handler sources carrying @include directives — the mp
 *  publish lint. Only fd/scripts and fd/handlers are scanned: that is where expansion happens
 *  (an @include string anywhere else is inert content, not a directive). */
export function includeDirectiveFiles(pkgDir) {
  const out = [];
  for (const top of ['fd/scripts', 'fd/handlers']) {
    (function walk(d) {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d).sort()) {
        const abs = join(d, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith('.js')) {
          try { if (hasIncludeDirective(readFileSync(abs))) out.push(relative(pkgDir, abs)); } catch { /* unreadable — export will surface it */ }
        }
      }
    })(join(pkgDir, top));
  }
  return out.sort();
}

/**
 * Expand all @include directives in `bytes` (Buffer|string). `filePath` is the absolute path
 * of the file the bytes came from; `pkgDir` the absolute package root. Returns a Buffer.
 * Throws Error('include: …') on missing file, escape from pkgDir, cycle, or depth overflow.
 */
export function expandIncludes(bytes, filePath, pkgDir, _stack = []) {
  const text = String(bytes);
  if (!text.includes('@include')) return Buffer.isBuffer(bytes) ? bytes : Buffer.from(text);
  if (_stack.length >= MAX_DEPTH) throw new Error(`include: depth > ${MAX_DEPTH} at ${filePath}`);
  const out = [];
  for (const line of text.split('\n')) {
    const m = DIRECTIVE.exec(line);
    if (!m) { out.push(line); continue; }
    const target = resolve(dirname(filePath), m[1]);
    if (relative(resolve(pkgDir), target).startsWith('..')) {
      throw new Error(`include: ${m[1]} escapes the package root (from ${filePath})`);
    }
    if (_stack.includes(target)) {
      throw new Error(`include: cycle — ${[..._stack, filePath, target].map((p) => relative(pkgDir, p)).join(' -> ')}`);
    }
    if (!existsSync(target)) {
      throw new Error(`include: ${m[1]} not found (from ${relative(pkgDir, filePath)})`);
    }
    const inner = expandIncludes(readFileSync(target), target, pkgDir, [..._stack, filePath]);
    const rel = relative(pkgDir, target);
    const body = m[2] === 'strip' ? stripFullLineComments(String(inner)) : String(inner);
    out.push(`// >>> uxc:include ${rel} (expanded${m[2] === 'strip' ? ', comments stripped' : ''} — edit that file, not this block)`);
    out.push(body.replace(/\n$/, ''));
    out.push(`// <<< uxc:include ${rel}`);
  }
  return Buffer.from(out.join('\n'));
}

/**
 * Pull-guard: true when the local file at `filePath` carries @include directives AND its
 * expansion equals `serverBytes` — i.e. the incoming write would only flatten the directive.
 */
export function isExpansionOf(serverBytes, filePath, pkgDir) {
  try {
    if (!existsSync(filePath)) return false;
    const local = readFileSync(filePath);
    if (!String(local).includes('@include')) return false;
    const expanded = expandIncludes(local, filePath, pkgDir);
    return Buffer.compare(expanded, Buffer.isBuffer(serverBytes) ? serverBytes : Buffer.from(serverBytes)) === 0;
  } catch {
    return false;
  }
}
