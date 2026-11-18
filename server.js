import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDB } from './db.js';
import { initialState, makeMove } from './game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const db = createDB();
const PORT = Number(process.env.PORT || 3000);
const sessionDuration = 30 * 24 * 60 * 60 * 1000;
const online = new Map(); // One running server instance, one SQLite data volume.
const attempts = new Map();
const signupAttempts = new Map();
const now = () => Date.now();
const id = () => crypto.randomUUID();
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const codeChars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const makeCode = () => Array.from(crypto.randomBytes(7), b => codeChars[b % codeChars.length]).join('');

function problem(status, message) { const e = new Error(message); e.status = status; return e; }
function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(body));
}
function cookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const part = cookies.find(x => x.trim().startsWith(`${name}=`));
  return part ? part.trim().slice(name.length + 1) : '';
}
function currentUser(req) {
  const token = cookie(req, 'arena_session');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = db.prepare(`SELECT u.id, u.username, u.wins, u.losses, s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token));
  return session && session.expires_at > now() ? session : null;
}
function userRequired(req) { const user = currentUser(req); if (!user) throw problem(401, 'Please log in.'); return user; }
function profile(u) { return { id: u.id, username: u.username, wins: u.wins, losses: u.losses }; }
function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const expected = Buffer.from(hex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, now() + sessionDuration);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `arena_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secure}`);
}
function preventBruteForce(req, username) {
  const key = `${(req.socket.remoteAddress || 'unknown').slice(0, 80)}:${String(username).toLowerCase()}`;
  const previous = attempts.get(key) || [];
  const fresh = previous.filter(x => now() - x < 15 * 60 * 1000);
  if (fresh.length >= 12) throw problem(429, 'Too many login attempts. Try again later.');
  fresh.push(now()); attempts.set(key, fresh);
}
function limitSignups(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const recent = (signupAttempts.get(key) || []).filter(x => now() - x < 60 * 60 * 1000);
  if (recent.length >= 12) throw problem(429, 'Too many new accounts from this connection. Try again later.');
  recent.push(now()); signupAttempts.set(key, recent);
}
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString('utf8');
    if (data.length > 4096) throw problem(413, 'Request is too large.');
  }
  try { return data ? JSON.parse(data) : {}; }
  catch { throw problem(400, 'Invalid JSON.'); }
}
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // Non-browser scripts can send requests without an Origin header.
  try { if (new URL(origin).host === req.headers.host) return; } catch {}
  throw problem(403, 'Cross-origin request blocked.');
}
function notify(userId, kind = 'sync') {
  const listeners = online.get(userId);
  if (!listeners) return;
  for (const res of listeners) {
    try { res.write(`event: ${kind}\ndata: ${JSON.stringify({ at: now() })}\n\n`); } catch {}
  }
}
function stream(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(res);
  const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 23000);
  req.on('close', () => {
    clearInterval(timer);
    online.get(user.id)?.delete(res);
    if (!online.get(user.id)?.size) online.delete(user.id);
  });
}
function isFriend(a, b) {
  const low = Math.min(a, b), high = Math.max(a, b);
  return !!db.prepare('SELECT 1 FROM friends WHERE low_id=? AND high_id=?').get(low, high);
}
function friendData(userId) {
  const friends = db.prepare(`SELECT u.id,u.username,u.wins,u.losses FROM friends f JOIN users u ON
    u.id=CASE WHEN f.low_id=? THEN f.high_id ELSE f.low_id END
    WHERE f.low_id=? OR f.high_id=? ORDER BY u.username COLLATE NOCASE`).all(userId, userId, userId)
    .map(u => ({ ...profile(u), online: !!online.get(u.id)?.size }));
  const incoming = db.prepare(`SELECT r.id, u.username, u.id as userId FROM friend_requests r
    JOIN users u ON u.id=r.from_id WHERE r.to_id=? ORDER BY r.created_at DESC`).all(userId);
  const outgoing = db.prepare(`SELECT r.id, u.username, u.id as userId FROM friend_requests r
    JOIN users u ON u.id=r.to_id WHERE r.from_id=? ORDER BY r.created_at DESC`).all(userId);
  return { friends, incoming, outgoing };
}
function createGame(player1, invitedUserId = null) {
  let code;
  do { code = makeCode(); } while (db.prepare('SELECT 1 FROM games WHERE code=?').get(code));
  const gameId = id();
  db.prepare(`INSERT INTO games(id,code,player1_id,invited_user_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(gameId, code, player1, invitedUserId, 'waiting', now(), now());
  return db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
}
function activeGame(row, player2) {
  const state = initialState(row.player1_id, player2);
  db.prepare(`UPDATE games SET player2_id=?,invited_user_id=NULL,status='active',state_json=?,updated_at=? WHERE id=? AND status='waiting'`)
    .run(player2, JSON.stringify(state), now(), row.id);
  return db.prepare('SELECT * FROM games WHERE id=?').get(row.id);
}
function gameRow(gameId) { return db.prepare('SELECT * FROM games WHERE id=?').get(gameId); }
function canViewGame(row, userId) { return row.player1_id === userId || row.player2_id === userId || row.invited_user_id === userId; }
function gameDTO(row, userId) {
  const p1 = db.prepare('SELECT username FROM users WHERE id=?').get(row.player1_id)?.username || 'Unknown';
  const p2 = row.player2_id ? db.prepare('SELECT username FROM users WHERE id=?').get(row.player2_id)?.username : null;
  const invited = row.invited_user_id ? db.prepare('SELECT username FROM users WHERE id=?').get(row.invited_user_id)?.username : null;
  return {
    id: row.id, code: row.code, status: row.status,
    player1: { id: row.player1_id, username: p1 },
    player2: row.player2_id ? { id: row.player2_id, username: p2 } : null,
    invited: row.invited_user_id ? { id: row.invited_user_id, username: invited } : null,
    isInvited: row.invited_user_id === userId,
    state: row.state_json ? JSON.parse(row.state_json) : null,
    winnerId: row.winner_id, finishReason: row.finish_reason,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function finishGame(row, winnerId, reason, stateJSON = row.state_json) {
  if (row.status !== 'active' || !row.player2_id) throw problem(409, 'This match is not active.');
  const loser = winnerId === row.player1_id ? row.player2_id : row.player1_id;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = db.prepare(`UPDATE games SET status='finished',winner_id=?,finish_reason=?,state_json=?,updated_at=?
      WHERE id=? AND status='active'`).run(winnerId, reason, stateJSON, now(), row.id);
    if (result.changes !== 1) throw problem(409, 'Match already completed.');
    db.prepare('UPDATE users SET wins=wins+1 WHERE id=?').run(winnerId);
    db.prepare('UPDATE users SET losses=losses+1 WHERE id=?').run(loser);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  notify(row.player1_id); notify(row.player2_id);
}
function serveFile(res, reqPath) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml']
  };
  if (!Object.hasOwn(files, reqPath)) return json(res, 404, { error: 'Not found.' });
  const [filename, type] = files[reqPath];
  const asset = fs.readFileSync(path.join(publicDir, filename));
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': reqPath === '/' ? 'no-cache' : 'public, max-age=300' });
  res.end(asset);
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveFile(res, pathname);
    if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST') requireSameOrigin(req);
    if (req.method === 'POST' && pathname === '/api/register') {
      const data = await body(req);
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw problem(400, 'Username must be 3–20 letters, numbers, or underscores.');
      if (password.length < 8 || password.length > 128) throw problem(400, 'Password must be 8–128 characters.');
      preventBruteForce(req, username);
      limitSignups(req);
      if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw problem(409, 'Username is already taken.');
      let result;
      try { result = db.prepare('INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)').run(username, passwordHash(password), now()); }
      catch (e) { if (e.code === 'ERR_SQLITE_ERROR') throw problem(409, 'Username is already taken.'); throw e; }
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(result.lastInsertRowid));
      setSession(res, u.id);
      return json(res, 201, { user: profile(u) });
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      const data = await body(req);
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      preventBruteForce(req, username);
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
      if (!u || !checkPassword(password, u.password_hash)) throw problem(401, 'Invalid username or password.');
      setSession(res, u.id);
      return json(res, 200, { user: profile(u) });
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = cookie(req, 'arena_session');
      const leavingUser = currentUser(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
      if (leavingUser) db.prepare('DELETE FROM queue WHERE user_id=?').run(leavingUser.id);
      res.setHeader('Set-Cookie', 'arena_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    const user = userRequired(req);
    if (req.method === 'GET' && pathname === '/api/me') {
      return json(res, 200, { user: profile(user) });
    }
    if (req.method === 'GET' && pathname === '/api/events') return stream(req, res, user);
    if (req.method === 'GET' && pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2 || q.length > 20) return json(res, 200, { results: [] });
      const results = db.prepare(`SELECT id,username,wins,losses FROM users WHERE instr(lower(username),lower(?)) > 0 AND id != ? ORDER BY username COLLATE NOCASE LIMIT 12`).all(q, user.id);
      return json(res, 200, { results: results.map(u => ({ ...profile(u), isFriend: isFriend(user.id, u.id) })) });
    }
    if (req.method === 'GET' && pathname === '/api/friends') return json(res, 200, friendData(user.id));
    if (req.method === 'POST' && pathname === '/api/friends/request') {
      const data = await body(req);
      const username = String(data.username || '').trim();
      const target = db.prepare('SELECT id FROM users WHERE username=?').get(username);
      if (!target) throw problem(404, 'No player with that username.');
      if (target.id === user.id) throw problem(400, 'You cannot add yourself.');
      if (isFriend(user.id, target.id)) throw problem(409, 'You are already friends.');
      if (db.prepare('SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=?').get(target.id, user.id)) throw problem(409, 'They already sent you a request. Accept it in Friends.');
      if (db.prepare('SELECT count(*) as n FROM friend_requests WHERE from_id=?').get(user.id).n >= 30) throw problem(429, 'Too many pending requests.');
      try { db.prepare('INSERT INTO friend_requests(from_id,to_id,created_at) VALUES(?,?,?)').run(user.id, target.id, now()); }
      catch { throw problem(409, 'Friend request already sent.'); }
      notify(target.id);
      return json(res, 201, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/friends/respond') {
      const data = await body(req);
      const requestId = Number(data.requestId);
      const request = db.prepare('SELECT * FROM friend_requests WHERE id=? AND to_id=?').get(requestId, user.id);
      if (!request) throw problem(404, 'Friend request not found.');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (data.accept === true) {
          const low = Math.min(request.from_id, user.id), high = Math.max(request.from_id, user.id);
          db.prepare('INSERT OR IGNORE INTO friends(low_id,high_id,created_at) VALUES(?,?,?)').run(low, high, now());
          db.prepare(`DELETE FROM friend_requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)`).run(low, high, high, low);
        } else {
          db.prepare('DELETE FROM friend_requests WHERE id=?').run(requestId);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      notify(request.from_id); notify(user.id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/friends/remove') {
      const data = await body(req);
      const friendId = Number(data.friendId);
      const low = Math.min(user.id, friendId), high = Math.max(user.id, friendId);
      const r = db.prepare('DELETE FROM friends WHERE low_id=? AND high_id=?').run(low, high);
      if (!r.changes) throw problem(404, 'Friendship not found.');
      notify(friendId);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/games') {
      const rows = db.prepare(`SELECT * FROM games WHERE player1_id=? OR player2_id=? OR invited_user_id=?
        ORDER BY updated_at DESC LIMIT 60`).all(user.id, user.id, user.id);
      return json(res, 200, { games: rows.map(g => gameDTO(g, user.id)) });
    }
    if (req.method === 'POST' && pathname === '/api/games') {
      const data = await body(req);
      let invitedUserId = null;
      if (data.friendId != null) {
        invitedUserId = Number(data.friendId);
        if (!isFriend(user.id, invitedUserId)) throw problem(403, 'You can challenge friends only.');
      }
      const waitingCount = db.prepare(`SELECT count(*) as n FROM games WHERE player1_id=? AND status='waiting'`).get(user.id).n;
      if (waitingCount >= 10) throw problem(429, 'Too many open invites. Cancel one first.');
      const game = createGame(user.id, invitedUserId);
      if (invitedUserId) notify(invitedUserId);
      return json(res, 201, { game: gameDTO(game, user.id) });
    }
    if (req.method === 'POST' && pathname === '/api/games/join') {
      const data = await body(req);
      const code = String(data.code || '').trim().toUpperCase();
      const row = db.prepare('SELECT * FROM games WHERE code=?').get(code);
      if (!row) throw problem(404, 'Room code not found.');
      if (row.status !== 'waiting') throw problem(409, 'That room is no longer available.');
      if (row.player1_id === user.id) throw problem(400, 'You cannot play against yourself.');
      if (row.invited_user_id && row.invited_user_id !== user.id) throw problem(403, 'This room is reserved for a friend.');
      const game = activeGame(row, user.id);
      notify(row.player1_id); notify(user.id);
      return json(res, 200, { game: gameDTO(game, user.id) });
    }
    if (req.method === 'GET' && pathname === '/api/queue') {
      return json(res, 200, { queued: !!db.prepare('SELECT 1 FROM queue WHERE user_id=?').get(user.id) });
    }
    if (req.method === 'POST' && pathname === '/api/queue/leave') {
      db.prepare('DELETE FROM queue WHERE user_id=?').run(user.id);
      return json(res, 200, { queued: false });
    }
    if (req.method === 'POST' && pathname === '/api/queue/join') {
      db.exec('BEGIN IMMEDIATE');
      let match = null;
      try {
        db.prepare('DELETE FROM queue WHERE updated_at < ?').run(now() - 35000);
        const other = db.prepare('SELECT user_id FROM queue WHERE user_id != ? ORDER BY updated_at ASC LIMIT 1').get(user.id);
        if (other) {
          db.prepare('DELETE FROM queue WHERE user_id IN (?,?)').run(user.id, other.user_id);
          const waiting = createGame(other.user_id);
          match = activeGame(waiting, user.id);
        } else {
          db.prepare(`INSERT INTO queue(user_id,updated_at) VALUES(?,?)
            ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at`).run(user.id, now());
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (match) { notify(match.player1_id); notify(match.player2_id); }
      return json(res, 200, match ? { queued: false, game: gameDTO(match, user.id) } : { queued: true });
    }
    const gameRoute = pathname.match(/^\/api\/games\/([a-f0-9-]{36})(?:\/(move|forfeit|cancel))?$/);
    if (gameRoute) {
      const row = gameRow(gameRoute[1]);
      if (!row || !canViewGame(row, user.id)) throw problem(404, 'Match not found.');
      const action = gameRoute[2];
      if (req.method === 'GET' && !action) return json(res, 200, { game: gameDTO(row, user.id) });
      if (req.method === 'POST' && action === 'cancel') {
        if (row.status !== 'waiting' || row.player1_id !== user.id) throw problem(403, 'Cannot cancel this room.');
        db.prepare(`UPDATE games SET status='cancelled',updated_at=? WHERE id=?`).run(now(), row.id);
        if (row.invited_user_id) notify(row.invited_user_id);
        notify(user.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'forfeit') {
        if (row.status !== 'active') throw problem(409, 'This game is not active.');
        const winner = row.player1_id === user.id ? row.player2_id : row.player1_id;
        finishGame(row, winner, 'forfeit');
        return json(res, 200, { game: gameDTO(gameRow(row.id), user.id) });
      }
      if (req.method === 'POST' && action === 'move') {
        if (row.status !== 'active') throw problem(409, 'This game is not active.');
        const opponentId = row.player1_id === user.id ? row.player2_id : row.player1_id;
        let result;
        try { result = makeMove(JSON.parse(row.state_json), user.id, opponentId, await body(req)); }
        catch (e) { throw problem(/not your turn/i.test(e.message) ? 409 : 400, e.message); }
        if (result.winnerId) {
          finishGame(row, result.winnerId, 'hands', JSON.stringify(result.state));
        } else {
          db.prepare('UPDATE games SET state_json=?,updated_at=? WHERE id=?').run(JSON.stringify(result.state), now(), row.id);
          notify(row.player1_id); notify(row.player2_id);
        }
        return json(res, 200, { game: gameDTO(gameRow(row.id), user.id) });
      }
    }
    throw problem(404, 'Route not found.');
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Unexpected server error.' });
    if (!e.status) console.error(e);
  }
});

const cleanup = setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM queue WHERE updated_at < ?').run(now() - 35000);
  for (const [key, list] of attempts) {
    const fresh = list.filter(x => now() - x < 15 * 60 * 1000);
    if (fresh.length) attempts.set(key, fresh); else attempts.delete(key);
  }
  for (const [key, list] of signupAttempts) {
    const fresh = list.filter(x => now() - x < 60 * 60 * 1000);
    if (fresh.length) signupAttempts.set(key, fresh); else signupAttempts.delete(key);
  }
}, 60 * 60 * 1000);
cleanup.unref();

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '0.0.0.0', () => console.log(`Chopsticks Arena running on http://localhost:${PORT}`));
}
