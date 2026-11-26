// The public demo backup (demo/demo-backup.json) opens with its published passphrase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openBackup, parseBackup } from '../src/vault';

test('demo backup opens with "demo-vault-passphrase" and holds only example data', async () => {
  const file = parseBackup(readFileSync(new URL('../demo/demo-backup.json', import.meta.url), 'utf8'));
  const opened = await openBackup(file, 'demo-vault-passphrase');
  assert.ok(opened);
  assert.equal(opened.data.entries.length, 17);
  for (const e of opened.data.entries) if (e.account.includes('@')) assert.match(e.account, /@example\.com$/);
  assert.equal(await openBackup(file, 'wrong-passphrase'), null);
});
