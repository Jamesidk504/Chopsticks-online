/** Server-authoritative Chopsticks rules.
 * A total of exactly 5 knocks out a hand; totals over 5 wrap (6→1, 7→2, 8→3).
 * One move per turn: attack or redistribute the fingers on your own hands.
 */
export function afterHit(from, target) {
  if (!Number.isInteger(from) || !Number.isInteger(target) || from < 1 || from > 4 || target < 1 || target > 4) {
    throw new Error('Choose two living hands to attack.');
  }
  const sum = from + target;
  return sum === 5 ? 0 : sum > 5 ? sum - 5 : sum;
}

export function legalSplits(hands) {
  if (!Array.isArray(hands) || hands.length !== 2 || hands.some(n => !Number.isInteger(n) || n < 0 || n > 4)) {
    throw new Error('Invalid hands.');
  }
  const total = hands[0] + hands[1];
  const before = [...hands].sort((a, b) => a - b).join(',');
  const options = [];
  for (let left = 0; left <= 4; left++) {
    const right = total - left;
    if (right < 0 || right > 4) continue;
    if ([left, right].sort((a, b) => a - b).join(',') === before) continue; // No passes or simple swaps.
    options.push([left, right]);
  }
  return options;
}

export function initialState(firstPlayerId, secondPlayerId) {
  return { hands: { [firstPlayerId]: [1, 1], [secondPlayerId]: [1, 1] }, turn: firstPlayerId, lastMove: null, moveCount: 0 };
}

export function makeMove(state, playerId, opponentId, move) {
  if (!state || state.turn !== playerId) throw new Error('It is not your turn.');
  if (!move || typeof move !== 'object') throw new Error('Invalid move.');
  const mine = [...state.hands[playerId]];
  const theirs = [...state.hands[opponentId]];
  let lastMove;
  if (move.type === 'hit') {
    const { from, to } = move;
    if (![0, 1].includes(from) || ![0, 1].includes(to)) throw new Error('Pick a valid hand.');
    theirs[to] = afterHit(mine[from], theirs[to]);
    lastMove = { type: 'hit', from, to, playerId };
  } else if (move.type === 'split') {
    const { left, right } = move;
    if (!legalSplits(mine).some(([a, b]) => a === left && b === right)) {
      throw new Error('That redistribution is not allowed.');
    }
    mine[0] = left;
    mine[1] = right;
    lastMove = { type: 'split', left, right, playerId };
  } else {
    throw new Error('Unknown move type.');
  }
  const won = theirs[0] === 0 && theirs[1] === 0;
  const newState = {
    hands: { ...state.hands, [playerId]: mine, [opponentId]: theirs },
    turn: won ? null : opponentId,
    lastMove,
    moveCount: state.moveCount + 1
  };
  return { state: newState, winnerId: won ? playerId : null };
}
