import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

/** Where uploads live. Local disk for development; an S3 adapter fits the same shape. */
export type Storage = {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
};

export function localStorage(root: string): Storage {
  const base = resolve(root);

  const pathFor = (key: string) => {
    const path = resolve(base, key);
    if (!path.startsWith(base + sep)) throw new Error(`Invalid storage key: ${key}`);
    return path;
  };

  return {
    async put(key, bytes) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      // Rename is atomic, so a crash can't leave half a file under the real key.
      const partial = join(dirname(path), `.${randomUUID()}.partial`);
      await writeFile(partial, bytes);
      await rename(partial, path);
    },
    get: (key) => readFile(pathFor(key)),
  };
}
