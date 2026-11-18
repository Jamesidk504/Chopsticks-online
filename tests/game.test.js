import test from 'node:test';
import assert from 'node:assert/strict';
import { afterHit, legalSplits, initialState, makeMove } from '../game.js';

test('only exact five kills; 6→1, 7→2, 8→3', () => {
  assert.equal(afterHit(1, 4), 0);
  assert.equal(afterHit(2, 3), 0);
  assert.equal(afterHit(2, 4), 1);
  assert.equal(afterHit(3, 4), 2);
  assert.equal(afterHit(4, 4), 3);
  assert.equal(afterHit(1, 2), 3);
});
test('cannot hit with dead hand or hit a dead hand', () => {
  assert.throws(() => afterHit(0, 2), /living/);
  assert.throws(() => afterHit(3, 0), /living/);
});
test('redistribution preserves total and disallows swapped/no-op', () => {
  assert.deepEqual(legalSplits([4, 0]), [[1, 3], [2, 2], [3, 1]]);
  assert.deepEqual(legalSplits([1, 1]), [[0, 2], [2, 0]]);
  assert.deepEqual(legalSplits([4, 4]), []);
  assert.ok(!legalSplits([1, 2]).some(([a, b]) => a === 2 && b === 1));
});
test('turn changes after attacks and splits; victory stops turn', () => {
  let state = initialState(10, 20);
  const a = makeMove(state, 10, 20, { type: 'hit', from: 0, to: 0 });
  state = a.state;
  assert.deepEqual(state.hands[20], [2, 1]);
  assert.equal(state.turn, 20);
  assert.throws(() => makeMove(state, 10, 20, { type: 'hit', from: 0, to: 0 }), /turn/);
  const b = makeMove(state, 20, 10, { type: 'split', left: 0, right: 3 });
  assert.deepEqual(b.state.hands[20], [0, 3]);
  assert.equal(b.state.turn, 10);
  state = { hands: { 10: [4, 0], 20: [1, 0] }, turn: 10, moveCount: 5 };
  const end = makeMove(state, 10, 20, { type: 'hit', from: 0, to: 0 });
  assert.equal(end.winnerId, 10);
  assert.deepEqual(end.state.hands[20], [0, 0]);
  assert.equal(end.state.turn, null);
});
