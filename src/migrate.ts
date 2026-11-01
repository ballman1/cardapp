import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
migrate(db)
  .then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
