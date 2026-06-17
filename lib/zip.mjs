// Minimal ZIP writer/reader. Zero deps: node:zlib deflate-raw + hand-rolled headers.
// Deterministic output: fixed DOS timestamp (2026-01-01), sorted entry names, fixed deflate level.
// No zip64, no encryption — packages sit far below the 4 GiB / 65535-entry limits (guarded).
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// CRC-32 (polynomial 0xEDB88320), table-driven.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 (fixed for determinism)
const DOS_TIME = 0; // 00:00:00
const SIG_LFH = 0x04034b50, SIG_CDH = 0x02014b50, SIG_EOCD = 0x06054b50;
const MAX32 = 0xffffffff;

function collectFiles(dir, prefix, excludes, out) {
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name; // forward-slash names always
    if (excludes.some((e) => rel === e || rel.startsWith(e + '/'))) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) collectFiles(abs, rel, excludes, out);
    else if (st.isFile()) out.push(rel);
  }
}

/** Zip a directory recursively into outFile. exclude = path prefixes relative to dir. */
export async function zipDir(dir, outFile, { exclude = [] } = {}) {
  const excludes = exclude.map((e) => String(e).replace(/\\/g, '/').replace(/\/+$/, ''));
  const files = [];
  collectFiles(dir, '', excludes, files);
  files.sort();
  if (files.length > 0xffff) throw new Error(`too many entries for non-zip64 zip: ${files.length}`);

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const rel of files) {
    const data = readFileSync(join(dir, rel));
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;
    if (data.length > MAX32 || payload.length > MAX32) throw new Error(`entry too large for non-zip64 zip: ${rel}`);
    const name = Buffer.from(rel, 'utf8');

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LFH, 0);
    lfh.writeUInt16LE(20, 4);       // version needed
    lfh.writeUInt16LE(0x0800, 6);   // flags: UTF-8 names
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    chunks.push(lfh, name, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(SIG_CDH, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, v2.0
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(0o100644 << 16 >>> 0, 38); // external attrs: regular file 0644
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    offset += lfh.length + name.length + payload.length;
    if (offset > MAX32) throw new Error('archive too large for non-zip64 zip');
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const all = Buffer.concat([...chunks, cd, eocd]);
  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(outFile, all);
  return { entries: files.length, bytes: all.length };
}

/** Extract a zip into destDir. Methods 0 (store) and 8 (deflate) only; path traversal rejected. */
export async function unzipTo(file, destDir) {
  const buf = readFileSync(file);
  // EOCD: scan back from the end (comment may pad up to 65535 bytes)
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
  }
  if (e < 0) throw new Error(`not a zip file (no end-of-central-directory): ${file}`);
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);

  const destRoot = resolve(destDir);
  mkdirSync(destRoot, { recursive: true });
  let entries = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDH) throw new Error('corrupt zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;

    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
        name.split('/').includes('..')) {
      throw new Error(`zip entry rejected (path traversal): ${name}`);
    }
    const dest = resolve(destRoot, name);
    if (dest !== destRoot && !dest.startsWith(destRoot + sep)) {
      throw new Error(`zip entry rejected (escapes destination): ${name}`);
    }
    if (name.endsWith('/')) { mkdirSync(dest, { recursive: true }); continue; }

    if (buf.readUInt32LE(lho) !== SIG_LFH) throw new Error(`corrupt zip: bad local header for ${name}`);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method}: ${name}`);
    if (data.length !== usize) throw new Error(`corrupt zip: size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`corrupt zip: CRC mismatch for ${name}`);

    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    entries++;
  }
  return { entries };
}
