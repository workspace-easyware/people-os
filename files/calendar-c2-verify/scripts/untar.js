// 최소 tgz 추출기 (tar 명령 없이). 사용: node untar.js <in.tgz> <outDir>
// 경로 탈출(.. / 절대경로)은 거부한다. 일반 파일만 쓴다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const [inp, out] = process.argv.slice(2);
const buf = zlib.gunzipSync(fs.readFileSync(inp));
let off = 0;
const root = path.resolve(out);
while (off + 512 <= buf.length) {
  const h = buf.subarray(off, off + 512);
  if (h.every((b) => b === 0)) break;
  const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
  const type = String.fromCharCode(h[156] || 48);
  off += 512;
  if (type === '0' || type === '\0') {
    const dest = path.resolve(root, name);
    if (!dest.startsWith(root + path.sep)) throw new Error('unsafe path: ' + name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.subarray(off, off + size));
    console.log(size + '\t' + name);
  } else if (type !== '5') {
    console.log('skipped type ' + type + ' ' + name);
  }
  off += Math.ceil(size / 512) * 512;
}
