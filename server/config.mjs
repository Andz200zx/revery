import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

function secret(env, name) {
  if (!env[`${name}_FILE`]) return env[name] ?? '';
  const value = readFileSync(env[`${name}_FILE`], 'utf8');
  // Remove the secret file's final line ending without changing a password's spaces.
  return name === 'APP_PASSWORD' ? value.replace(/\r?\n$/, '') : value.trim();
}

export function loadConfig(env = process.env) {
  const demo = (env.APP_MODE ?? 'demo') === 'demo';
  if (!['demo', 'live'].includes(env.APP_MODE ?? 'demo')) throw new Error('APP_MODE must be demo or live.');
  const origin = new URL(env.APP_ORIGIN ?? 'http://127.0.0.1:4310');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.hostname.includes('*') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('APP_ORIGIN must be a single HTTP(S) origin.');
  }
  const password = secret(env, 'APP_PASSWORD');
  if (password.length > 256) throw new Error('APP_PASSWORD must contain at most 256 characters.');
  const apiKey = secret(env, 'IMMICH_API_KEY');
  const host = env.HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? 4311);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT is invalid.');
  const secure = origin.protocol === 'https:';
  const trustedProxies = (env.TRUSTED_PROXIES || '').split(',').map((entry) => entry.trim()).filter(Boolean)
    .map((address) => address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address);
  if (trustedProxies.some((address) => !isIP(address))) throw new Error('TRUSTED_PROXIES must contain exact IP addresses.');
  const extraOrigins = (env.EXTRA_ORIGINS || '').split(',').filter(Boolean).map((entry) => {
    const extra = new URL(entry.trim());
    if (extra.protocol !== origin.protocol || extra.hostname.includes('*') || extra.username || extra.password || extra.pathname !== '/' || extra.search || extra.hash)
      throw new Error('EXTRA_ORIGINS must contain explicit origins using the same protocol as APP_ORIGIN.');
    return extra.origin;
  });
  if (!demo && (!apiKey || !env.IMMICH_URL)) throw new Error('Live mode requires IMMICH_URL and IMMICH_API_KEY (or IMMICH_API_KEY_FILE).');
  if ((!demo || !['127.0.0.1', '::1', 'localhost'].includes(host)) && password.length < 15) {
    throw new Error('Set an APP_PASSWORD of at least 15 characters before serving live photos or binding to the network.');
  }
  if (!demo && !secure && env.ALLOW_HTTP !== 'true') throw new Error('Live mode requires HTTPS APP_ORIGIN, or explicit ALLOW_HTTP=true for a trusted LAN.');
  let immichUrl = null;
  let publicUrl = null;
  let alternatePublicUrl = null;
  if (!demo) {
    immichUrl = new URL(env.IMMICH_URL.replace(/\/api\/?$/, '').replace(/\/$/, '') + '/');
    publicUrl = new URL((env.IMMICH_PUBLIC_URL || env.IMMICH_URL).replace(/\/api\/?$/, '').replace(/\/$/, '') + '/');
    if (env.IMMICH_ALTERNATE_URL) alternatePublicUrl = new URL(env.IMMICH_ALTERNATE_URL.replace(/\/api\/?$/, '').replace(/\/$/, '') + '/');
    for (const url of [immichUrl, publicUrl, alternatePublicUrl].filter(Boolean)) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Immich URLs must be HTTP(S) URLs without embedded credentials.');
    }
  }
  return { demo, origin: origin.origin, extraOrigins, trustedProxies, password, apiKey, host, port, secure, immichUrl, publicUrl, alternatePublicUrl,
    enableTrash: demo || env.ENABLE_TRASH === 'true', enableFavorites: demo || env.ENABLE_FAVORITES === 'true', dataDir: resolve(env.DATA_DIR ?? './data'),
    distDir: resolve('dist'), demoDir: resolve(env.DEMO_DIR ?? 'public/demo') };
}
