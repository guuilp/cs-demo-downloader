import { readJSON } from 'fs-extra/esm';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import L from './logger.js';

export interface Store {
  lastCodeDemoId: Record<string, string>;
  lastContinueToken: Record<string, string>;
  refreshToken: Record<string, string>;
  lastShareCode: Record<string, string>;
  pendingShareCodes: Record<string, string[]>;
  // PATCH (fix checkpoint): contador de runs consecutivas em que um usuário
  // teve download falho e o checkpoint foi pulado. Após 3, força o checkpoint
  // com ERROR (demo permanentemente morta, ex: 502) pra não travar o pipeline.
  failedRetries: Record<string, number>;
}

const configDir = process.env['CONFIG_DIR'] || 'config';
const storeFile = path.join(configDir, 'store.json');

// PATCH (race condition): os checkpoints por usuário (a8515c5) chamam
// setStoreValue concorrentemente dentro do downloadQueue (concurrency 4).
// Cada chamada é read-modify-write no mesmo store.json — sem serialização,
// duas escritas simultâneas corrompem o JSON (visto em produção:
// "Unexpected non-whitespace character after JSON"). Esta fila garante que
// leitura+escrita de cada operação rode em sequência.
let writeQueue: Promise<unknown> = Promise.resolve();

const enqueueWrite = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export const readStore = async (): Promise<Store> => {
  try {
    const store = (await readJSON(storeFile, 'utf-8')) as Store | undefined;
    if (typeof store === 'object') {
      return store;
    }
  } catch (err) {
    L.warn({ err }, 'Error reading store JSON');
  }
  return {
    lastCodeDemoId: {},
    lastContinueToken: {},
    refreshToken: {},
    lastShareCode: {},
    pendingShareCodes: {},
    failedRetries: {},
  };
};

export const getStoreValue = async (
  type: keyof Store,
  accountName: string,
): Promise<string | undefined> => {
  const store = await readStore();
  return store[type]?.[accountName] as string | undefined;
};

// PATCH (cache de share codes): leitura de valores em array (pendingShareCodes).
export const getStoreArrayValue = async (
  type: keyof Store,
  accountName: string,
): Promise<string[] | undefined> => {
  const store = await readStore();
  const value = store[type]?.[accountName];
  return Array.isArray(value) ? (value as string[]) : undefined;
};

// PATCH (atomicidade): escreve em arquivo temporário e renomeia. Se o processo
// morrer no meio da escrita, o store.json original fica intacto (sem truncar).
export const setStore = (store: Store): Promise<void> => {
  const tmpFile = `${storeFile}.tmp`;
  return writeFile(tmpFile, JSON.stringify(store, null, 2), 'utf-8').then(() =>
    rename(tmpFile, storeFile),
  );
};

export const setStoreValue = async (
  type: keyof Store,
  accountName: string,
  value: string,
): Promise<void> => {
  return enqueueWrite(async () => {
    L.trace({ type, accountName, value }, 'Setting store value');
    const store = await readStore();
    if (!store[type]) {
      (store[type] as Record<string, string>) = {};
    }
    (store[type] as Record<string, string>)[accountName] = value;
    return setStore(store);
  });
};

// PATCH (cache de share codes): escrita de valores em array (pendingShareCodes).
export const setStoreArrayValue = async (
  type: keyof Store,
  accountName: string,
  value: string[],
): Promise<void> => {
  return enqueueWrite(async () => {
    L.trace({ type, accountName, value }, 'Setting store array value');
    const store = await readStore();
    if (!store[type]) {
      (store[type] as Record<string, string[]>) = {};
    }
    (store[type] as Record<string, string[]>)[accountName] = value;
    return setStore(store);
  });
};
