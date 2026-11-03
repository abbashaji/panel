// zip.ts
//
// Minimal ZIP reader (STORED + DEFLATE entries only, which is all GitHub Actions artifact zips use).
// Same approach as remote_mcp's github.ts, kept here so this Worker has no dependency on that project.

function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}
function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(buf: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (readU32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return [];
  const cdOffset = readU32(buf, eocd + 16);
  const cdEntries = readU16(buf, eocd + 10);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (readU32(buf, p) !== 0x02014b50) break;
    const compressionMethod = readU16(buf, p + 10);
    const compressedSize = readU32(buf, p + 20);
    const nameLen = readU16(buf, p + 28);
    const extraLen = readU16(buf, p + 30);
    const commentLen = readU16(buf, p + 32);
    const localHeaderOffset = readU32(buf, p + 42);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLen));
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function listZipEntries(buf: Uint8Array): string[] {
  return readCentralDirectory(buf).map((e) => e.name);
}

export async function extractFileFromZip(buf: Uint8Array, fileName: string): Promise<string | null> {
  const entry = readCentralDirectory(buf).find((e) => e.name === fileName);
  if (!entry) return null;
  const lh = entry.localHeaderOffset;
  const nameLen = readU16(buf, lh + 26);
  const extraLen = readU16(buf, lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + entry.compressedSize);
  const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  if (entry.compressionMethod === 0) return dec.decode(raw);
  if (entry.compressionMethod === 8) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return dec.decode(await new Response(stream).arrayBuffer());
  }
  return null;
}
