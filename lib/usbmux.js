// usbmuxd client: list the devices the Mac can reach (USB, and Wi-Fi-paired ones) and open a TCP
// connection to a port on one of them. This is how Xcode itself reaches a device; no iproxy needed.
import { connect } from 'node:net';

const SOCKET = '/var/run/usbmuxd';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A flat object of strings and integers → an XML plist. */
export function toPlist(obj) {
  const body = Object.entries(obj)
    .map(([k, v]) => `<key>${xmlEscape(k)}</key>${Number.isInteger(v) ? `<integer>${v}</integer>` : `<string>${xmlEscape(v)}</string>`}`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`;
}

/** An XML plist → a JS value (dict, array, string, integer, real, true/false, data as base64). */
export function fromPlist(xml) {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').match(/<[^>]+>|[^<]+/g) || [];
  let i = 0;
  const text = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const value = () => {
    while (i < tokens.length && !tokens[i].startsWith('<')) i++; // whitespace between elements
    const t = tokens[i++];
    if (t === '<plist version="1.0">' || t.startsWith('<plist')) return value();
    if (t === '<dict/>') return {};
    if (t === '<array/>') return [];
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string/>') return '';
    const tag = /^<(\w+)>$/.exec(t)?.[1];
    if (tag === 'dict') {
      const o = {};
      for (;;) {
        while (!tokens[i].startsWith('<')) i++;
        if (tokens[i] === '</dict>') return i++, o;
        i++; // <key>
        const k = tokens[i] === '</key>' ? '' : text(tokens[i++]);
        i++; // </key>
        o[k] = value();
      }
    }
    if (tag === 'array') {
      const a = [];
      for (;;) {
        while (!tokens[i].startsWith('<')) i++;
        if (tokens[i] === '</array>') return i++, a;
        a.push(value());
      }
    }
    const raw = tokens[i].startsWith('</') ? '' : text(tokens[i++]);
    i++; // closing tag
    if (tag === 'integer') return Number(raw);
    if (tag === 'real') return Number(raw);
    if (tag === 'data') return raw.replace(/\s/g, '');
    return raw;
  };
  return value();
}

/** Send one plist message on a fresh usbmuxd socket; resolves to { sock, reply }. */
function request(msg, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET);
    const timer = setTimeout(() => (sock.destroy(), reject(new Error('usbmuxd did not answer'))), timeout);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeAllListeners('error');
      if (buf.length > len) sock.unshift(buf.subarray(len));
      resolve({ sock, reply: fromPlist(buf.subarray(16, len).toString('utf8')) });
    };
    sock.on('data', onData);
    sock.once('error', (e) => (clearTimeout(timer), reject(new Error(`usbmuxd: ${e.message}`))));
    sock.once('connect', () => {
      const payload = Buffer.from(toPlist({ ClientVersionString: 'looktap', ProgName: 'looktap', ...msg }));
      const head = Buffer.alloc(16);
      head.writeUInt32LE(16 + payload.length, 0);
      head.writeUInt32LE(1, 4); // version: plist
      head.writeUInt32LE(8, 8); // message: plist
      head.writeUInt32LE(1, 12); // tag
      sock.write(Buffer.concat([head, payload]));
    });
  });
}

/** Devices usbmuxd knows: [{ id (usbmux DeviceID), udid, via: 'USB' | 'Network' }]. USB first. */
export async function muxDevices() {
  const { sock, reply } = await request({ MessageType: 'ListDevices' });
  sock.destroy();
  const list = (reply.DeviceList || []).map((d) => ({
    id: d.DeviceID,
    udid: d.Properties?.SerialNumber,
    via: d.Properties?.ConnectionType,
  }));
  return list.sort((a, b) => (a.via === 'USB' ? 0 : 1) - (b.via === 'USB' ? 0 : 1));
}

/** A socket connected to `port` on the device with hardware UDID `udid`, over USB when it's plugged in. */
export async function muxConnect(udid, port, timeout = 3000) {
  const found = (await muxDevices()).filter((d) => d.udid === udid);
  if (!found.length) throw new Error(`device ${udid} is not reachable (plug it in, or pair it for Wi-Fi in Xcode)`);
  let last;
  for (const d of found) {
    const { sock, reply } = await request({ MessageType: 'Connect', DeviceID: d.id, PortNumber: ((port & 0xff) << 8) | (port >> 8) }, timeout);
    if (reply.Number === 0) return sock;
    sock.destroy();
    last = reply.Number;
  }
  throw new Error(`nothing is listening on port ${port} on the device (usbmuxd result ${last})`);
}
