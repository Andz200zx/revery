// Keep only the current and next full-size image in memory. Private photos never enter the service-worker cache.
async function decodePhoto(url, signal) {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const image = new Image();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
  });
  image.src = url;
  try {
    await Promise.race([image.decode(), cancelled]);
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    signal.removeEventListener('abort', abort);
    image.removeAttribute('src');
  }
}

export function createPhotoCache({ fetcher = fetch, decode = decodePhoto, urls = URL } = {}) {
  const cache = new Map();
  function retain(ids) {
    for (const [id, entry] of cache) {
      if (!ids.includes(id)) {
        entry.controller.abort(); if (entry.url) urls.revokeObjectURL(entry.url); cache.delete(id);
      }
    }
  }
  async function load(asset) {
    if (cache.has(asset.id)) return cache.get(asset.id).promise;
    const entry = { controller: new AbortController(), url: null };
    entry.promise = (async () => {
      const signal = entry.controller.signal;
      for (const rendition of [false, true]) {
        const path = rendition ? asset.imageUrl.replace('quality=fullsize', 'quality=rendition') : asset.imageUrl;
        const response = await fetcher(path, { signal, cache: 'no-store' });
        if (!response.ok) {
          const message = await response.json().catch(() => ({}));
          throw new Error(message.error || 'Full-size image could not be loaded.');
        }
        const blob = await response.blob();
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const url = urls.createObjectURL(blob);
        const quality = response.headers.get('x-image-quality') || 'fullsize';
        try {
          const dimensions = await decode(url, signal);
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          entry.url = url;
          return { url, quality, ...dimensions };
        } catch (error) {
          urls.revokeObjectURL(url);
          if (signal.aborted || error.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
          if (rendition || quality !== 'original') throw new Error('This photograph could not be decoded. Try its Immich view or retry the image.');
        }
      }
    })().catch((error) => { if (cache.get(asset.id) === entry) cache.delete(asset.id); throw error; });
    cache.set(asset.id, entry);
    return entry.promise;
  }
  function clear() { retain([]); }
  return { load, retain, clear };
}
