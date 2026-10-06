import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';

// Temporary deployment helper. Serves one non-secret archive to one LAN host.
const [file, bind, allowedHost] = process.argv.slice(2);
if (!file || !bind || !allowedHost) throw new Error('Usage: node scripts/share-build.mjs archive bind-address NAS-address');
const downloadPath = '/' + encodeURIComponent(basename(file));
const server = createServer((req, res) => {
  if (req.socket.remoteAddress !== allowedHost || req.url !== downloadPath || req.method !== 'GET') {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': statSync(file).size, 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});
server.listen(4322, bind, () => console.log(`Build transfer ready at http://${bind}:4322${downloadPath} (NAS only)`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setTimeout(stop, 15 * 60000).unref();
