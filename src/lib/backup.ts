import { z } from 'zod';
import type { AppData, Attachment } from '../domain/types';
import { COLLECTIONS } from '../domain/types';
import { defaultProfile } from '../domain/defaults';
import { emptyData } from '../domain/commands';
import { IMAGE_TYPES, MAX_STORED_BYTES } from './attachments';

export const BACKUP_FORMAT = 'qarajat-backup';
export const BACKUP_VERSION = 1;

const tiyn = z.number().int().refine(Number.isSafeInteger, 'Некорректная сумма');
const id = z.string().min(1).max(100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

const schemas = {
  accounts: z.object({ id, name: z.string(), type: z.string(), initialBalance: tiyn, isActive: z.boolean(), createdAt: isoDate }).passthrough(),
  operations: z
    .object({ id, type: z.enum(['income', 'expense', 'transfer', 'adjustment']), amount: tiyn, date: isoDateTime, accountId: id, toAccountId: id.nullable(), attachmentIds: z.array(id), tags: z.array(z.string()) })
    .passthrough(),
  categories: z.object({ id, name: z.string(), kind: z.enum(['income', 'expense']), parentId: id.nullable() }).passthrough(),
  debts: z.object({ id, name: z.string(), balanceAtEntry: tiyn, principal: tiyn, monthlyPayment: tiyn, annualRate: z.number().min(0).max(1000), entryDate: isoDate }).passthrough(),
  debtPayments: z.object({ id, debtId: id, amount: tiyn, principalPart: tiyn, interestPart: tiyn, date: isoDate }).passthrough(),
  goals: z.object({ id, name: z.string(), target: tiyn, accountId: id.nullable() }).passthrough(),
  goalContributions: z.object({ id, goalId: id, amount: tiyn, date: isoDate }).passthrough(),
  recurring: z.object({ id, title: z.string(), amount: tiyn, startDate: isoDate, frequency: z.enum(['weekly', 'monthly', 'yearly']) }).passthrough(),
  events: z.object({ id, title: z.string(), date: isoDate, amount: tiyn.nullable() }).passthrough(),
};

const attachmentSchema = z.object({
  id,
  name: z.string().max(300),
  type: z.string().refine((t) => IMAGE_TYPES.includes(t), 'Недопустимый тип вложения'),
  size: z.number().int().nonnegative().max(MAX_STORED_BYTES * 2),
  createdAt: z.number(),
  data: z.string().regex(/^[A-Za-z0-9+/=]*$/, 'Повреждённые данные вложения'),
});

const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1).max(BACKUP_VERSION),
  exportedAt: z.string(),
  data: z.object({
    profile: z.object({}).passthrough(),
    ...Object.fromEntries(COLLECTIONS.map((c) => [c, z.array(schemas[c])])),
  }),
  attachments: z.array(attachmentSchema),
});

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

export async function buildBackup(data: AppData, attachments: Attachment[]): Promise<string> {
  const atts = await Promise.all(
    attachments.map(async (a) => ({ id: a.id, name: a.name, type: a.type, size: a.size, createdAt: a.createdAt, data: await blobToBase64(a.blob) })),
  );
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data, attachments: atts });
}

export class BackupError extends Error {}

/** Проверяет файл резервной копии: формат, типы полей, ссылочную целостность. */
export function parseBackup(text: string): { data: AppData; attachments: Attachment[]; summary: Record<string, number> } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError('Файл не является корректным JSON');
  }
  const res = backupSchema.safeParse(raw);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new BackupError(`Файл резервной копии повреждён или не от Qarajat 2.0: ${issue.path.join('.')} — ${issue.message}`);
  }
  const b = res.data;
  const data = emptyData({ ...defaultProfile(), ...(b.data.profile as object) });
  for (const c of COLLECTIONS) (data as unknown as Record<string, unknown[]>)[c] = (b.data as unknown as Record<string, unknown[]>)[c];

  const accIds = new Set(data.accounts.map((a) => a.id));
  const attIds = new Set(b.attachments.map((a) => a.id));
  const debtIds = new Set(data.debts.map((d) => d.id));
  const goalIds = new Set(data.goals.map((g) => g.id));
  for (const op of data.operations) {
    if (!accIds.has(op.accountId) || (op.toAccountId && !accIds.has(op.toAccountId))) throw new BackupError('Нарушена целостность: операция ссылается на несуществующий счёт');
    if (op.attachmentIds.some((x) => !attIds.has(x))) throw new BackupError('Нарушена целостность: отсутствует вложение операции');
  }
  if (data.debtPayments.some((p) => !debtIds.has(p.debtId))) throw new BackupError('Нарушена целостность: платёж по несуществующему долгу');
  if (data.goalContributions.some((g) => !goalIds.has(g.goalId))) throw new BackupError('Нарушена целостность: накопление по несуществующей цели');
  const ids = new Set<string>();
  for (const c of COLLECTIONS) for (const x of data[c] as { id: string }[]) {
    if (ids.has(x.id)) throw new BackupError('Нарушена целостность: повторяющиеся идентификаторы');
    ids.add(x.id);
  }

  const attachments: Attachment[] = b.attachments.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size, createdAt: a.createdAt, blob: base64ToBlob(a.data, a.type) }));
  const summary = Object.fromEntries([...COLLECTIONS.map((c) => [c, (data[c] as unknown[]).length]), ['attachments', attachments.length]]);
  return { data, attachments, summary };
}

export function downloadFile(content: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
