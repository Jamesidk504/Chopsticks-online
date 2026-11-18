import { startGame, legalSplits, applyMove } from './rules.mjs';

const $ = id => document.getElementById(id);
const app = {
  peer: null, conn: null, host: false, code: '', phase: 'lobby',
  game: null, selected: null, names: ['Host', 'Guest'], player: 0,
  toastTimeout: null
};

function show(view) {
  for (const section of ['lobby', 'waiting', 'connecting', 'arena']) $(section).hidden = section !== view;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function toast(message, bad = false) {
  const el = $('toast'); el.textContent = message; el.classList.toggle('bad', bad); el.hidden = false;
  clearTimeout(app.toastTimeout);
  app.toastTimeout = setTimeout(() => { el.hidden = true; }, 4800);
}
function safeName(s) { return String(s || 'Player').trim().replace(/[<>\u0000-\u001F\u007F]/g, '').slice(0, 18) || 'Player'; }
function username() { return safeName($('nameInput').value); }
function saveName() { try { localStorage.setItem('chopsticks-name', username()); } catch {} }
function roomCode() { return Array.from(crypto.getRandomValues(new Uint8Array(6)), n => n.toString(16).padStart(2, '0')).join('').toUpperCase(); }
function normalizeCode(s) {
  let value = String(s || '').trim();
  try {
    if (/^https?:\/\//i.test(value)) value = new URL(value).hash.replace(/^#room=/i, '');
  } catch {}
  return value.replace(/^#?room=/i, '').replace(/^CSARENA-/i, '').replace(/[-\s]/g, '').toUpperCase();
}
function inviteLink() { return `${location.origin}${location.pathname}#room=${app.code}`; }
function cleanPeer() {
  const c = app.conn, p = app.peer;
  app.conn = null; app.peer = null;
  try { c?.close(); } catch {}
  try { p?.destroy(); } catch {}
}
function home() {
  cleanPeer(); app.phase = 'lobby'; app.selected = null; app.game = null; app.code = '';
  history.replaceState(null, '', location.pathname);
  show('lobby');
}
function checkLibrary() {
  if (typeof window.Peer !== 'function') {
    toast('Connection library failed to load. Check internet access and refresh.', true);
    return false;
  }
  return true;
}
function onPeerError(error) {
  console.warn('Connection error', error);
  const reason = error?.type === 'unavailable-id' ? 'That room code is already taken. Make a new room.' :
    error?.type === 'peer-unavailable' ? 'Room not found. Ask your friend to create a room and keep their tab open.' :
    'Connection failed. Check the room code and try again. Some school networks block peer connections.';
  toast(reason, true);
  if (app.phase === 'connecting' || app.phase === 'waiting') home();
}
function setupPeer(peer) {
  app.peer = peer;
  peer.on('error', onPeerError);
  peer.on('disconnected', () => {
    if (app.conn?.open) return; // Direct gameplay can survive losing the signaling connection.
    if (app.phase !== 'lobby') toast('Lost the matchmaking connection. Try again.', true);
  });
}
function createRoom() {
  if (!checkLibrary()) return;
  saveName(); cleanPeer();
  app.host = true; app.player = 0; app.code = roomCode(); app.phase = 'waiting';
  app.names = [username(), 'Guest']; app.selected = null; app.game = null;
  $('roomCode').textContent = app.code;
  $('waitingStatus').textContent = 'Connecting to the free matchmaking network…';
  show('waiting');
  const peer = new window.Peer(`csarena-${app.code.toLowerCase()}`);
  setupPeer(peer);
  peer.on('open', () => {
    if (peer !== app.peer) return;
    $('waitingStatus').textContent = '● Room is live. Share the link and keep this page open.';
  });
  peer.on('connection', connection => {
    if (app.conn || app.phase !== 'waiting') { connection.on('open', () => connection.close()); return; }
    bindConnection(connection);
  });
}
function joinRoom(codeInput = $('joinInput').value) {
  if (!checkLibrary()) return;
  const code = normalizeCode(codeInput);
  if (!/^[0-9A-F]{12}$/.test(code)) return toast('Enter a valid 12-character room code.', true);
  saveName(); cleanPeer();
  app.host = false; app.player = 1; app.code = code; app.names = ['Host', username()];
  app.game = null; app.phase = 'connecting'; app.selected = null;
  $('connectStatus').textContent = 'Finding the room…';
  show('connecting');
  const peer = new window.Peer();
  setupPeer(peer);
  peer.on('open', () => {
    if (peer !== app.peer) return;
    const connection = peer.connect(`csarena-${code.toLowerCase()}`, { reliable: true, serialization: 'json' });
    bindConnection(connection);
  });
}
function send(message) {
  if (app.conn?.open) { app.conn.send(message); return true; }
  return false;
}
function bindConnection(connection) {
  app.conn = connection;
  connection.on('open', () => {
    if (app.conn !== connection) return;
    if (app.host) {
      $('waitingStatus').textContent = 'Challenger connected! Starting match…';
    } else {
      $('connectStatus').textContent = 'Connected. Setting up the game…';
      send({ type: 'hello', name: username() });
    }
  });
  connection.on('data', message => {
    if (app.conn !== connection || !message || typeof message !== 'object') return;
    try { received(message); } catch (e) { console.warn(e); toast(e.message || 'Invalid game message.', true); }
  });
  connection.on('error', e => {
    console.warn(e); toast('Connection error. Try creating a new room.', true);
  });
  connection.on('close', () => {
    if (app.conn !== connection) return;
    app.conn = null;
    if (app.phase === 'game' || app.phase === 'ended') {
      app.phase = 'ended';
      $('moveHint').textContent = 'Your opponent disconnected. Start a new room to play again.';
      $('resultArea').hidden = false; $('resultTitle').textContent = 'Opponent disconnected';
      $('resultCaption').textContent = 'This match has ended. Your progress is not saved.';
      $('rematchBtn').hidden = true; $('rematchHint').hidden = true;
      $('splitArea').hidden = true; setHandsDisabled();
    } else if (app.phase !== 'lobby') {
      toast('The other player disconnected. Start a new room.', true);
      home();
    }
  });
}
function received(message) {
  if (app.host) {
    if (message.type === 'hello' && app.phase === 'waiting') {
      app.names[1] = safeName(message.name);
      app.game = startGame(); app.phase = 'game';
      broadcast(); renderGame();
    } else if (message.type === 'move' && app.phase === 'game') {
      // The host is authoritative: no cheating by choosing another player's turn or an illegal move.
      updateGame(applyMove(app.game, 1, message.move));
    }
  } else if (message.type === 'state') {
    if (!validGame(message.game)) throw new Error('Received invalid game state.');
    app.game = message.game;
    app.names = Array.isArray(message.names) ? [safeName(message.names[0]), safeName(message.names[1])] : app.names;
    app.phase = app.game.winner === null ? 'game' : 'ended';
    app.selected = null;
    renderGame();
  }
}
function validGame(g) {
  return g && Array.isArray(g.hands) && g.hands.length === 2 &&
    g.hands.every(h => Array.isArray(h) && h.length === 2 && h.every(n => Number.isInteger(n) && n >= 0 && n <= 4)) &&
    [0, 1, null].includes(g.turn) && [0, 1, null].includes(g.winner) &&
    Number.isInteger(g.moves) && g.moves >= 0;
}
function broadcast() { send({ type: 'state', game: app.game, names: app.names }); }
function updateGame(game) {
  app.game = game; app.phase = game.winner === null ? 'game' : 'ended';
  app.selected = null; broadcast(); renderGame();
}
function chooseMove(move) {
  if (app.phase !== 'game' || !app.game || app.game.turn !== app.player || !app.conn?.open) return;
  if (app.host) {
    try { updateGame(applyMove(app.game, 0, move)); } catch (e) { toast(e.message, true); }
  } else {
    try { applyMove(app.game, 1, move); } catch (e) { return toast(e.message, true); }
    if (!send({ type: 'move', move })) toast('Opponent disconnected.', true);
  }
}
function newHand(value, name, enemy, index) {
  const btn = document.createElement('button'); btn.type = 'button';
  const myTurn = app.phase === 'game' && app.game?.turn === app.player && app.conn?.open;
  const active = enemy ? myTurn && app.selected !== null : myTurn;
  btn.disabled = !active || value === 0;
  btn.className = `hand${enemy ? ' enemy' : ''}${value === 0 ? ' dead' : ''}${!enemy && app.selected === index ? ' selected' : ''}`;
  btn.setAttribute('aria-label', `${name} hand: ${value} fingers${value ? '' : ', out'}`);
  const fingers = document.createElement('div'); fingers.className = 'fingers';
  for (let i = 0; i < 4; i++) { const span = document.createElement('span'); span.className = `finger${i < value ? ' on' : ''}`; fingers.append(span); }
  const number = document.createElement('div'); number.className = 'number'; number.textContent = value || 'OUT';
  const small = document.createElement('small'); small.textContent = name;
  btn.append(fingers, number, small);
  btn.addEventListener('click', () => {
    if (enemy) chooseMove({ type: 'hit', from: app.selected, to: index });
    else { app.selected = app.selected === index ? null : index; renderGame(); }
  });
  return btn;
}
function setHandsDisabled() {
  document.querySelectorAll('#arena .hand').forEach(h => { h.disabled = true; });
}
function renderGame() {
  const g = app.game;
  if (!g) return;
  show('arena');
  $('matchCode').textContent = `ROOM ${app.code}`;
  $('myName').textContent = app.names[app.player];
  $('opponentName').textContent = app.names[1 - app.player];
  $('matchSubtitle').textContent = `${app.names[app.player]} vs ${app.names[1 - app.player]}`;
  const me = g.hands[app.player], them = g.hands[1 - app.player];
  $('myHands').replaceChildren(...me.map((n, i) => newHand(n, i ? 'Right hand' : 'Left hand', false, i)));
  $('opponentHands').replaceChildren(...them.map((n, i) => newHand(n, i ? 'Right hand' : 'Left hand', true, i)));
  const myTurn = g.turn === app.player && app.phase === 'game';
  $('turnLabel').textContent = app.phase === 'ended' ? 'GAME OVER' : myTurn ? '● YOUR TURN' : '● OPPONENT’S TURN';
  $('turnLabel').classList.toggle('theirs', !myTurn);
  $('splitArea').hidden = !myTurn;
  $('splits').replaceChildren();
  if (myTurn) {
    for (const [left, right] of legalSplits(me)) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn secondary'; btn.textContent = `${left} + ${right}`;
      btn.addEventListener('click', () => chooseMove({ type: 'split', left, right }));
      $('splits').append(btn);
    }
  }
  $('moveHint').textContent = app.phase === 'ended' ? 'The match is over.' : !myTurn ? `Waiting for ${app.names[1 - app.player]}…` : app.selected === null ?
    'Tap one of your hands, then tap an opponent’s living hand.' : `Your ${app.selected ? 'right' : 'left'} hand is selected. Now tap an opponent’s hand.`;
  $('resultArea').hidden = app.phase !== 'ended';
  if (app.phase === 'ended') {
    const won = g.winner === app.player;
    $('resultTitle').textContent = won ? '★ YOU WON!' : 'Good game!';
    $('resultCaption').textContent = won ? 'You knocked out both hands. Absolute cinema.' : `${app.names[1 - app.player]} won this round. Time for revenge?`;
    $('rematchBtn').hidden = !app.host;
    $('rematchHint').hidden = !!app.host;
  }
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); toast('Copied to clipboard!'); }
  catch { toast('Copying was blocked. Select and copy the room code above.', true); }
}
function rematch() {
  if (!app.host || !app.conn?.open || app.phase !== 'ended') return;
  updateGame(startGame());
}
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', () => joinRoom());
$('joinInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
$('homeBtn').addEventListener('click', () => { if (app.phase === 'lobby' || confirm('Leave your current match?')) home(); });
$('leaveWaitingBtn').addEventListener('click', home);
$('cancelJoinBtn').addEventListener('click', home);
$('leaveGameBtn').addEventListener('click', () => { if (confirm('Leave the match? Your opponent will disconnect.')) home(); });
$('copyLinkBtn').addEventListener('click', () => copyText(inviteLink()));
$('copyCodeBtn').addEventListener('click', () => copyText(app.code));
$('rematchBtn').addEventListener('click', rematch);
try { $('nameInput').value = safeName(localStorage.getItem('chopsticks-name') || 'Player'); } catch {}
const inviteMatch = location.hash.match(/^#room=([0-9a-f]{12})$/i);
if (inviteMatch) { $('joinInput').value = inviteMatch[1].toUpperCase(); joinRoom(inviteMatch[1]); }
