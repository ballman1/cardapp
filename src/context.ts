import type { ModelClient } from './ai/client.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { FxService } from './providers/fx.js';
import type { Registry } from './providers/registry.js';
import type { ObjectStore } from './storage/store.js';

export interface AppContext {
  cfg: Config;
  db: Db;
  store: ObjectStore;
  model: ModelClient;
  registry: Registry;
  fx: FxService;
  /** Wakes the in-process worker (no-op when an external worker is used). */
  kick: () => void;
}
