/** Standalone job worker (use with WORKER_IN_PROCESS=false on the web server). */
import { createOpenAIModelClient } from './ai/client.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createPool, migrate } from './db.js';
import { startWorkerLoop } from './jobs/worker.js';
import { createFxService } from './providers/fx.js';
import { createRegistry } from './providers/registry.js';
import { createLocalStore } from './storage/store.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db);
const ctx: AppContext = {
  cfg, db,
  store: createLocalStore(cfg.storageDir),
  model: createOpenAIModelClient(cfg),
  registry: createRegistry(cfg),
  fx: createFxService(cfg.fx.provider, cfg.fx.baseUrl),
  kick: () => {},
};
const r = await ctx.model.capabilityTest();
console.log(`[worker] model ${r.ok ? 'OK' : 'UNAVAILABLE'}: ${r.detail}`);
startWorkerLoop(ctx);
console.log('[worker] polling for jobs');
