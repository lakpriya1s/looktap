// AFC (Apple File Conduit): the file service lockdown offers over the phone's media folder (com.apple.afc), an app's
// container (house_arrest) and its crash reports (crashreportcopymobile). Used to stage an app for installation_proxy
// and to read crash reports and app files.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { lockdown, plistChannel } from './lockdown.js';

const MAGIC = Buffer.from('CFA6LPAA', 'latin1');
const OP = { STATUS: 1, DATA: 2, READ_DIR: 3, REMOVE_PATH: 8, MAKE_DIR: 9, GET_FILE_INFO: 10, FILE_OPEN: 13, FILE_OPEN_RES: 14, FILE_READ: 15, FILE_WRITE: 16, FILE_CLOSE: 20, REMOVE_ALL: 34 };
const ERRORS = { 7: 'invalid argument', 8: 'not found', 9: 'is a directory', 10: 'permission denied', 11: 'service not connected', 19: 'not a directory', 21: 'no space left', 23: 'busy' };
const CHUNK = 1 << 20;

const u64 = (...ns) => {
  const b = Buffer.alloc(8 * ns.length);
  ns.forEach((n, i) => b.writeBigUInt64LE(BigInt(n), 8 * i));
  return b;
};
const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');

export class AFC {
  constructor(sock) {
    this.sock = sock;
    this.n = 0;
    this.buf = Buffer.alloc(0);
    this.waiting = [];
    sock.on('data', (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      while (this.buf.length >= 40) {
        const total = Number(this.buf.readBigUInt64LE(8)), head = Number(this.buf.readBigUInt64LE(16));
        if (this.buf.length < total) break;
        const op = Number(this.buf.readBigUInt64LE(32));
        const reply = { op, header: this.buf.subarray(40, head), data: Buffer.from(this.buf.subarray(head, total)) };
        this.buf = this.buf.subarray(total);
        this.waiting.shift()?.resolve(reply);
      }
    });
    sock.on('close', () => this.waiting.splice(0).forEach((w) => w.reject(new Error('the device closed the AFC connection'))));
    sock.on('error', () => {});
  }

  /** One request; resolves to its reply, rejecting on an error status. */
  request(op, header = Buffer.alloc(0), data = Buffer.alloc(0)) {
    const h = Buffer.concat([MAGIC, u64(40 + header.length + data.length, 40 + header.length, this.n++, op)]);
    return new Promise((resolve, reject) => {
      this.waiting.push({
        resolve: (r) => {
          if (r.op === OP.STATUS) {
            const code = Number(r.header.length >= 8 ? r.header.readBigUInt64LE(0) : r.data.readBigUInt64LE(0));
            if (code) return reject(Object.assign(new Error(`AFC: ${ERRORS[code] || `error ${code}`}`), { code }));
          }
          resolve(r);
        },
        reject,
      });
      this.sock.write(Buffer.concat([h, header, data]));
    });
  }

  async list(path) {
    const r = await this.request(OP.READ_DIR, cstr(path));
    return r.data.toString('utf8').split('\0').filter((n) => n && n !== '.' && n !== '..');
  }

  /** { st_size, st_ifmt ('S_IFDIR' | 'S_IFREG' | …), st_mtime (ns) … }, or null when it isn't there. */
  async info(path) {
    try {
      const parts = (await this.request(OP.GET_FILE_INFO, cstr(path))).data.toString('utf8').split('\0');
      const o = {};
      for (let i = 0; i + 1 < parts.length; i += 2) o[parts[i]] = parts[i + 1];
      return o;
    } catch (e) {
      if (e.code === 8) return null;
      throw e;
    }
  }

  mkdir(path) {
    return this.request(OP.MAKE_DIR, cstr(path));
  }

  async removeAll(path) {
    await this.request(OP.REMOVE_ALL, cstr(path)).catch((e) => {
      if (e.code !== 8) throw e;
    });
  }

  async read(path) {
    const h = (await this.request(OP.FILE_OPEN, Buffer.concat([u64(1), cstr(path)]))).header.readBigUInt64LE(0);
    const parts = [];
    try {
      for (;;) {
        const r = await this.request(OP.FILE_READ, u64(h, CHUNK));
        if (!r.data.length) break;
        parts.push(r.data);
      }
    } finally {
      await this.request(OP.FILE_CLOSE, u64(h));
    }
    return Buffer.concat(parts);
  }

  async write(path, data) {
    const h = (await this.request(OP.FILE_OPEN, Buffer.concat([u64(3), cstr(path)]))).header.readBigUInt64LE(0);
    try {
      for (let at = 0; at < data.length; at += CHUNK) await this.request(OP.FILE_WRITE, u64(h), data.subarray(at, at + CHUNK));
    } finally {
      await this.request(OP.FILE_CLOSE, u64(h));
    }
  }

  /** Copy a local folder (an .app) to `dest` on the device. */
  async upload(local, dest) {
    await this.mkdir(dest);
    for (const name of readdirSync(local)) {
      const from = join(local, name), to = `${dest}/${name}`;
      if (statSync(from).isDirectory()) await this.upload(from, to);
      else await this.write(to, readFileSync(from));
    }
  }

  close() {
    this.sock.destroy();
  }
}

/** AFC on the phone's media folder (or another AFC service: com.apple.crashreportcopymobile). */
export async function afc(udid, service = 'com.apple.afc') {
  const l = await lockdown(udid);
  try {
    return new AFC(await l.start(service));
  } finally {
    l.close();
  }
}

/** AFC inside an app's container (house_arrest): `what` is VendContainer (the whole container) or VendDocuments. */
export async function appFiles(udid, app, what = 'VendContainer') {
  const l = await lockdown(udid);
  let sock;
  try {
    sock = await l.start('com.apple.mobile.house_arrest');
  } finally {
    l.close();
  }
  const ch = plistChannel(sock);
  const r = await ch.ask({ Command: what, Identifier: app }, 10000);
  if (r.Error) {
    sock.destroy();
    throw new Error(r.Error === 'InstallationLookupFailed' ? `${app} is not installed` : r.Error === 'ApplicationLookupFailed' ? `${app} is not installed` : `the device won't share ${app}'s files: ${r.Error} (only apps signed for development share them)`);
  }
  ch.detach();
  return new AFC(sock);
}
