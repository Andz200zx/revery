import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store } from './store.mjs';
import { Immich, HttpError, isUuid, normalizeAsset, shuffle, displayImages } from './immich.mjs';
import { DemoImmich } from './demo.mjs';

const deriveKey = promisify(scrypt);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
}
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function uuid(value) { if (!isUuid(value)) throw new HttpError(400, 'Invalid photograph or action ID.'); return value; }
function ipAddress(value) {
  return value?.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}
function clientAddress(req, trustedProxies) {
  const peer = ipAddress(req.socket.remoteAddress);
  if (!trustedProxies.includes(peer)) return peer;
  const chain = req.headers['x-forwarded-for'];
  if (typeof chain !== 'string') return peer;
  for (const entry of chain.split(',').reverse()) {
    const address = ipAddress(entry.trim());
    if (!isIP(address)) return peer;
    if (!trustedProxies.includes(address)) return address;
  }
  return peer;
}

export async function createApp(config, { store = new Store(config.dataDir), immich = config.demo ? new DemoImmich() : new Immich(config) } = {}) {
  const cookieName = config.secure ? '__Host-revery' : 'revery';
  const cookie = (token, age = 604800) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
  const salt = store.setting('password-salt') || randomBytes(32).toString('hex');
  const expectedPassword = config.password ? await deriveKey(config.password, salt, 64) : null;
  const fingerprint = expectedPassword?.toString('hex') || 'demo-without-password';
  if (store.setting('password-hash') !== fingerprint) {
    store.transaction(() => {
      store.revokeAll(); store.setSetting('password-salt', salt); store.setSetting('password-hash', fingerprint);
    });
  }
  const attempts = new Map();
  const locks = new Set();
  const makeAsset = (asset) => config.demo ? asset : normalizeAsset(asset, config.publicUrl, config.alternatePublicUrl);
  const viewable = (asset) => asset?.type === 'IMAGE' && !asset.isTrashed && !asset.isOffline && !['hidden', 'locked'].includes(asset.visibility);
  const available = (asset, namespace, excluded) => viewable(asset) && isUuid(asset.id) && !store.reviewed(namespace, asset.id) && !excluded.has(asset.id);

  async function locked(key, fn) {
    if (locks.has(key)) throw new HttpError(409, 'This photograph is already being updated. Try again shortly.');
    locks.add(key);
    try { return await fn(); } finally { locks.delete(key); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (config.secure) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      const url = new URL(req.url, config.origin);
      const token = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      let session = store.session(token);
      if (url.pathname === '/healthz' && req.method === 'GET') return json(res, { ok: true });
      if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
        if (![config.origin, ...(config.extraOrigins || [])].includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Request came from a different site.');
        if (url.pathname !== '/api/login' && (!session || req.headers['x-csrf-token'] !== session.csrf)) throw new HttpError(403, 'Your session expired. Refresh and try again.');
      }
      if (url.pathname === '/api/session' && req.method === 'GET') {
        if (config.demo && !config.password && !session) {
          const created = store.createSession(); res.setHeader('set-cookie', cookie(created.token)); session = created;
        }
        return json(res, { authenticated: !!session, csrf: session?.csrf ?? null, demo: config.demo,
          canTrash: config.enableTrash, canFavorite: config.demo || config.enableFavorites, secure: config.secure });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = clientAddress(req, config.trustedProxies || []);
        const now = Date.now();
        for (const [key, attempt] of attempts) if (attempt.until < now) attempts.delete(key);
        const attempt = attempts.get(ip) ?? { count: 0, until: now + 15 * 60000 };
        if (attempt.count >= 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
        attempt.count++; attempts.set(ip, attempt);
        const input = await body(req);
        if (!expectedPassword || typeof input.password !== 'string' || input.password.length > 256) throw new HttpError(401, 'That password didn’t match.');
        const provided = await deriveKey(input.password, salt, 64);
        if (!timingSafeEqual(expectedPassword, provided)) throw new HttpError(401, 'That password didn’t match.');
        attempts.delete(ip);
        store.revoke(token);
        const created = store.createSession(); res.setHeader('set-cookie', cookie(created.token));
        return json(res, { authenticated: true, csrf: created.csrf, demo: config.demo,
          canTrash: config.enableTrash, canFavorite: config.demo || config.enableFavorites, secure: config.secure });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session) throw new HttpError(401, 'Sign in to rediscover your photographs.');
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          store.revoke(token); res.setHeader('set-cookie', cookie('', 0)); return json(res, { ok: true });
        }
        const identity = await immich.identity();
        const namespace = identity.namespace;
        if (url.pathname === '/api/library' && req.method === 'GET') {
          return json(res, { name: identity.name, stats: store.stats(namespace), history: store.recent(namespace), pending: store.pendingEvents(namespace) });
        }
        if (url.pathname === '/api/deck' && req.method === 'GET') {
          const excluded = new Set((url.searchParams.get('exclude') ?? '').split(',').filter(Boolean));
          if (excluded.size > 60 || [...excluded].some((id) => !isUuid(id))) throw new HttpError(400, 'Invalid shuffle request.');
          const found = new Map();
          let exhausted = false, waiting = false;
          for (let i = 0; i < 3 && found.size < 8; i++) {
            const assets = await immich.random();
            if (!Array.isArray(assets)) throw new HttpError(502, 'Immich returned an unexpected photo list.');
            for (const asset of assets) if (available(asset, namespace, excluded)) found.set(asset.id, makeAsset(asset));
          }
          // A bounded paged scan finds the last unseen items when random sampling becomes sparse.
          // Keep the cursor at the current page until its available photographs are reviewed.
          if (!found.size) {
            let cursor = store.scanCursor(namespace);
            for (let i = 0; i < 4; i++) {
              const result = await immich.page(cursor);
              const assets = result?.assets?.items;
              if (!Array.isArray(assets)) throw new HttpError(502, 'Immich returned an unexpected photo list.');
              for (const asset of assets) if (available(asset, namespace, excluded)) found.set(asset.id, makeAsset(asset));
              if (found.size) { store.setScanCursor(namespace, cursor); break; }
              // Do not advance past unseen photos already queued on a client: a refresh
              // must still be able to discover them, even near the end of a large library.
              if (assets.some((asset) => available(asset, namespace, new Set()))) {
                waiting = true; store.setScanCursor(namespace, cursor); break;
              }
              if (!result.assets.nextCursor) { exhausted = true; store.setScanCursor(namespace, null); break; }
              const next = result.assets.nextCursor;
              if (typeof next !== 'string' || next === cursor) throw new HttpError(502, 'Immich returned an unexpected cursor.');
              cursor = next;
              store.setScanCursor(namespace, cursor);
            }
          }
          const assets = shuffle([...found.values()]).slice(0, 20);
          store.issue(namespace, assets);
          return json(res, { assets, exhausted, waiting, searching: !assets.length && !exhausted && !waiting });
        }
        const imageMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/image$/);
        if (imageMatch && req.method === 'GET') {
          const id = uuid(imageMatch[1]);
          if (!store.wasIssued(namespace, id)) throw new HttpError(404, 'Photograph is not in your shuffle.');
          const quality = url.searchParams.get('quality') ?? 'fullsize';
          if (!['preview', 'fullsize', 'rendition'].includes(quality)) throw new HttpError(400, 'Invalid image quality.');
          const asset = await immich.info(id);
          if (!viewable(asset)) throw new HttpError(404, 'Photograph is unavailable.');
          if (config.demo) {
            const image = await readFile(resolve(config.demoDir, quality === 'preview' ? asset.demoFile.replace('.jpg', '-preview.jpg') : asset.demoFile));
            res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-image-quality': 'demo', 'content-length': image.length });
            return res.end(image);
          }
          const controller = new AbortController();
          res.on('close', () => { if (!res.writableFinished) controller.abort(); });
          const { response, quality: actualQuality } = await immich.image(id, quality, controller.signal);
          const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          if (!displayImages.has(type)) { await response.body?.cancel(); throw new HttpError(415, 'This image format needs a compatible full-size rendition in Immich.'); }
          res.writeHead(200, { 'content-type': type, 'cache-control': 'private, no-store', 'x-image-quality': actualQuality });
          await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal });
          return;
        }
        if (url.pathname === '/api/review' && req.method === 'POST') {
          const input = await body(req); const id = uuid(input.id); const requestId = uuid(input.requestId);
          if (!['keep', 'trash'].includes(input.action)) throw new HttpError(400, 'Invalid review action.');
          if (input.action === 'trash' && !config.enableTrash) throw new HttpError(403, 'Cleanup is disabled on this server.');
          if (!store.wasIssued(namespace, id)) throw new HttpError(404, 'Photograph is not in your shuffle.');
          return await locked(`${namespace}:${id}`, async () => {
            let event = store.event(namespace, requestId);
            if (event && (event.asset_id !== id || event.action !== input.action)) throw new HttpError(409, 'This action ID is already in use.');
            if (event?.status === 'complete') return json(res, { eventId: requestId, stats: store.stats(namespace) });
            if (event && event.status !== 'pending') throw new HttpError(409, 'Start a new action before retrying.');
            const pending = store.pending(namespace, id);
            if (pending && pending.id !== requestId) throw new HttpError(409, 'An earlier action needs to be retried before continuing.');
            if (!event && store.reviewed(namespace, id)) throw new HttpError(409, 'This photograph has already been reviewed.');
            const raw = await immich.info(id);
            if (!raw || raw.type !== 'IMAGE' || raw.isOffline || ['hidden', 'locked'].includes(raw.visibility)) throw new HttpError(404, 'Photograph is unavailable.');
            if (!event && raw.isTrashed) throw new HttpError(409, 'This photograph is already in Immich trash.');
            if (!event) { store.begin(namespace, requestId, makeAsset(raw), input.action); event = store.event(namespace, requestId); }
            if (input.action === 'trash' && !raw.isTrashed) {
              try { await immich.trash(id); }
              catch (error) {
                // Preserve the same request ID: a timeout can happen after Immich applied the action.
                // Retrying checks Immich first and never creates a second trash event.
                throw new HttpError(error.status || 502, `${error.message} Retry this action to check its result.`);
              }
            }
            if (input.action === 'trash') {
              const updated = await immich.info(id);
              if (!updated?.isTrashed) throw new HttpError(502, 'Immich hasn’t confirmed this photograph is in trash. Retry to check its result.');
            }
            store.complete(namespace, requestId);
            return json(res, { eventId: requestId, stats: store.stats(namespace) });
          });
        }
        if (url.pathname === '/api/undo' && req.method === 'POST') {
          const input = await body(req); const eventId = uuid(input.eventId);
          const event = store.event(namespace, eventId);
          if (!event || !['complete', 'undone'].includes(event.status)) throw new HttpError(404, 'This action is unavailable.');
          return await locked(`${namespace}:${event.asset_id}`, async () => {
            if (event.status !== 'undone') {
              if (store.reviewed(namespace, event.asset_id)?.event_id !== eventId) throw new HttpError(409, 'A newer action has replaced this one.');
              if (event.action === 'trash') {
                const raw = await immich.info(event.asset_id);
                if (!raw) throw new HttpError(404, 'This photograph can no longer be restored.');
                if (raw.isTrashed) await immich.restore(event.asset_id);
                const restored = await immich.info(event.asset_id);
                if (!restored || restored.isTrashed) throw new HttpError(502, 'Immich hasn’t restored this photograph. Try again.');
              }
              store.undo(namespace, eventId);
            }
            return json(res, { asset: JSON.parse(event.snapshot), stats: store.stats(namespace) });
          });
        }
        if (url.pathname === '/api/favorite' && req.method === 'POST') {
          if (!config.demo && !config.enableFavorites) throw new HttpError(403, 'Favourites are disabled on this server.');
          const input = await body(req); const id = uuid(input.id);
          if (typeof input.favorite !== 'boolean' || !store.wasIssued(namespace, id)) throw new HttpError(400, 'Invalid favourite request.');
          if (!viewable(await immich.info(id))) throw new HttpError(404, 'Photograph is unavailable.');
          if (!config.demo) await immich.request(`assets/${id}`, { method: 'PUT', body: { isFavorite: input.favorite } });
          return json(res, { favorite: input.favorite });
        }
        if (url.pathname === '/api/reset' && req.method === 'POST') {
          if ([...locks].some((key) => key.startsWith(`${namespace}:`))) throw new HttpError(409, 'Wait for the current action to finish.');
          if (store.pendingEvents(namespace).length) throw new HttpError(409, 'Retry the unfinished action before starting a new shuffle.');
          store.reset(namespace); return json(res, { stats: store.stats(namespace) });
        }
        throw new HttpError(404, 'Endpoint not found.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Invalid path.'); }
      const filename = resolve(config.distDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(config.distDir + sep)) throw new HttpError(404, 'File not found.');
      if (!types[extname(filename)]) throw new HttpError(404, 'File not found.');
      let info;
      try { info = await stat(filename); } catch { throw new HttpError(404, 'File not found. Build the app first.'); }
      if (!info.isFile()) throw new HttpError(404, 'File not found.');
      const file = await readFile(filename);
      res.writeHead(200, { 'content-type': types[extname(filename)], 'content-length': file.length,
        'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Unexpected request error:', error.name);
      json(res, { error: status === 500 ? 'Something went wrong. Try again shortly.' : error.message }, status);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return { server, store, immich };
}
