// 记忆包 *.pmpack 的容器格式（§12.4.1）。Node 没有内置 zip，所以自己定一个简单的格式，只用 node:zlib 和 node:crypto：
//
//   文件 = 'PMPACK\0\1'（8 字节）+ 包头长度（uint32 BE）+ 包头 JSON（明文，只有种类、时间、包 id、加密参数）
//          + 正文 + [GCM 认证标签 16 字节，只在加密时]
//   正文 = gzip(容器)，加密时 = AES-256-GCM(gzip(容器))，AAD = 文件开头到包头结束的全部字节（包头也被认证）
//   容器 = 'PMC1' + manifest 长度（uint32）+ manifest JSON + 若干条目 [名字长度 uint16 + 名字 + 大小 uint64 + 内容] + 结束标记 uint16 0
//
//   - manifest 在最前面：rescan 只解开开头就能读到它，不用解完整个包。
//   - manifest.files 记每个条目的大小和 sha256；读的时候逐条核对，名字只许 [a-z0-9._-]（不会写到目录外面）。
//   - 写的时候先写 .partial，fsync 之后再改名：中途崩溃不会留下一个看起来完整的坏包。
//   - 全程流式：库有 1–1.5 GB/年，不整个读进内存。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAGIC = Buffer.from('PMPACK\0\x01', 'latin1');
export const PACK_EXT = '.pmpack';
const CONTAINER_MAGIC = Buffer.from('PMC1', 'latin1');
const TAG_BYTES = 16;
const IV_BYTES = 12;
const MAX_HEADER = 64 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
export const ENTRY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class PackError extends Error {
  /** @param {string} code  format / truncated / corrupt / decrypt / entry / sha256 / size */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'PackError';
    this.code = `PACK_${code.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    this.reason = code;
  }
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

/** 一个文件的大小和 sha256（流式）。 */
export async function fileDigest(file) {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) { h.update(chunk); size += chunk.length; }
  return { size, sha256: h.digest('hex') };
}

async function* containerChunks(manifest, entries) {
  const m = Buffer.from(JSON.stringify(manifest), 'utf8');
  yield Buffer.concat([CONTAINER_MAGIC, u32(m.length), m]);
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const size = fs.statSync(e.file).size;
    yield Buffer.concat([u16(name.length), name, u64(size)]);
    for await (const chunk of fs.createReadStream(e.file, { highWaterMark: 1 << 20 })) yield chunk;
  }
  yield u16(0);
}

/**
 * 写一个包。entries 的文件在写的过程中不能变（调用方给的都是暂存副本）。manifest.files 由这里按 entries 补齐。
 * @param {string} dest
 * @param {{header: object, manifest: object, entries: {name: string, file: string}[],
 *          encryption?: {key: Buffer, keyId: string, kdf: object}|null, level?: number}} p
 * @returns {Promise<{path: string, size: number, sha256: string, manifest: object}>}
 */
export async function writePack(dest, p) {
  for (const e of p.entries) if (!ENTRY_NAME_RE.test(e.name)) throw new PackError('entry', `条目名不合法：${e.name}`);
  const files = [];
  for (const e of p.entries) files.push({ name: e.name, ...(await fileDigest(e.file)) });
  const manifest = { ...p.manifest, files };
  const enc = p.encryption ? { alg: 'aes-256-gcm', keyId: p.encryption.keyId, kdf: p.encryption.kdf, iv: crypto.randomBytes(IV_BYTES).toString('base64') } : null;
  const header = { format: 1, ...p.header, encrypted: !!enc, ...(enc ? { enc } : {}) };
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  if (hb.length > MAX_HEADER) throw new PackError('format', '包头太大');
  const prefix = Buffer.concat([MAGIC, u32(hb.length), hb]);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const fileHash = crypto.createHash('sha256').update(prefix);
  let size = prefix.length;
  const tap = new Transform({
    transform(chunk, _enc, cb) { fileHash.update(chunk); size += chunk.length; cb(null, chunk); },
  });
  const cipher = enc ? crypto.createCipheriv('aes-256-gcm', p.encryption.key, Buffer.from(enc.iv, 'base64')) : null;
  if (cipher) cipher.setAAD(prefix);
  const out = fs.createWriteStream(tmp);
  try {
    out.write(prefix);
    const stages = [Readable.from(containerChunks(manifest, p.entries)), zlib.createGzip({ level: p.level ?? 6 })];
    if (cipher) stages.push(cipher);
    await pipeline(...stages, tap, out);
    if (cipher) {
      const tag = cipher.getAuthTag();
      fs.appendFileSync(tmp, tag);
      fileHash.update(tag);
      size += tag.length;
    }
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { out.destroy(); } catch { /* 尽力 */ }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { path: dest, size, sha256: fileHash.digest('hex'), manifest };
}

/**
 * 读包头（明文部分）。
 * @param {string} file
 * @returns {Promise<{header: any, prefix: Buffer, bodyStart: number, bodyEnd: number, size: number}>}
 */
export async function readPackHeader(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(12);
    const { bytesRead } = await fh.read(head, 0, 12, 0);
    if (bytesRead < 12 || !head.subarray(0, 8).equals(MAGIC)) throw new PackError('format', '不是记忆包');
    const hl = head.readUInt32BE(8);
    if (hl > MAX_HEADER || 12 + hl > size) throw new PackError('format', '包头长度不对');
    const hb = Buffer.alloc(hl);
    await fh.read(hb, 0, hl, 12);
    let header;
    try { header = JSON.parse(hb.toString('utf8')); } catch { throw new PackError('format', '包头不是 JSON'); }
    if (header?.format !== 1) throw new PackError('format', `不认识的包格式 ${header?.format}`);
    const bodyStart = 12 + hl;
    const bodyEnd = header.encrypted ? size - TAG_BYTES : size;
    if (bodyEnd <= bodyStart) throw new PackError('truncated', '包是空的');
    return { header, prefix: Buffer.concat([head, hb]), bodyStart, bodyEnd, size };
  } finally { await fh.close(); }
}

/** 解析容器的状态机：喂进解压后的字节，写出条目文件并逐条核对。 */
class ContainerParser {
  constructor({ outDir, manifestOnly }) {
    this.outDir = outDir;
    this.manifestOnly = manifestOnly;
    this.buf = Buffer.alloc(0);
    this.state = 'magic';
    this.manifest = null;
    this.files = {};
    this.entry = null;
    this.index = 0;
    this.done = false;
  }
  #take(n) { const b = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return b; }
  async push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.state === 'magic') {
        if (this.buf.length < 8) return;
        const m = this.#take(8);
        if (!m.subarray(0, 4).equals(CONTAINER_MAGIC)) throw new PackError('corrupt', '容器头不对');
        this.mlen = m.readUInt32BE(4);
        if (this.mlen > MAX_MANIFEST) throw new PackError('corrupt', 'manifest 太大');
        this.state = 'manifest';
      } else if (this.state === 'manifest') {
        if (this.buf.length < this.mlen) return;
        try { this.manifest = JSON.parse(this.#take(this.mlen).toString('utf8')); } catch { throw new PackError('corrupt', 'manifest 不是 JSON'); }
        if (!Array.isArray(this.manifest?.files)) throw new PackError('corrupt', 'manifest 缺 files');
        if (this.manifestOnly) { this.done = true; return; }
        this.state = 'head';
      } else if (this.state === 'head') {
        if (this.buf.length < 2) return;
        const nl = this.buf.readUInt16BE(0);
        if (nl === 0) {
          this.#take(2);
          if (this.index !== this.manifest.files.length) throw new PackError('entry', '条目比 manifest 少');
          this.state = 'end';
          continue;
        }
        if (this.buf.length < 2 + nl + 8) return;
        this.#take(2);
        const name = this.#take(nl).toString('utf8');
        const size = Number(this.#take(8).readBigUInt64BE(0));
        const want = this.manifest.files[this.index];
        if (!ENTRY_NAME_RE.test(name) || !want || want.name !== name) throw new PackError('entry', '条目和 manifest 对不上');
        if (want.size !== size) throw new PackError('size', `条目大小不对：${name}`);
        const file = this.outDir ? path.join(this.outDir, name) : null;
        this.entry = { name, left: size, hash: crypto.createHash('sha256'), fh: file ? await fsp.open(file, 'w') : null, file, want };
        this.state = 'data';
      } else if (this.state === 'data') {
        const e = this.entry;
        if (e.left > 0) {
          if (!this.buf.length) return;
          const part = this.#take(Math.min(e.left, this.buf.length));
          e.hash.update(part);
          if (e.fh) await e.fh.write(part);
          e.left -= part.length;
        }
        if (e.left > 0) return;
        if (e.fh) await e.fh.close();
        e.fh = null;
        if (e.hash.digest('hex') !== e.want.sha256) throw new PackError('sha256', `条目的 sha256 不对：${e.name}`);
        if (e.file) this.files[e.name] = e.file;
        this.entry = null;
        this.index += 1;
        this.state = 'head';
      } else {
        if (this.buf.length) throw new PackError('corrupt', '结束标记之后还有数据');
        this.done = true;
        return;
      }
    }
  }
  async abort() { try { await this.entry?.fh?.close(); } catch { /* 尽力 */ } }
}

/**
 * 读包：解压（必要时解密）并逐条核对，条目写进 outDir。manifestOnly=true 时只读到 manifest 为止（rescan 用，不核对认证标签）。
 * @param {string} file
 * @param {{outDir?: string, manifestOnly?: boolean, key?: Buffer|null}} [opt]
 * @returns {Promise<{header: any, manifest: any, files: Record<string, string>}>}
 */
export async function readPack(file, opt = {}) {
  const h = await readPackHeader(file);
  const { header } = h;
  if (header.encrypted && !opt.key) throw new PackError('decrypt', '包是加密的，需要密钥');
  if (opt.outDir) fs.mkdirSync(opt.outDir, { recursive: true });
  const parser = new ContainerParser({ outDir: opt.outDir ?? null, manifestOnly: !!opt.manifestOnly });
  const stages = [fs.createReadStream(file, { start: h.bodyStart, end: h.bodyEnd - 1, highWaterMark: 1 << 20 })];
  if (header.encrypted) {
    const tag = Buffer.alloc(TAG_BYTES);
    const fh = await fsp.open(file, 'r');
    try { await fh.read(tag, 0, TAG_BYTES, h.size - TAG_BYTES); } finally { await fh.close(); }
    const d = crypto.createDecipheriv('aes-256-gcm', opt.key, Buffer.from(header.enc.iv, 'base64'));
    d.setAAD(h.prefix);
    d.setAuthTag(tag);
    stages.push(d);
  }
  stages.push(zlib.createGunzip());
  try {
    await pipeline(...stages, async (source) => {
      for await (const chunk of source) {
        await parser.push(chunk);
        if (parser.done && parser.manifestOnly) return;
      }
    });
  } catch (e) {
    await parser.abort();
    if (parser.done && parser.manifestOnly) return { header, manifest: parser.manifest, files: {} };
    if (e instanceof PackError) throw e;
    if (/authenticate|auth tag|Unsupported state/i.test(String(e?.message))) throw new PackError('decrypt', '解密失败（密钥不对或包被改过）');
    if (e?.code === 'Z_DATA_ERROR' || e?.code === 'Z_BUF_ERROR' || e?.code === 'ERR_INVALID_STATE') throw new PackError('corrupt', '解压失败');
    throw new PackError('corrupt', e?.code ?? 'read-failed');
  }
  if (!parser.done) throw new PackError('truncated', '包不完整');
  return { header, manifest: parser.manifest, files: parser.files };
}
