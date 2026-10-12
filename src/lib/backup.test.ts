import { describe, expect, it } from 'vitest';
import { buildBackup, parseBackup } from './backup';
import { account, catId, makeData, operation } from '../domain/testUtils';
import { applyChanges, saveAccount, saveOperation } from '../domain/commands';
import { balancesMap } from '../domain/balances';

describe('backup', () => {
  it('round-trips data and attachments with integrity checks', async () => {
    let d = makeData();
    const a = account({ initialBalance: 100_00 });
    d = applyChanges(d, saveAccount(d, a));
    const att = { id: 'att1', name: 'check.jpg', type: 'image/jpeg', size: 4, blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), createdAt: 1 };
    d = applyChanges(d, saveOperation(d, operation({ type: 'expense', amount: 50_55, accountId: a.id, categoryId: catId(d, 'Продукты'), attachmentIds: ['att1'] }), '2026-10-12'));
    const json = await buildBackup(d, [att]);
    const res = parseBackup(json);
    expect(res.data.operations).toEqual(d.operations);
    expect(balancesMap(res.data).get(a.id)).toBe(49_45);
    expect(res.attachments).toHaveLength(1);
    expect(new Uint8Array(await res.attachments[0].blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(res.summary.operations).toBe(1);
  });
  it('rejects broken files', async () => {
    expect(() => parseBackup('{')).toThrow('JSON');
    expect(() => parseBackup('{"format":"other"}')).toThrow('повреждён');
    let d = makeData();
    const a = account();
    d = applyChanges(d, saveAccount(d, a));
    d = applyChanges(d, saveOperation(d, operation({ type: 'income', amount: 1, accountId: a.id, categoryId: catId(d, 'Зарплата') }), '2026-10-12'));
    const bad = JSON.parse(await buildBackup(d, []));
    bad.data.accounts = [];
    expect(() => parseBackup(JSON.stringify(bad))).toThrow('целостность');
    const bad2 = JSON.parse(await buildBackup(d, []));
    bad2.data.operations[0].amount = 1.5;
    expect(() => parseBackup(JSON.stringify(bad2))).toThrow();
  });
});
