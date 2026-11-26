// M-1: weak new master passphrases are refused. Runs with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passphraseProblem, strength } from '../src/strength';

test('weak passphrases are refused', () => {
  for (const p of ['', 'short1!', 'onlyletters', 'abcdefghij', 'aaaaaaaaaaaaaaaaaaaaaaaa', '121212121212121212121', 'Password12']) {
    assert.ok(passphraseProblem(p), `should refuse ${JSON.stringify(p)}`);
  }
});

test('strong passphrases are accepted', () => {
  for (const p of ['blue-kettle-42-orbit', 'correct horse battery staple', 'Tr4in!Kathmandu#Night']) {
    assert.equal(passphraseProblem(p), null, `should accept ${JSON.stringify(p)}`);
  }
  assert.equal(strength('correct horse battery staple'), 4);
});
