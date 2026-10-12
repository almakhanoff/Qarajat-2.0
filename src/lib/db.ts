import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppData, Attachment, Change, CollectionName, Profile } from '../domain/types';
import { COLLECTIONS } from '../domain/types';
import { defaultCategories, defaultProfile } from '../domain/defaults';
import { emptyData } from '../domain/commands';

export const DB_NAME = 'qarajat2';
export const DB_VERSION = 1;

interface QarajatDB extends DBSchema {
  accounts: { key: string; value: { id: string } };
  operations: { key: string; value: { id: string } };
  categories: { key: string; value: { id: string } };
  debts: { key: string; value: { id: string } };
  debtPayments: { key: string; value: { id: string } };
  goals: { key: string; value: { id: string } };
  goalContributions: { key: string; value: { id: string } };
  recurring: { key: string; value: { id: string } };
  events: { key: string; value: { id: string } };
  attachments: { key: string; value: Attachment };
  meta: { key: string; value: unknown };
}

type StoreName = CollectionName | 'attachments' | 'meta';
const ALL_STORES: StoreName[] = [...COLLECTIONS, 'attachments', 'meta'];

let dbPromise: Promise<IDBPDatabase<QarajatDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<QarajatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<QarajatDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // Миграции схемы: каждая версия добавляет свои изменения.
        if (oldVersion < 1) {
          for (const s of ALL_STORES) db.createObjectStore(s as 'meta', s === 'meta' ? undefined : { keyPath: 'id' });
        }
      },
      blocking() {
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

export async function loadData(): Promise<{ data: AppData; isNew: boolean }> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readonly');
  const profile = (await tx.objectStore('meta').get('profile')) as Profile | undefined;
  const isNew = !profile;
  const data = emptyData({ ...defaultProfile(), ...(profile ?? {}) });
  for (const c of COLLECTIONS) {
    (data as unknown as Record<string, unknown[]>)[c] = await tx.objectStore(c).getAll();
  }
  await tx.done;
  if (isNew) {
    data.categories = defaultCategories();
    await persistChanges([{ op: 'profile', value: data.profile }, ...data.categories.map((c) => ({ op: 'put' as const, store: 'categories' as const, value: c }))]);
  }
  return { data, isNew };
}

/** Атомарно применяет изменения: либо всё сохраняется, либо ничего. */
export async function persistChanges(changes: Change[]): Promise<void> {
  if (!changes.length) return;
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  for (const ch of changes) {
    switch (ch.op) {
      case 'put':
        void tx.objectStore(ch.store).put(ch.value);
        break;
      case 'delete':
        void tx.objectStore(ch.store).delete(ch.id);
        break;
      case 'profile':
        void tx.objectStore('meta').put(ch.value, 'profile');
        break;
      case 'putAttachment':
        void tx.objectStore('attachments').put(ch.value);
        break;
      case 'deleteAttachment':
        void tx.objectStore('attachments').delete(ch.id);
        break;
    }
  }
  await tx.done;
}

export async function getAttachment(id: string): Promise<Attachment | undefined> {
  return (await getDB()).get('attachments', id);
}

export async function getAllAttachments(): Promise<Attachment[]> {
  return (await getDB()).getAll('attachments');
}

/** Полная замена содержимого базы (восстановление из резервной копии). */
export async function replaceAll(data: AppData, attachments: Attachment[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  for (const s of ALL_STORES) void tx.objectStore(s).clear();
  for (const c of COLLECTIONS) for (const v of data[c] as { id: string }[]) void tx.objectStore(c).put(v);
  for (const a of attachments) void tx.objectStore('attachments').put(a);
  void tx.objectStore('meta').put(data.profile, 'profile');
  await tx.done;
}

export async function clearAll(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(ALL_STORES, 'readwrite');
  for (const s of ALL_STORES) void tx.objectStore(s).clear();
  await tx.done;
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* браузер не поддерживает */
  }
  return false;
}
