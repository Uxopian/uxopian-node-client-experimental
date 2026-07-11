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

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const DIRECTIVE = /^[ \t]*\/\/[ \t]*@include[ \t]+(\S+)[ \t]*$/;
const MAX_DEPTH = 8;

export function hasIncludeDirective(bytes) {
  return String(bytes).split('\n').some((l) => DIRECTIVE.test(l));
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
    out.push(`// >>> uxc:include ${rel} (expanded — edit that file, not this block)`);
    out.push(String(inner).replace(/\n$/, ''));
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
