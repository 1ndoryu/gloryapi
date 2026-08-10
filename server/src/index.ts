import './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';
import { closeRoutingEventSubscribers } from './services/routing-events.js';

const PORT = process.env.PORT ?? 3101;

async function main() {
  initDb();
  const app = createApp();

  const server = app.listen(Number(PORT), '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
    console.log(`Proxy endpoint: http://127.0.0.1:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeRoutingEventSubscribers();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(console.error);
