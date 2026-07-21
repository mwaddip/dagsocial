import { loadConfig } from './config.js';
import { initDb, closeDb } from './store/db.js';
import { startBlockCreator, stopBlockCreator } from './services/block-creator.js';
import { createApp } from './server.js';

const config = loadConfig();
initDb(config.dbPath);
startBlockCreator(config);

const app = createApp(config);
const server = app.listen(config.port, () => {
  console.log(`DAGsocial node listening on :${config.port}`);
});

process.on('SIGINT', () => {
  stopBlockCreator();
  closeDb();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopBlockCreator();
  closeDb();
  server.close();
  process.exit(0);
});
