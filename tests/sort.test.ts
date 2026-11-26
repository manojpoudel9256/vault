// The list shows the newest entries first. Runs with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortEntries, timeGroup } from '../src/sort';
import type { Entry } from '../src/vault';

const e = (service: string, updatedAt: number): Entry =>
  ({ id: service, category: 'login', service, account: '', type: 'password', secret: 'x', notes: '', tags: [], history: [], createdAt: updatedAt, updatedAt });

test('newest first: the most recently saved or changed entry is on top', () => {
  const list = [e('Old', 1000), e('Newest', 3000), e('Middle', 2000)];
  assert.deepEqual(sortEntries(list, 'newest').map((x) => x.service), ['Newest', 'Middle', 'Old']);
});

test('same time falls back to A-Z; A-Z mode ignores time', () => {
  assert.deepEqual(sortEntries([e('Zoom', 5), e('Apple', 5)], 'newest').map((x) => x.service), ['Apple', 'Zoom']);
  assert.deepEqual(sortEntries([e('Zoom', 9), e('Apple', 1)], 'az').map((x) => x.service), ['Apple', 'Zoom']);
});

test('time headings', () => {
  const now = new Date(2026, 10, 26, 15, 0).getTime();
  assert.equal(timeGroup(new Date(2026, 10, 26, 9, 0).getTime(), now), 'Today');
  assert.equal(timeGroup(new Date(2026, 10, 25, 23, 0).getTime(), now), 'Yesterday');
  assert.equal(timeGroup(new Date(2026, 10, 22).getTime(), now), 'This week');
  assert.equal(timeGroup(new Date(2026, 10, 3).getTime(), now), 'Earlier this month');
  assert.equal(timeGroup(new Date(2026, 8, 3).getTime(), now), 'September 2026');
});
