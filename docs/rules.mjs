// Browser-only Chopsticks rules (both peers check these; the room host has final authority).
// Exactly 5 eliminates a hand; sums 6,7,8 wrap to 1,2,3.
export function startGame() {
  return { hands: [[1, 1], [1, 1]], turn: 0, winner: null, moves: 0 };
}

export function legalSplits(hands) {
  if (!Array.isArray(hands) || hands.length !== 2 || hands.some(n => !Number.isInteger(n) || n < 0 || n > 4)) return [];
  const total = hands[0] + hands[1];
  const before = [...hands].sort((a, b) => a - b).join(',');
  const options = [];
  for (let left = 0; left <= 4; left++) {
    const right = total - left;
    if (right < 0 || right > 4) continue;
    if ([left, right].sort((a, b) => a - b).join(',') !== before) options.push([left, right]);
  }
  return options;
}

export function applyMove(game, player, move) {
  if (!game || game.winner !== null || game.turn !== player || ![0, 1].includes(player)) throw new Error('Not your turn.');
  if (!move || typeof move !== 'object') throw new Error('Invalid move.');
  const next = { hands: game.hands.map(h => [...h]), turn: 1 - player, winner: null, moves: game.moves + 1 };
  const me = next.hands[player], them = next.hands[1 - player];
  if (move.type === 'hit') {
    if (![0, 1].includes(move.from) || ![0, 1].includes(move.to) || me[move.from] === 0 || them[move.to] === 0) throw new Error('Choose two living hands.');
    const sum = me[move.from] + them[move.to];
    them[move.to] = sum === 5 ? 0 : sum > 5 ? sum - 5 : sum;
  } else if (move.type === 'split') {
    if (!legalSplits(me).some(([left, right]) => left === move.left && right === move.right)) throw new Error('That split is not allowed.');
    me[0] = move.left; me[1] = move.right;
  } else throw new Error('Unknown move.');
  if (them[0] === 0 && them[1] === 0) { next.winner = player; next.turn = null; }
  return next;
}
