import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';

try {
  const config = loadConfig();
  const { server, store } = await createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(`Revery · ${config.demo ? 'demo' : 'live'} · http://${config.host}:${config.port}`);
  });
  function stop() {
    server.close(() => { store.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
