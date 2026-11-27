// N-1: private logos live inside the encrypted vault, never in the website's code. Runs with: npm test
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kvGet } from '../src/db';
import { cleanLogos, parseLogoPack } from '../src/logos';
import {
  createVault, destroyVault, lock, makeBackup, parseBackup, restoreAsNewVault, save, unlock, vault,
} from '../src/vault';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const logo = (over: Record<string, unknown> = {}) => ({ name: 'examplebank', match: 'example ?bank', img: PNG, full: false, bg: '#ffffff', ...over });
const pack = (logos: unknown[]) => JSON.stringify({ format: 'memo-vault-logos', version: 1, logos });

test('N-1: a valid logo pack is read', () => {
  const list = parseLogoPack(pack([logo(), logo({ name: 'other', match: '\\bother\\b', full: true, bg: '#1d4f9f' })]));
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], logo());
});

test('N-1: files that are not logo packs are refused', () => {
  assert.throws(() => parseLogoPack('not json'), /not a logo pack/);
  assert.throws(() => parseLogoPack(JSON.stringify({ format: 'memo-vault-backup', version: 1, logos: [logo()] })), /not a logo pack/);
  assert.throws(() => parseLogoPack(pack([logo({ img: 'https://evil.example/x.png' })])), /no usable logos/);
});

test('N-1: unsafe or malformed logos are dropped, extra fields are not kept', () => {
  const bad = [
    logo({ img: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }), // SVG can carry script
    logo({ img: 'javascript:alert(1)' }),
    logo({ img: PNG + '"onerror="x' }),
    logo({ img: 'data:image/png;base64,' + 'A'.repeat(70_000) }), // too big
    logo({ bg: 'red;background:url(x)' }),
    logo({ match: '(' }), // broken pattern
    logo({ match: 'a'.repeat(201) }),
    logo({ name: '' }),
    logo({ full: 'yes' }),
    null, 'text', 42,
  ];
  assert.deepEqual(cleanLogos(bad), []);
  const [kept] = cleanLogos([{ ...logo(), extra: 'ignored', __proto__x: 1 }]);
  assert.deepEqual(Object.keys(kept).sort(), ['bg', 'full', 'img', 'match', 'name']);
  assert.equal(cleanLogos(Array.from({ length: 150 }, () => logo())).length, 100);
});

test('N-1: logos are stored encrypted in the vault and survive lock, unlock and restore', async () => {
  await destroyVault();
  await createVault('master-pass-for-logos-1');
  vault().settings.logos = parseLogoPack(pack([logo()]));
  await save();
  const sealed = JSON.stringify(await kvGet('vault'));
  assert.ok(!sealed.includes('examplebank') && !sealed.includes('iVBORw0KGgo'), 'logo data must not be stored in plain text');
  lock();
  assert.equal(await unlock('master-pass-for-logos-1'), true);
  assert.equal(vault().settings.logos[0].name, 'examplebank');

  const backup = await makeBackup();
  assert.ok(!backup.includes('examplebank'));
  await destroyVault();
  assert.equal(await restoreAsNewVault(parseBackup(backup), 'master-pass-for-logos-1', 'master-pass-for-logos-2'), true);
  assert.equal(vault().settings.logos.length, 1);
  await destroyVault();
});
