import { gzipSync } from 'node:zlib';

/** Test-only ustar writer. Produces the same shapes npm publishes, including pax long names. */

const BLOCK = 512;

function header(fields: { name: string; size: number; type: string }): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(fields.name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${fields.size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(fields.type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

export interface TarEntry {
  path: string;
  content?: string;
  type?: '0' | '5' | '2';
}

export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '', 'utf8');
    const type = entry.type ?? '0';
    if (entry.path.length > 100) {
      const record = `path=${entry.path}\n`;
      // pax record length counts its own digits and the separating space.
      let len = record.length + 3;
      if (`${len} ${record}`.length !== len) len += 1;
      const pax = Buffer.from(`${len} ${record}`, 'utf8');
      parts.push(header({ name: 'PaxHeader', size: pax.length, type: 'x' }), pad(pax));
    }
    parts.push(
      header({ name: entry.path.slice(0, 100), size: type === '0' ? data.length : 0, type }),
    );
    if (type === '0') parts.push(pad(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function writeTgz(entries: TarEntry[]): Buffer {
  return gzipSync(writeTar(entries));
}
