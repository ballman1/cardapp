/**
 * Private object storage (local filesystem implementation). Files are never
 * served statically; access goes through authenticated, ownership-checked
 * routes. Swap for S3/GCS by implementing the same interface.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ObjectStore {
  put(bytes: Buffer, ext: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export function createLocalStore(root: string): ObjectStore {
  const resolve = (key: string) => {
    if (!/^[a-f0-9]{2}\/[a-f0-9-]{36}\.[a-z0-9]{2,5}$/.test(key)) throw new Error('invalid storage key');
    return path.join(root, key);
  };
  return {
    async put(bytes, ext) {
      const id = crypto.randomUUID();
      const key = `${id.slice(0, 2).replace(/[^a-f0-9]/g, '0')}/${id}.${ext.replace(/[^a-z0-9]/g, '')}`;
      const p = resolve(key);
      await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
      await fs.writeFile(p, bytes, { mode: 0o600, flag: 'wx' }); // immutable: never overwrite
      return key;
    },
    get: (key) => fs.readFile(resolve(key)),
    async delete(key) {
      await fs.rm(resolve(key), { force: true });
    },
  };
}
