// H-2 reuse detection, and a guard that vault operations never write secrets to the console.
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVault, destroyVault, lock, makeBackup, openBackup, parseBackup, reusedBy, reusedEntries, save, unlock, upsertEntry,
  type Entry,
} from '../src/vault';

const e = (id: string, service: string, type: Entry['type'], secret: string, category: Entry['category'] = 'login'): Entry =>
  ({ id, category, service, account: '', type, secret, notes: '', tags: [], history: [], createdAt: 0, updatedAt: 0 });

test('H-2: entries sharing a password are found; unique ones are not', () => {
  const list = [e('1', 'Gmail', 'password', 'Same-1'), e('2', 'Zoom', 'password', 'Same-1'), e('3', 'Slack', 'password', 'Unique-9')];
  assert.deepEqual(reusedBy(list[0], list).map((x) => x.service), ['Zoom']);
  assert.deepEqual(reusedBy(list[2], list), []);
  assert.deepEqual(reusedEntries(list).map((x) => x.id), ['1', '2']);
});

test('H-2: PINs count, but card numbers, CVVs, IDs and addresses do not', () => {
  const list = [
    e('1', 'Bank A', 'pin', '1234', 'bank'), e('2', 'Bank B', 'pin', '1234', 'bank'),
    e('3', 'Card', 'pin', '123', 'card'), e('4', 'Other card', 'pin', '123', 'card'),
    e('5', 'Passport', 'text', 'X1', 'id'), e('6', 'Licence', 'text', 'X1', 'id'),
  ];
  assert.deepEqual(reusedEntries(list).map((x) => x.id), ['1', '2']);
});

test('no vault operation writes anything to the console', async () => {
  const calls: unknown[][] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const saved = methods.map((m) => console[m]);
  methods.forEach((m) => { console[m] = (...a: unknown[]) => { calls.push(a); }; });
  try {
    await destroyVault();
    await createVault('master-pass-123');
    upsertEntry({ category: 'login', service: 'Example', account: 'me@example.com', type: 'password', secret: 'TOP-SECRET-VALUE', notes: '', tags: [] });
    await save();
    lock();
    await unlock('wrong-pass-000');
    await unlock('master-pass-123');
    const text = await makeBackup();
    await openBackup(parseBackup(text), 'master-pass-123');
    await openBackup(parseBackup(text), 'wrong-pass-000');
    assert.ok(!text.includes('TOP-SECRET-VALUE'), 'backup file must not contain plaintext');
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i]; });
  }
  assert.equal(calls.length, 0, 'console was written to');
});
