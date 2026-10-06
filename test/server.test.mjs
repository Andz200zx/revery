import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { Immich, HttpError, normalizeAsset } from '../server/immich.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
function asset(id = ids[0], extra = {}) { return { id, type: 'IMAGE', ownerId: owner, originalFileName: 'photo.jpg', visibility: 'timeline', width: 6000, height: 4000, exifInfo: { city: 'London', fileSizeInByte: 12000000 }, ...extra }; }
class MockImmich {
  constructor() { this.assets = ids.map((id) => asset(id)); this.calls = []; this.timeoutOnce = false; }
  async identity() { return { id: owner, name: 'Test library', namespace: owner }; }
  async random() { return this.assets; }
  async page() { return { assets: { items: this.assets, nextCursor: null } }; }
  async info(id) { return this.assets.find((item) => item.id === id); }
  async trash(id) { this.calls.push(['trash', id]); (await this.info(id)).isTrashed = true; if (this.timeoutOnce) { this.timeoutOnce = false; throw new HttpError(502, 'Connection lost'); } }
  async restore(id) { this.calls.push(['restore', id]); (await this.info(id)).isTrashed = false; }
  async image(id) { this.calls.push(['image', id]); return { response: new Response('photo-bytes', { headers: { 'content-type': 'image/jpeg' } }), quality: 'fullsize' }; }
  async request(path, options) { this.calls.push([options.method, path]); return null; }
}
async function harness(t, overrides = {}) {
  const config = loadConfig({ APP_MODE: 'live', APP_ORIGIN: 'http://127.0.0.1', ALLOW_HTTP: 'true',
    APP_PASSWORD: 'test-password-at-least-16', IMMICH_URL: 'http://immich.test:2283', IMMICH_API_KEY: 'test-key', ENABLE_TRASH: 'true', ...overrides });
  const store = new Store(':memory:'); const immich = new MockImmich();
  const { server } = await createApp(config, { store, immich });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; config.origin = origin;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); store.close(); });
  let cookie = '', csrf = '';
  async function call(path, data, options = {}) {
    const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': csrf }), ...options.headers },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const result = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : await response.text();
    return { status: response.status, result, headers: response.headers };
  }
  async function login() {
    const response = await call('/api/login', { password: 'test-password-at-least-16' });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; csrf = response.result.csrf;
    return response;
  }
  return { call, login, store, immich, config, origin };
}

test('live mode rejects incomplete, unprotected, and implicit HTTP deployments', () => {
  assert.throws(() => loadConfig({ APP_MODE: 'live' }), /requires IMMICH/);
  assert.throws(() => loadConfig({ APP_MODE: 'live', IMMICH_URL: 'http://immich', IMMICH_API_KEY: 'x', APP_PASSWORD: 'short' }), /15 characters/);
  assert.throws(() => loadConfig({ APP_MODE: 'live', IMMICH_URL: 'http://immich', IMMICH_API_KEY: 'x', APP_PASSWORD: 'a secure long password' }), /requires HTTPS/);
  assert.throws(() => loadConfig({ APP_MODE: 'demo', HOST: '0.0.0.0' }), /15 characters/);
  assert.doesNotThrow(() => loadConfig({ APP_MODE: 'live', APP_ORIGIN: 'https://revery.test', IMMICH_URL: 'http://immich', IMMICH_API_KEY: 'x', APP_PASSWORD: 'fifteen-chars!!' }));
});
test('private routes require login; sessions use HttpOnly and SameSite=Strict', async (t) => {
  const app = await harness(t);
  assert.equal((await app.call('/api/deck')).status, 401);
  const login = await app.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const response = await app.call('/api/library');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(response.result).includes('test-key'));
});
test('file-backed passwords preserve intentional spaces and reject unusably long passwords', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'revery-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'password');
  const password = ' spaced password ';
  writeFileSync(file, password + '\n', { mode: 0o600 });
  const app = await harness(t, { APP_PASSWORD_FILE: file });
  assert.equal((await app.call('/api/login', { password: password.trim() })).status, 401);
  assert.equal((await app.call('/api/login', { password })).status, 200);
  assert.throws(() => loadConfig({ APP_PASSWORD: 'x'.repeat(257) }), /at most 256/);
});
test('bad passwords are rate limited', async (t) => {
  const app = await harness(t);
  for (let i = 0; i < 8; i++) assert.equal((await app.call('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await app.call('/api/login', { password: 'wrong' })).status, 429);
});
test('forwarded addresses are ignored unless the proxy is trusted', async (t) => {
  const app = await harness(t);
  for (let i = 0; i < 8; i++) {
    assert.equal((await app.call('/api/login', { password: 'wrong' }, { headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } })).status, 401);
  }
  assert.equal((await app.call('/api/login', { password: 'test-password-at-least-16' }, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 429);
});
test('trusted proxy clients have separate limits and spoofed prefixes do not bypass them', async (t) => {
  const app = await harness(t, { TRUSTED_PROXIES: '127.0.0.1' });
  for (let i = 0; i < 8; i++) {
    assert.equal((await app.call('/api/login', { password: 'wrong' }, { headers: { 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.10` } })).status, 401);
  }
  assert.equal((await app.call('/api/login', { password: 'test-password-at-least-16' }, { headers: { 'x-forwarded-for': '198.51.100.10' } })).status, 429);
  assert.equal((await app.call('/api/login', { password: 'test-password-at-least-16' }, { headers: { 'x-forwarded-for': '198.51.100.11' } })).status, 200);
  assert.throws(() => loadConfig({ TRUSTED_PROXIES: '127.0.0.1, proxy.local' }), /exact IP addresses/);
  assert.deepEqual(loadConfig({ TRUSTED_PROXIES: '::ffff:127.0.0.1' }).trustedProxies, ['127.0.0.1']);
});
test('sessions survive a normal restart but are revoked when the password changes', async () => {
  const store = new Store(':memory:');
  const config = loadConfig({ APP_MODE: 'demo', APP_PASSWORD: 'initial-password-for-tests' });
  await createApp(config, { store });
  const session = store.createSession();
  await createApp(config, { store });
  assert.ok(store.session(session.token));
  await createApp({ ...config, password: 'a-new-password-for-tests' }, { store });
  assert.equal(store.session(session.token), null);
  store.close();
});
test('cross-site requests and missing CSRF tokens cannot mutate the library', async (t) => {
  const app = await harness(t); await app.login();
  const request = { id: ids[0], action: 'trash', requestId: randomUUID() };
  assert.equal((await app.call('/api/review', request, { headers: { origin: 'http://other.test' } })).status, 403);
  assert.equal((await app.call('/api/review', request, { headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal(app.immich.calls.length, 0);
});
test('an explicitly configured second origin works but arbitrary and mixed-scheme origins do not', async (t) => {
  const app = await harness(t, { EXTRA_ORIGINS: 'http://revery.lan' }); await app.login();
  assert.equal((await app.call('/api/reset', {}, { headers: { origin: 'http://revery.lan' } })).status, 200);
  assert.equal((await app.call('/api/reset', {}, { headers: { origin: 'http://elsewhere.lan' } })).status, 403);
  assert.equal((await app.call('/api/reset', {}, { headers: { origin: 'http://revery.lan', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://revery.lan', EXTRA_ORIGINS: 'http://revery.lan' }), /same protocol/);
  assert.throws(() => loadConfig({ EXTRA_ORIGINS: 'http://*.lan/path' }), /explicit origins/);
  assert.throws(() => loadConfig({ EXTRA_ORIGINS: 'http://*.lan' }), /explicit origins/);
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://*.example.com' }), /single HTTP\(S\) origin/);
});
test('Immich links support separate LAN and Tailscale destinations without credentials', () => {
  const config = loadConfig({ APP_MODE: 'live', APP_ORIGIN: 'https://revery.test', APP_PASSWORD: 'test-password-at-least-16',
    IMMICH_URL: 'http://immich.internal', IMMICH_API_KEY: 'secret', IMMICH_PUBLIC_URL: 'http://immich.lan:2283', IMMICH_ALTERNATE_URL: 'https://immich.tailnet.test' });
  const photo = normalizeAsset(asset(), config.publicUrl, config.alternatePublicUrl);
  assert.equal(photo.webUrl, `http://immich.lan:2283/photos/${ids[0]}`);
  assert.equal(photo.alternateWebUrl, `https://immich.tailnet.test/photos/${ids[0]}`);
  assert.ok(!JSON.stringify(photo).includes('secret'));
  assert.throws(() => loadConfig({ ...process.env, APP_MODE: 'live', APP_ORIGIN: 'https://revery.test', APP_PASSWORD: 'test-password-at-least-16',
    IMMICH_URL: 'http://immich.internal', IMMICH_API_KEY: 'secret', IMMICH_ALTERNATE_URL: 'https://user:password@immich.test' }), /embedded credentials/);
});
test('shuffle removes duplicates, offline, hidden and trashed assets', async (t) => {
  const app = await harness(t); await app.login();
  app.immich.assets = [asset(), asset(), asset(ids[1], { visibility: 'locked' }), asset(ids[2], { isTrashed: true }), asset(randomUUID(), { isOffline: true })];
  const { result } = await app.call('/api/deck');
  assert.deepEqual(result.assets.map((item) => item.id), [ids[0]]);
  assert.equal(result.assets[0].location, 'London');
  assert.ok(!('originalPath' in result.assets[0]));
});
test('a cursor does not skip queued unseen photographs or falsely claim completion', async (t) => {
  const app = await harness(t); await app.login();
  app.immich.random = async () => [];
  const blocked = await app.call(`/api/deck?exclude=${ids.join(',')}`);
  assert.equal(blocked.result.waiting, true); assert.equal(blocked.result.exhausted, false);
  assert.equal(app.store.scanCursor(owner), null);
  const refreshed = await app.call('/api/deck');
  assert.equal(refreshed.result.assets.length, 3);
});
test('unissued photos cannot be streamed or trashed, even with a valid session', async (t) => {
  const app = await harness(t); await app.login();
  assert.equal((await app.call(`/api/assets/${ids[0]}/image`)).status, 404);
  assert.equal((await app.call('/api/review', { id: ids[0], action: 'trash', requestId: randomUUID() })).status, 404);
  assert.equal(app.immich.calls.length, 0);
});
test('issued photos cannot be streamed or favourited after becoming private or unavailable', async (t) => {
  const app = await harness(t, { ENABLE_FAVORITES: 'true' }); await app.login(); await app.call('/api/deck');
  assert.equal((await app.call(`/api/assets/${ids[0]}/image`)).result, 'photo-bytes');
  assert.equal((await app.call('/api/favorite', { id: ids[0], favorite: true })).status, 200);
  for (const changes of [{ visibility: 'hidden' }, { visibility: 'locked' }, { isOffline: true }, { isTrashed: true }]) {
    Object.assign(app.immich.assets[0], { visibility: 'timeline', isOffline: false, isTrashed: false }, changes);
    assert.equal((await app.call(`/api/assets/${ids[0]}/image`)).status, 404);
    assert.equal((await app.call('/api/favorite', { id: ids[0], favorite: true })).status, 404);
    if (!changes.isTrashed) assert.equal((await app.call('/api/review', { id: ids[0], action: 'keep', requestId: randomUUID() })).status, 404);
  }
});
test('keep history persists and excludes reviewed photos; undo returns the photograph', async (t) => {
  const app = await harness(t); await app.login(); await app.call('/api/deck');
  const requestId = randomUUID();
  assert.equal((await app.call('/api/review', { id: ids[0], action: 'keep', requestId })).status, 200);
  const deck = await app.call('/api/deck');
  assert.ok(deck.result.assets.every((item) => item.id !== ids[0]));
  const undo = await app.call('/api/undo', { eventId: requestId });
  assert.equal(undo.result.asset.id, ids[0]); assert.equal(undo.result.stats.reviewed, 0);
  assert.equal(app.immich.calls.length, 0);
});
test('trash is idempotent; undo restores through Immich and clears review history', async (t) => {
  const app = await harness(t); await app.login(); await app.call('/api/deck');
  const request = { id: ids[0], action: 'trash', requestId: randomUUID(), force: true };
  assert.equal((await app.call('/api/review', request)).status, 200);
  assert.equal((await app.call('/api/review', request)).status, 200);
  assert.deepEqual(app.immich.calls, [['trash', ids[0]]]);
  const undo = await app.call('/api/undo', { eventId: request.requestId });
  assert.equal(undo.status, 200); assert.equal(undo.result.stats.trashed, 0);
  assert.deepEqual(app.immich.calls[1], ['restore', ids[0]]);
});
test('an ambiguous trash timeout survives refresh and is reconciled without another delete', async (t) => {
  const app = await harness(t); await app.login(); await app.call('/api/deck');
  app.immich.timeoutOnce = true;
  const request = { id: ids[0], action: 'trash', requestId: randomUUID() };
  assert.equal((await app.call('/api/review', request)).status, 502);
  const library = await app.call('/api/library');
  assert.equal(library.result.pending[0].id, request.requestId);
  assert.equal((await app.call('/api/reset', {})).status, 409);
  assert.equal((await app.call('/api/review', request)).status, 200);
  assert.equal(app.immich.calls.length, 1);
  assert.equal((await app.call('/api/library')).result.pending.length, 0);
});
test('cleanup can be disabled server-side, regardless of client input', async (t) => {
  const app = await harness(t, { ENABLE_TRASH: 'false' }); await app.login(); await app.call('/api/deck');
  assert.equal((await app.call('/api/review', { id: ids[0], action: 'trash', requestId: randomUUID() })).status, 403);
  assert.equal(app.immich.calls.length, 0);
});
test('logout invalidates the existing cookie', async (t) => {
  const app = await harness(t); await app.login();
  assert.equal((await app.call('/api/logout', {})).status, 200);
  assert.equal((await app.call('/api/library')).status, 401);
});
test('sparse random sampling falls back to cursors without dropping unreviewed page items', async (t) => {
  const app = await harness(t); await app.login();
  app.immich.random = async () => [];
  const cursors = [];
  app.immich.page = async (cursor) => { cursors.push(cursor); return { assets: { items: cursor ? [asset(ids[1]), asset(ids[2])] : [], nextCursor: cursor ? null : 'next-cursor' } }; };
  const first = await app.call('/api/deck');
  assert.equal(first.result.assets.length, 2);
  await app.call('/api/review', { id: ids[1], action: 'keep', requestId: randomUUID() });
  const second = await app.call('/api/deck');
  assert.deepEqual(second.result.assets.map((item) => item.id), [ids[2]]);
  assert.deepEqual(cursors, [null, 'next-cursor', 'next-cursor']);
});
test('Immich transport never forwards the API key to a foreign image redirect', async () => {
  const config = { immichUrl: new URL('http://immich.test/'), apiKey: 'private-token' };
  const urls = [];
  const immich = new Immich(config, async (url) => { urls.push(url.href); return new Response(null, { status: 302, headers: { location: 'http://foreign.test/leak' } }); });
  await assert.rejects(() => immich.image(ids[0], 'fullsize'), /unsupported image redirect/);
  assert.equal(urls.length, 1); assert.equal(new URL(urls[0]).hostname, 'immich.test');
});
test('browser rendition redirects retain the detected quality and original file bytes', async () => {
  const config = { immichUrl: new URL('http://immich.test/'), apiKey: 'private-token' };
  const immich = new Immich(config, async (url, options) => {
    assert.equal(options.headers['x-api-key'], 'private-token');
    return url.pathname.endsWith('/original') ? new Response('original-bytes', { headers: { 'content-type': 'image/jpeg' } }) : new Response(null, { status: 302, headers: { location: `/api/assets/${ids[0]}/original` } });
  });
  const { response, quality } = await immich.image(ids[0], 'rendition');
  assert.equal(quality, 'original'); assert.equal(await response.text(), 'original-bytes');
});
test('HEIC uses original bytes without relying on an enabled fullsize rendition', async () => {
  const paths = [];
  const immich = new Immich({ immichUrl: new URL('http://immich.test/'), apiKey: 'key' }, async (url) => {
    paths.push(url.pathname + url.search);
    return new Response('full-resolution-heic', { headers: { 'content-type': 'image/heic' } });
  });
  const image = await immich.image(ids[0], 'fullsize');
  assert.equal(image.quality, 'original');
  assert.equal(await image.response.text(), 'full-resolution-heic');
  assert.deepEqual(paths, [`/api/assets/${ids[0]}/original?edited=false`]);
});
test('RAW originals are cancelled and use Immich renditions with honest preview quality', async () => {
  let cancelled = false;
  const paths = [];
  const immich = new Immich({ immichUrl: new URL('http://immich.test/'), apiKey: 'key' }, async (url) => {
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith('/original')) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/x-sony-arw' } });
    if (url.searchParams.get('size') === 'fullsize') return new Response(null, { status: 302, headers: { location: `/api/assets/${ids[0]}/thumbnail?size=preview&edited=false` } });
    return new Response('preview-bytes', { headers: { 'content-type': 'image/jpeg' } });
  });
  const image = await immich.image(ids[0], 'fullsize');
  assert.equal(cancelled, true); assert.equal(image.quality, 'preview');
  assert.equal(await image.response.text(), 'preview-bytes');
  assert.equal(paths.length, 3);
});
test('missing original-download permission is reported without hiding it with a preview', async () => {
  let calls = 0;
  const immich = new Immich({ immichUrl: new URL('http://immich.test/'), apiKey: 'key' }, async () => { calls++; return new Response(null, { status: 403 }); });
  await assert.rejects(() => immich.image(ids[0], 'fullsize'), /required permission/);
  assert.equal(calls, 1);
});
test('Immich trash payload always uses force:false, and normalization omits private server paths', async () => {
  let payload;
  const immich = new Immich({ immichUrl: new URL('http://immich.test/'), apiKey: 'key' }, async (_url, options) => { payload = JSON.parse(options.body); return new Response(null, { status: 204 }); });
  await immich.trash(ids[0]); assert.deepEqual(payload, { ids: [ids[0]], force: false });
  const normalized = normalizeAsset(asset(ids[0], { originalPath: '/secret/path', owner: { email: 'private@example.test' } }), new URL('http://public.test/'));
  assert.equal(normalized.webUrl, `http://public.test/photos/${ids[0]}`);
  assert.ok(!JSON.stringify(normalized).includes('secret/path')); assert.ok(!JSON.stringify(normalized).includes('email'));
});
