import { createHash, randomInt } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// HEIC/HEIF originals are displayable in Safari; other browsers are checked by
// the client before switching away from the preview.
export const displayImages = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/heic', 'image/heif']);
export const isUuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export const shuffle = (items) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};

export function normalizeAsset(asset, publicUrl, alternatePublicUrl) {
  const exif = asset.exifInfo ?? {};
  return {
    id: asset.id, filename: asset.originalFileName || 'Untitled photograph',
    takenAt: exif.dateTimeOriginal || asset.localDateTime || asset.fileCreatedAt || null,
    location: [exif.city, exif.state, exif.country].filter(Boolean).join(', '),
    camera: [exif.make, exif.model].filter(Boolean).join(' '), lens: exif.lensModel || '',
    width: asset.width || exif.exifImageWidth || null, height: asset.height || exif.exifImageHeight || null,
    size: exif.fileSizeInByte || null, aperture: exif.fNumber || null, shutter: exif.exposureTime || null,
    iso: exif.iso || null, focalLength: exif.focalLength || null,
    favorite: !!asset.isFavorite, description: exif.description || '',
    webUrl: publicUrl ? new URL(`photos/${asset.id}`, publicUrl).href : null,
    alternateWebUrl: alternatePublicUrl ? new URL(`photos/${asset.id}`, alternatePublicUrl).href : null,
    appUrl: `immich://asset?id=${asset.id}`,
    previewUrl: `/api/assets/${asset.id}/image?quality=preview`,
    imageUrl: `/api/assets/${asset.id}/image?quality=fullsize`,
  };
}

export class Immich {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.identityPromise = null; }
  async request(path, { method = 'GET', body, signal, stream = false } = {}) {
    let url = new URL(`api/${path}`, this.config.immichUrl);
    for (let redirects = 0; redirects < 5; redirects++) {
      let response;
      try {
        response = await this.fetcher(url, {
          method, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(stream ? 120000 : 20000)]) : AbortSignal.timeout(stream ? 120000 : 20000),
          headers: { 'x-api-key': this.config.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch { throw new HttpError(502, 'Immich could not be reached. Check its connection and try again.'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!stream || !location) throw new HttpError(502, 'Unexpected redirect from Immich.');
        const next = new URL(location, url);
        if (next.origin !== this.config.immichUrl.origin || !next.pathname.startsWith(new URL('api/', this.config.immichUrl).pathname) || next.username || next.password) {
          throw new HttpError(502, 'Immich returned an unsupported image redirect.');
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new HttpError(502, 'The Immich API key is missing a required permission or has expired.');
        if (response.status === 404) throw new HttpError(404, 'This photograph is no longer available in Immich.');
        throw new HttpError(502, `Immich returned an error (${response.status}). Try again shortly.`);
      }
      if (stream) return { response, quality: url.pathname.endsWith('/original') ? 'original' : url.searchParams.get('size') || 'fullsize' };
      if (response.status === 204) return null;
      try { return await response.json(); } catch { throw new HttpError(502, 'Immich returned an unexpected response.'); }
    }
    throw new HttpError(502, 'Too many image redirects from Immich.');
  }
  async identity() {
    if (!this.identityPromise) this.identityPromise = this.request('users/me').then((user) => {
      if (!isUuid(user.id)) throw new HttpError(502, 'Immich returned an invalid account.');
      return { id: user.id, name: user.name || 'Your library', namespace: createHash('sha256').update(this.config.immichUrl.href + user.id).digest('hex') };
    }).catch((error) => { this.identityPromise = null; throw error; });
    return this.identityPromise;
  }
  async info(id) { return this.request(`assets/${id}`); }
  async random() {
    // v3.2.4 excludes trash by default. withDeleted is intentionally omitted.
    return this.request('search/random', { method: 'POST', body: { size: 60, type: 'IMAGE', withExif: true, withPeople: false, withStacked: true } });
  }
  async page(cursor) {
    return this.request('search/metadata', { method: 'POST', body: { size: 250, ...(cursor ? { cursor } : {}), type: 'IMAGE', withExif: true, withPeople: false, withStacked: true, order: 'asc' } });
  }
  async trash(id) { return this.request('assets', { method: 'DELETE', body: { ids: [id], force: false } }); }
  async restore(id) { return this.request('trash/restore/assets', { method: 'POST', body: { ids: [id] } }); }
  async image(id, quality, signal) {
    if (quality === 'fullsize') {
      const original = await this.request(`assets/${id}/original?edited=false`, { stream: true, signal });
      const type = original.response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (displayImages.has(type)) return original;
      // RAW/TIFF originals cannot be shown directly. Cancel without buffering
      // them and ask Immich for its browser rendition instead.
      await original.response.body?.cancel();
    }
    return this.request(`assets/${id}/thumbnail?size=${quality === 'rendition' ? 'fullsize' : quality}&edited=false`, { stream: true, signal });
  }
}
