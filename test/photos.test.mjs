import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoCache } from '../src/photos.js';

const asset = { id: 'one', imageUrl: '/api/assets/one/image?quality=fullsize' };
function objectUrls() {
  const active = new Set(), revoked = [];
  let count = 0;
  return { active, revoked,
    createObjectURL() { const url = `blob:${++count}`; active.add(url); return url; },
    revokeObjectURL(url) { active.delete(url); revoked.push(url); } };
}
const image = (quality, type = 'image/jpeg') => new Response('image-bytes', { headers: { 'content-type': type, 'x-image-quality': quality } });

test('a browser that decodes HEIC keeps the original and reuses the current image', async () => {
  const urls = objectUrls(); let requests = 0;
  const cache = createPhotoCache({ urls,
    fetcher: async () => { requests++; return image('original', 'image/heic'); },
    decode: async () => ({ width: 4032, height: 3024 }) });
  const result = await cache.load(asset);
  assert.equal(result.quality, 'original'); assert.equal(result.width, 4032);
  assert.equal(await cache.load(asset), result); assert.equal(requests, 1);
  cache.clear(); assert.equal(urls.active.size, 0);
});

test('an unsupported original falls back once and releases its blob', async () => {
  const urls = objectUrls(), requests = [];
  const cache = createPhotoCache({ urls,
    fetcher: async (url) => { requests.push(url); return image(requests.length === 1 ? 'original' : 'preview'); },
    decode: async (url) => { if (url === 'blob:1') throw new Error('Unsupported codec'); return { width: 1440, height: 1080 }; } });
  const result = await cache.load(asset);
  assert.equal(result.quality, 'preview'); assert.equal(result.width, 1440);
  assert.deepEqual(requests, [asset.imageUrl, asset.imageUrl.replace('fullsize', 'rendition')]);
  assert.deepEqual(urls.revoked, ['blob:1']); assert.equal(urls.active.size, 1);
  cache.clear(); assert.equal(urls.active.size, 0);
});

test('leaving a photo while decoding cancels it without starting a fallback', async () => {
  const urls = objectUrls(); let decodeReady, finishDecode, requests = 0;
  const ready = new Promise((resolve) => decodeReady = resolve);
  const cache = createPhotoCache({ urls,
    fetcher: async () => { requests++; return image('original'); },
    decode: async () => { decodeReady(); return new Promise((resolve) => finishDecode = resolve); } });
  const pending = cache.load(asset);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; cache.retain([]); finishDecode({ width: 4032, height: 3024 });
  await rejected; assert.equal(requests, 1); assert.equal(urls.active.size, 0);
});

test('a failed HTTP response is retryable and does not trigger a codec fallback', async () => {
  const urls = objectUrls(); let requests = 0;
  const cache = createPhotoCache({ urls,
    fetcher: async () => ++requests === 1 ? new Response(JSON.stringify({ error: 'Sign in again' }), { status: 401 }) : image('original'),
    decode: async () => ({ width: 2000, height: 1500 }) });
  await assert.rejects(cache.load(asset), /Sign in again/);
  assert.equal(requests, 1); assert.equal(urls.active.size, 0);
  assert.equal((await cache.load(asset)).quality, 'original');
  assert.equal(requests, 2); cache.clear();
});
