import { createOpenAIModelClient } from './ai/client.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createPool, migrate } from './db.js';
import { startWorkerLoop } from './jobs/worker.js';
import { createFxService } from './providers/fx.js';
import { createRegistry } from './providers/registry.js';
import { createLocalStore } from './storage/store.js';

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.databaseUrl);
  await migrate(db);
  const ctx: AppContext = {
    cfg,
    db,
    store: createLocalStore(cfg.storageDir),
    model: createOpenAIModelClient(cfg),
    registry: createRegistry(cfg),
    fx: createFxService(cfg.fx.provider, cfg.fx.baseUrl),
    kick: () => {},
  };
  if (cfg.workerInProcess) {
    const w = startWorkerLoop(ctx);
    ctx.kick = w.kick;
  }
  const app = await buildApp(ctx);
  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`[server] listening on http://localhost:${cfg.port} (env=${cfg.env}, worker=${cfg.workerInProcess ? 'in-process' : 'external'}, fixtures=${cfg.allowFixtures})`);

  // Startup capability test with the deployed key — surfaced, never papered over.
  ctx.model.capabilityTest().then((r) => console.log(`[model] ${r.ok ? 'OK' : 'UNAVAILABLE'}: ${r.detail}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
