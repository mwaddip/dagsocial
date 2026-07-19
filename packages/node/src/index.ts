import { initDb } from './store/db.js';
import { startBlockCreator, stopBlockCreator } from './services/blockCreator.js';
import { createApp } from './server.js';
import { config } from './config.js';

initDb(config.db.path);

const app = createApp();
startBlockCreator();

const server = app.listen(config.server.port, () => {
  console.log(`DAGsocial node running on http://localhost:${config.server.port}`);
});

process.on('SIGINT', () => { stopBlockCreator(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { stopBlockCreator(); server.close(); process.exit(0); });
