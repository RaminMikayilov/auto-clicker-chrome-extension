// Packs src/ into auto-clicker-<version>.zip, ready to load unpacked or upload.
//
// Rolls its own ZIP writer rather than shelling out: PowerShell's
// Compress-Archive (and .NET Framework's ZipFile) write Windows backslashes as
// entry names, which is out of spec and can break Web Store upload. Entry names
// here are always forward-slash relative paths, and timestamps are fixed so the
// same source always produces a byte-identical archive.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** All files under `dir`, as forward-slash paths relative to it, sorted. */
function walk(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full, base);
      return [path.relative(base, full).split(path.sep).join('/')];
    })
    .sort();
}

// Fixed at the ZIP epoch (1980-01-01) to keep builds reproducible.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const METHOD_DEFLATE = 8;

function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8); // flags
    dir.writeUInt16LE(METHOD_DEFLATE, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); // size of central directory
  end.writeUInt32LE(offset, 16); // offset of central directory
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}

const { version } = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const out = path.join(ROOT, `auto-clicker-${version}.zip`);

const names = walk(SRC);
if (!names.includes('manifest.json')) {
  console.error('src/manifest.json is missing -- refusing to build.');
  process.exit(1);
}

const files = names.map((name) => ({ name, data: fs.readFileSync(path.join(SRC, name)) }));
fs.writeFileSync(out, buildZip(files));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`Packed ${files.length} files -> ${path.basename(out)} (${kb} KB)`);
for (const name of names) console.log(`  ${name}`);
