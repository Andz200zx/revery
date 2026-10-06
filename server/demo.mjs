import { normalizeAsset, shuffle } from './immich.mjs';

const seeds = [
  ['mountains', 'A little closer to the sky', '2024-08-18T07:42:00', 'Mountain morning'],
  ['lake', 'The long way home', '2023-10-06T18:24:00', 'By the water'],
  ['forest', 'Somewhere, slowly', '2025-05-12T09:16:00', 'A walk in the woods'],
];
export const demoAssets = seeds.map(([file, title, date, location], index) => {
  const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  return { ...normalizeAsset({ id, originalFileName: `${file}.jpg`, localDateTime: date,
    exifInfo: { description: title, city: location, make: 'Sample', model: 'photograph', exifImageWidth: 2400, exifImageHeight: 1600 } }),
    demoFile: `${file}.jpg`, appUrl: null, webUrl: null };
});
export class DemoImmich {
  constructor() { this.trashed = new Set(); }
  async identity() { return { id: 'demo', name: 'Sample library', namespace: 'demo' }; }
  async random() { return shuffle(demoAssets.filter((asset) => !this.trashed.has(asset.id))); }
  async page() { return { assets: { items: await this.random(), nextCursor: null } }; }
  async info(id) {
    const asset = demoAssets.find((asset) => asset.id === id);
    return asset ? { ...asset, type: 'IMAGE', isTrashed: this.trashed.has(id) } : null;
  }
  async trash(id) { this.trashed.add(id); }
  async restore(id) { this.trashed.delete(id); }
}
