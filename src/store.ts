import { outputJSON, readJSON } from 'fs-extra/esm';
import path from 'node:path';
import L from './logger.js';

export interface Store {
  lastCodeDemoId: Record<string, string>;
  lastContinueToken: Record<string, string>;
  refreshToken: Record<string, string>;
  lastShareCode: Record<string, string>;
  pendingShareCodes: Record<string, string[]>;
}

const configDir = process.env['CONFIG_DIR'] || 'config';
const storeFile = path.join(configDir, 'store.json');

export const readStore = async (): Promise<Store> => {
  try {
    const store = (await readJSON(storeFile, 'utf-8')) as Store | undefined;
    if (typeof store === 'object') {
      return store;
    }
  } catch (err) {
    L.warn({ err }, 'Error reading store JSON');
  }
  return { lastCodeDemoId: {}, lastContinueToken: {}, refreshToken: {}, lastShareCode: {}, pendingShareCodes: {} };
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

export const setStore = (store: Store): Promise<void> => {
  return outputJSON(storeFile, store, { encoding: 'utf-8' });
};

export const setStoreValue = async (
  type: keyof Store,
  accountName: string,
  value: string,
): Promise<void> => {
  L.trace({ type, accountName, value }, 'Setting store value');
  const store = await readStore();
  if (!store[type]) {
    (store[type] as Record<string, string>) = {};
  }
  (store[type] as Record<string, string>)[accountName] = value;
  return setStore(store);
};

// PATCH (cache de share codes): escrita de valores em array (pendingShareCodes).
export const setStoreArrayValue = async (
  type: keyof Store,
  accountName: string,
  value: string[],
): Promise<void> => {
  L.trace({ type, accountName, value }, 'Setting store array value');
  const store = await readStore();
  if (!store[type]) {
    (store[type] as Record<string, string[]>) = {};
  }
  (store[type] as Record<string, string[]>)[accountName] = value;
  return setStore(store);
};
