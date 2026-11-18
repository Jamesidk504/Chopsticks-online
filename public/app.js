'use strict';

const $ = id => document.getElementById(id);
const state = { user: null, tab: 'lobby', currentGame: null, games: [], friends: null, authMode: 'login', selectedHand: null, queued: false, queueSince: 0, stream: null, refreshTimer: null };

async function api(path, data) {
  const options = { credentials: 'same-origin' };
  if (data !== undefined) {
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(data);
  }
  let response;
  try { response = await fetch(path, options); }
  catch { throw new Error('Unable to connect to the game server.'); }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user && path !== '/api/login') showLoggedOut();
    throw new Error(result.error || 'Something went wrong.');
  }
  return result;
}
function elm(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.className = css;
  if (text !== undefined) node.textContent = text;
  return node;
}
function clear(container) { container.replaceChildren(); }
function toast(message, error = false) {
  const t = $('toast'); t.textContent = message; t.classList.toggle('error', error); t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.hidden = true, 4000);
}
function call(action) { return async (...args) => { try { await action(...args); } catch (e) { toast(e.message, true); } }; }
function initials(name) { return (name || 'P').slice(0, 1).toUpperCase(); }
function displayView(view) {
  state.tab = view;
  $('authView').hidden = true;
  $('appView').hidden = false;
  for (const v of ['lobby', 'friends', 'profile', 'game']) $(`${v}View`).hidden = v !== view;
  if (view !== 'game') state.currentGame = null;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function showLoggedOut() {
  state.user = null; state.currentGame = null; state.games = []; state.queued = false;
  state.stream?.close(); state.stream = null;
  $('headerRight').hidden = true;
  $('appView').hidden = true;
  $('authView').hidden = false;
  $('connectionDot').classList.remove('connected');
}
function syncUser(u) {
  state.user = u;
  $('headerRight').hidden = false;
  $('headerUsername').textContent = u.username;
  $('headerAvatar').textContent = initials(u.username);
  $('winsNumber').textContent = u.wins;
  $('lossesNumber').textContent = u.losses;
  $('rateNumber').textContent = u.wins + u.losses ? `${Math.round(u.wins / (u.wins + u.losses) * 100)}%` : '—';
  $('profileAvatar').textContent = initials(u.username);
  $('profileUsername').textContent = u.username;
  const totals = [[u.wins, 'Wins'], [u.losses, 'Losses'], [u.wins + u.losses, 'Matches']];
  $('profileStats').replaceChildren(...totals.map(([n, name]) => { const box = elm('div'); box.append(elm('b', '', String(n)), elm('small', '', name)); return box; }));
}
function connectEvents() {
  state.stream?.close();
  const stream = new EventSource('/api/events');
  state.stream = stream;
  stream.onopen = () => $('connectionDot').classList.add('connected');
  stream.onerror = () => $('connectionDot').classList.remove('connected');
  stream.addEventListener('sync', () => {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => call(refreshAll)(), 100);
  });
}
async function refreshAll() {
  if (!state.user) return;
  const [me, games, friends, queue] = await Promise.all([
    api('/api/me'), api('/api/games'), api('/api/friends'), api('/api/queue')
  ]);
  syncUser(me.user);
  const existing = state.games.map(g => g.id);
  state.games = games.games;
  state.friends = friends;
  renderMatches(); renderFriends();
  $('friendBadge').hidden = friends.incoming.length === 0;
  $('friendBadge').textContent = friends.incoming.length;
  if (state.queued && !queue.queued) {
    state.queued = false;
    renderQueue();
    const newMatch = games.games.find(g => g.status === 'active' && !existing.includes(g.id) && g.createdAt >= state.queueSince - 2000);
    if (newMatch && !state.currentGame) { toast('Opponent found! Good luck.'); await openGame(newMatch.id); }
  } else {
    state.queued = queue.queued;
    renderQueue();
  }
  if (state.currentGame) {
    const current = state.games.find(g => g.id === state.currentGame);
    if (current) renderGame(current);
  }
}
function setAuthMode(mode) {
  state.authMode = mode;
  $('loginTab').classList.toggle('selected', mode === 'login');
  $('registerTab').classList.toggle('selected', mode === 'register');
  $('authTitle').textContent = mode === 'login' ? 'Welcome back.' : 'Join the arena.';
  $('authSubtitle').textContent = mode === 'login' ? 'Your next win is waiting.' : 'Make an account to save every victory.';
  $('authSubmit').firstChild.textContent = mode === 'login' ? 'Log in ' : 'Create account ';
  $('passwordInput').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}
async function submitAuth(event) {
  event.preventDefault();
  const username = $('usernameInput').value.trim(), password = $('passwordInput').value;
  const button = $('authSubmit'); button.disabled = true;
  try {
    const result = await api(`/api/${state.authMode === 'login' ? 'login' : 'register'}`, { username, password });
    $('passwordInput').value = '';
    syncUser(result.user); displayView('lobby'); connectEvents(); await refreshAll();
    checkInviteHash();
    toast(`Welcome ${state.authMode === 'login' ? 'back' : 'to the arena'}, ${result.user.username}!`);
  } finally { button.disabled = false; }
}
function button(label, css, handler) {
  const b = elm('button', `button small ${css}`, label);
  b.type = 'button'; b.addEventListener('click', call(handler)); return b;
}
function miniAvatar(username) { return elm('span', 'avatar', initials(username)); }
function listInfo(title, subtitle, avatarName = title) {
  const info = elm('div', 'list-item-info'); const texts = elm('div');
  texts.append(elm('strong', '', title), elm('small', '', subtitle));
  info.append(miniAvatar(avatarName), texts); return info;
}
function timeAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function renderMatches() {
  const holder = $('matchesList'); clear(holder);
  const games = state.games.filter(g => g.status !== 'cancelled').slice(0, 20);
  if (!games.length) return holder.append(elm('p', 'empty-state', 'No matches yet. Find an opponent or create a room!'));
  for (const g of games) {
    const isCreator = g.player1.id === state.user.id;
    const other = isCreator ? (g.player2?.username || g.invited?.username || 'Awaiting player') : g.player1.username;
    const item = elm('div', 'list-item');
    const subtitle = g.status === 'waiting' ? `Room ${g.code} · ${timeAgo(g.createdAt)}` : `${g.status === 'active' ? 'In progress' : 'Completed'} · ${timeAgo(g.updatedAt)}`;
    item.append(listInfo(`vs ${other}`, subtitle, other));
    const actions = elm('div', 'list-actions');
    let status = 'Waiting', className = 'wait';
    if (g.status === 'active') { status = g.state?.turn === state.user.id ? 'Your turn' : 'Live'; className = 'live'; }
    if (g.status === 'finished') { status = g.winnerId === state.user.id ? 'Win' : 'Loss'; className = g.winnerId === state.user.id ? 'win' : 'loss'; }
    actions.append(elm('span', `status-pill ${className}`, status));
    if (g.isInvited && g.status === 'waiting') actions.append(button('Accept', 'primary', () => joinRoom(g.code)));
    else actions.append(button(g.status === 'waiting' ? 'Open' : g.status === 'active' ? 'Play' : 'View', 'outline', () => openGame(g.id)));
    item.append(actions); holder.append(item);
  }
}
function renderFriends() {
  if (!state.friends) return;
  const friends = state.friends;
  $('friendsCount').textContent = String(friends.friends.length);
  clear($('friendsList')); clear($('incomingRequests')); clear($('outgoingRequests'));
  for (const u of friends.friends) {
    const item = elm('div', 'list-item');
    item.append(listInfo(u.username, `${u.online ? '● Online' : 'Offline'} · ${u.wins}W / ${u.losses}L`));
    const actions = elm('div', 'list-actions');
    actions.append(button('Challenge', 'primary', () => createRoom(u.id)));
    actions.append(button('Remove', 'outline', async () => {
      if (!confirm(`Remove ${u.username} from friends?`)) return;
      await api('/api/friends/remove', { friendId: u.id }); await refreshAll();
    }));
    item.append(actions); $('friendsList').append(item);
  }
  if (!friends.friends.length) $('friendsList').append(elm('p', 'empty-state', 'No friends yet. Search for someone above.'));
  for (const r of friends.incoming) {
    const item = elm('div', 'list-item'); item.append(listInfo(r.username, 'Sent you a friend request'));
    const actions = elm('div', 'list-actions');
    actions.append(button('Accept', 'primary', async () => { await api('/api/friends/respond', { requestId: r.id, accept: true }); await refreshAll(); toast('Friend added!'); }));
    actions.append(button('Decline', 'outline', async () => { await api('/api/friends/respond', { requestId: r.id, accept: false }); await refreshAll(); }));
    item.append(actions); $('incomingRequests').append(item);
  }
  if (!friends.incoming.length) $('incomingRequests').append(elm('p', 'empty-state', 'No requests right now.'));
  for (const r of friends.outgoing) {
    const item = elm('div', 'list-item'); item.append(listInfo(r.username, 'Pending their response'));
    item.append(elm('span', 'status-pill wait', 'Sent')); $('outgoingRequests').append(item);
  }
  if (!friends.outgoing.length) $('outgoingRequests').append(elm('p', 'empty-state', 'No sent requests.'));
}
async function searchFriends() {
  const query = $('friendSearchInput').value.trim();
  const holder = $('searchResults'); clear(holder);
  if (query.length < 2) return holder.append(elm('p', 'empty-state', 'Enter at least 2 characters to search.'));
  const { results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
  if (!results.length) return holder.append(elm('p', 'empty-state', 'No players found.'));
  for (const u of results) {
    const item = elm('div', 'list-item'); item.append(listInfo(u.username, `${u.wins} wins · ${u.losses} losses`));
    const sent = state.friends.outgoing.some(r => r.userId === u.id);
    const request = button(u.isFriend ? 'Friends ✓' : sent ? 'Requested' : 'Add friend ＋', 'outline', async () => {
      await api('/api/friends/request', { username: u.username }); await refreshAll(); await searchFriends(); toast('Friend request sent!');
    });
    request.disabled = u.isFriend || sent;
    item.append(request); holder.append(item);
  }
}
function renderQueue() {
  $('quickMatchBtn').textContent = state.queued ? '✕ Cancel matchmaking' : '⚡ Find an opponent →';
  $('quickMatchBtn').classList.toggle('secondary', state.queued);
  $('quickMatchBtn').classList.toggle('primary', !state.queued);
  $('queueStatus').classList.toggle('active', state.queued);
  $('queueStatus').textContent = state.queued ? '● Looking for an opponent… Keep this tab open.' : "Match with another player who's searching.";
}
async function quickmatch() {
  if (state.queued) {
    await api('/api/queue/leave', {}); state.queued = false; renderQueue(); return;
  }
  state.queueSince = Date.now();
  const answer = await api('/api/queue/join', {});
  state.queued = answer.queued;
  renderQueue();
  if (answer.game) { toast('Opponent found!'); await openGame(answer.game.id); }
}
async function createRoom(friendId = null) {
  if (state.queued) { await api('/api/queue/leave', {}); state.queued = false; renderQueue(); }
  const { game } = await api('/api/games', friendId ? { friendId } : {});
  await refreshAll(); await openGame(game.id);
  if (friendId) toast('Challenge sent to your friend!');
}
async function joinRoom(providedCode) {
  const code = (providedCode || $('joinCodeInput').value).trim().toUpperCase();
  if (!code) throw new Error('Enter a room code.');
  const { game } = await api('/api/games/join', { code });
  $('joinCodeInput').value = '';
  history.replaceState(null, '', location.pathname);
  await refreshAll(); await openGame(game.id);
}
async function openGame(id) {
  const { game } = await api(`/api/games/${id}`);
  state.currentGame = id; state.selectedHand = null;
  displayView('game'); state.currentGame = id; renderGame(game);
}
function renderHand(value, label, css, clickable, onClick, selected = false) {
  const b = elm('button', `hand-tile ${css}${value === 0 ? ' dead' : ''}${selected ? ' selected' : ''}`);
  b.type = 'button'; b.disabled = !clickable || value === 0;
  b.setAttribute('aria-label', `${label}: ${value} finger${value === 1 ? '' : 's'}${value === 0 ? ' (out)' : ''}`);
  const hand = elm('div', 'finger-display');
  for (let i = 1; i <= 4; i++) hand.append(elm('span', `finger${i <= value ? ' on' : ''}`));
  b.append(hand, elm('span', 'hand-value', value === 0 ? 'OUT' : String(value)), elm('span', 'hand-label', label));
  if (clickable) b.addEventListener('click', onClick);
  return b;
}
function legalSplits(hands) {
  const total = hands[0] + hands[1];
  const before = [...hands].sort().join(',');
  const splits = [];
  for (let left = 0; left <= 4; left++) {
    const right = total - left;
    if (right < 0 || right > 4) continue;
    if ([left, right].sort().join(',') !== before) splits.push([left, right]);
  }
  return splits;
}
async function submitMove(move) {
  const gameId = state.currentGame;
  const { game } = await api(`/api/games/${gameId}/move`, move);
  state.selectedHand = null;
  renderGame(game); await refreshAll();
}
function renderGame(game) {
  if (!game || !state.user) return;
  if (state.currentGame !== game.id) return;
  $('roomTag').textContent = `ROOM ${game.code}`;
  $('waitingPanel').hidden = game.status !== 'waiting';
  $('playingPanel').hidden = game.status !== 'active';
  $('finishedPanel').hidden = game.status !== 'finished';
  $('forfeitBtn').hidden = game.status !== 'active';
  const opponent = game.player1.id === state.user.id ? game.player2 : game.player1;
  $('gameHeading').textContent = game.status === 'waiting' ? 'Waiting to play.' : 'The showdown.';
  $('gameSubtitle').textContent = game.status === 'waiting' ? 'Your room is ready. Bring in your opponent.' : `You vs ${opponent?.username || 'opponent'}`;
  if (game.status === 'waiting') {
    $('shareCode').textContent = game.code;
    $('cancelRoomBtn').hidden = game.player1.id !== state.user.id;
    return;
  }
  if (game.status === 'finished') {
    const won = game.winnerId === state.user.id;
    $('resultIcon').textContent = won ? '★' : '✦';
    $('resultIcon').style.color = won ? 'var(--teal)' : 'var(--pink)';
    $('resultTitle').textContent = won ? 'You won!' : 'Good game!';
    $('resultSubtitle').textContent = game.finishReason === 'forfeit'
      ? (won ? 'Your opponent forfeited. A win has been added to your record.' : 'You forfeited. A loss has been added to your record.')
      : (won ? 'Both enemy hands are out. Your win is saved!' : 'Both your hands were knocked out. Time for a rematch?');
    return;
  }
  if (game.status !== 'active') return;
  const myId = state.user.id, theirId = opponent.id;
  const myTurn = game.state.turn === myId;
  const mine = game.state.hands[myId];
  const theirs = game.state.hands[theirId];
  if (!myTurn) state.selectedHand = null;
  $('opponentName').textContent = opponent.username;
  $('myName').textContent = state.user.username;
  $('turnBanner').textContent = myTurn ? '● YOUR TURN' : '● OPPONENT’S TURN';
  $('turnBanner').className = `turn-banner${myTurn ? '' : ' their-turn'}`;
  const myHolder = $('myHands'), theirHolder = $('opponentHands');
  clear(myHolder); clear(theirHolder);
  for (let i = 0; i < 2; i++) {
    myHolder.append(renderHand(mine[i], i === 0 ? 'Left hand' : 'Right hand', 'mine', myTurn, () => {
      state.selectedHand = state.selectedHand === i ? null : i;
      renderGame(game);
    }, state.selectedHand === i));
    theirHolder.append(renderHand(theirs[i], i === 0 ? 'Left hand' : 'Right hand', 'opponent', myTurn && state.selectedHand !== null, call(() => submitMove({ type: 'hit', from: state.selectedHand, to: i }))));
  }
  $('moveHint').textContent = !myTurn ? `Waiting for ${opponent.username} to move…` :
    state.selectedHand === null ? 'Tap one of your living hands, then tap an opponent’s living hand.' :
    `Selected your ${state.selectedHand === 0 ? 'left' : 'right'} hand. Now tap an opponent's hand to attack.`;
  $('splitSection').hidden = !myTurn;
  const options = legalSplits(mine);
  clear($('splitButtons'));
  for (const [left, right] of options) {
    $('splitButtons').append(button(`${left} + ${right}`, 'outline', () => submitMove({ type: 'split', left, right })));
  }
  if (myTurn && !options.length) $('splitButtons').append(elm('span', 'muted', 'No splits available.'));
}
async function copy(text) {
  if (!navigator.clipboard?.writeText) throw new Error('Copying is not supported in this browser.');
  await navigator.clipboard.writeText(text); toast('Copied!');
}
function checkInviteHash() {
  const match = location.hash.match(/^#room=([A-Z2-9]{7})$/i);
  if (match && state.user) { displayView('lobby'); $('joinCodeInput').value = match[1].toUpperCase(); toast('Room code filled in. Press Join to play!'); }
}

$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('registerTab').addEventListener('click', () => setAuthMode('register'));
$('authForm').addEventListener('submit', call(submitAuth));
$('brandBtn').addEventListener('click', () => { if (state.user) displayView('lobby'); });
$('headerFriendsBtn').addEventListener('click', () => displayView('friends'));
$('profileBtn').addEventListener('click', () => displayView('profile'));
$('backFromFriends').addEventListener('click', () => displayView('lobby'));
$('backFromProfile').addEventListener('click', () => displayView('lobby'));
$('backToLobby').addEventListener('click', () => displayView('lobby'));
$('finishBackBtn').addEventListener('click', () => displayView('lobby'));
$('quickMatchBtn').addEventListener('click', call(quickmatch));
$('createRoomBtn').addEventListener('click', call(() => createRoom()));
$('joinRoomBtn').addEventListener('click', call(() => joinRoom()));
$('joinCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') call(() => joinRoom())(); });
$('refreshBtn').addEventListener('click', call(refreshAll));
$('searchFriendsBtn').addEventListener('click', call(searchFriends));
$('friendSearchInput').addEventListener('keydown', event => { if (event.key === 'Enter') call(searchFriends)(); });
$('copyCodeBtn').addEventListener('click', call(() => copy($('shareCode').textContent)));
$('copyLinkBtn').addEventListener('click', call(() => copy(`${location.origin}/#room=${$('shareCode').textContent}`)));
$('cancelRoomBtn').addEventListener('click', call(async () => {
  if (!confirm('Cancel this room?')) return;
  await api(`/api/games/${state.currentGame}/cancel`, {}); displayView('lobby'); await refreshAll();
}));
$('forfeitBtn').addEventListener('click', call(async () => {
  if (!confirm('Forfeit this match? It will count as a loss.')) return;
  const { game } = await api(`/api/games/${state.currentGame}/forfeit`, {});
  renderGame(game); await refreshAll();
}));
$('logoutBtn').addEventListener('click', call(async () => { await api('/api/logout', {}); showLoggedOut(); }));
window.addEventListener('hashchange', checkInviteHash);
setInterval(() => { if (state.queued && state.user) call(async () => {
  const response = await api('/api/queue/join', {});
  if (response.game) { state.queued = false; renderQueue(); toast('Opponent found!'); await openGame(response.game.id); }
})() }, 20000);

(async () => {
  try {
    const { user } = await api('/api/me');
    syncUser(user); displayView('lobby'); connectEvents(); await refreshAll(); checkInviteHash();
  } catch { showLoggedOut(); }
})();
