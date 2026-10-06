import { mkdir, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

if (!stdin.isTTY) throw new Error('Run this setup in an interactive terminal.');
const root = resolve(import.meta.dirname, '..');
try { await access(resolve(root, '.env')); throw new Error('A .env already exists. Edit it directly to preserve your settings.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const rl = createInterface({ input: stdin, output: stdout });
const origin = process.env.APP_ORIGIN || (await rl.question('Revery HTTPS address: ')).trim();
const immich = process.env.IMMICH_URL || (await rl.question('Immich internal URL: ')).trim();
const publicUrl = process.env.IMMICH_PUBLIC_URL || (await rl.question('Immich link URL (Enter to use the internal URL): ')).trim();
const extraOrigins = process.env.EXTRA_ORIGINS || '';
const alternateUrl = process.env.IMMICH_ALTERNATE_URL || '';
const favorites = process.env.ENABLE_FAVORITES ? process.env.ENABLE_FAVORITES === 'true' : (await rl.question('Enable Immich favourites? (yes/no, default yes): ')).trim() !== 'no';
const trash = process.env.ENABLE_TRASH ? process.env.ENABLE_TRASH === 'true' : (await rl.question('Enable reversible Immich trash? (yes/no): ')).trim() === 'yes';
rl.close();

function hidden(prompt) {
  stdout.write(prompt); stdin.setRawMode(true); stdin.resume();
  return new Promise((accept, reject) => {
    let value = '';
    const data = (chunk) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Setup cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    function finish(error) { stdin.off('data', data); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); error ? reject(error) : accept(value); }
    stdin.on('data', data);
  });
}
const key = (await hidden('Immich API key (hidden): ')).trim();
const password = await hidden('Revery password, at least 15 characters (hidden): ');
const confirmation = await hidden('Repeat Revery password (hidden): ');
if (!key || password.length < 15 || password !== confirmation) throw new Error('Key required; passwords must match and contain at least 15 characters.');
const { loadConfig } = await import('../server/config.mjs');
loadConfig({ APP_MODE: 'live', APP_ORIGIN: origin, EXTRA_ORIGINS: extraOrigins, IMMICH_URL: immich, IMMICH_PUBLIC_URL: publicUrl, IMMICH_ALTERNATE_URL: alternateUrl, IMMICH_API_KEY: key, APP_PASSWORD: password });
await mkdir(resolve(root, 'secrets'), { recursive: true, mode: 0o700 });
await mkdir(resolve(root, 'data'), { recursive: true, mode: 0o700 });
await writeFile(resolve(root, 'secrets/immich_api_key'), key + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(resolve(root, 'secrets/app_password'), password + '\n', { mode: 0o600, flag: 'wx' });
const entries = { APP_MODE: 'live', HOST: '127.0.0.1', PORT: '4311', APP_ORIGIN: origin,
  EXTRA_ORIGINS: extraOrigins, IMMICH_URL: immich, IMMICH_PUBLIC_URL: publicUrl, IMMICH_ALTERNATE_URL: alternateUrl, IMMICH_API_KEY_FILE: './secrets/immich_api_key',
  APP_PASSWORD_FILE: './secrets/app_password', ENABLE_TRASH: String(trash), ENABLE_FAVORITES: String(favorites) };
await writeFile(resolve(root, '.env'), Object.entries(entries).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
console.log('Saved local secrets and configuration. Secrets were not printed.');
