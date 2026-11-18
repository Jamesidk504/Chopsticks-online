import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';

async function freePort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

test('two users can register, friend each other, play online, and persist match results', { timeout: 25000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chopsticks-test-'));
  const port = await freePort();
  const root = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const request = async (url, jar = {}, data) => {
    const resp = await fetch(root + url, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(jar.cookie ? { Cookie: jar.cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const sc = resp.headers.get('set-cookie');
    if (sc) jar.cookie = sc.split(';')[0];
    return { status: resp.status, data: await resp.json() };
  };
  try {
    let up = false;
    for (let i = 0; i < 50; i++) {
      await pause(60);
      try { if ((await request('/api/health')).status === 200) { up = true; break; } } catch {}
    }
    assert.ok(up, `Server never started: ${output}`);
    const a = {}, b = {};
    const ra = await request('/api/register', a, { username: 'PlayerAlpha', password: 'testpassword01' });
    const rb = await request('/api/register', b, { username: 'PlayerBeta', password: 'testpassword02' });
    assert.equal(ra.status, 201); assert.equal(rb.status, 201);
    const aid = ra.data.user.id, bid = rb.data.user.id;
    assert.ok(a.cookie && b.cookie);
    const { data: found } = await request('/api/search?q=PlayerB', a);
    assert.equal(found.results[0].username, 'PlayerBeta');
    // Subscribe as B: a friend request should trigger a real-time server-sent event.
    const liveAbort = new AbortController();
    const liveResponse = await fetch(root + '/api/events', {
      headers: { Cookie: b.cookie }, signal: liveAbort.signal
    });
    assert.equal(liveResponse.status, 200);
    const eventReader = liveResponse.body.getReader();
    const connected = await eventReader.read();
    assert.match(new TextDecoder().decode(connected.value), /connected/);
    assert.equal((await request('/api/friends/request', a, { username: 'PlayerBeta' })).status, 201);
    const notification = await Promise.race([
      eventReader.read(),
      pause(2500).then(() => { throw new Error('Timed out waiting for live notification.'); })
    ]);
    assert.match(new TextDecoder().decode(notification.value), /event: sync/);
    liveAbort.abort();
    const { data: bFriends } = await request('/api/friends', b);
    assert.equal(bFriends.incoming.length, 1);
    assert.equal((await request('/api/friends/respond', b, { requestId: bFriends.incoming[0].id, accept: true })).status, 200);
    assert.equal((await request('/api/friends', a)).data.friends.length, 1);
    const roomResponse = await request('/api/games', a, { friendId: bid });
    assert.equal(roomResponse.status, 201);
    const gameId = roomResponse.data.game.id;
    const gameCode = roomResponse.data.game.code;
    assert.equal((await request(`/api/games/${gameId}/move`, a, { type: 'hit', from: 0, to: 0 })).status, 409);
    const join = await request('/api/games/join', b, { code: gameCode });
    assert.equal(join.status, 200);
    assert.equal(join.data.game.state.turn, aid);
    assert.deepEqual(join.data.game.state.hands[aid], [1, 1]);
    assert.equal((await request('/api/games/join', b, { code: gameCode })).status, 409);
    assert.equal((await request(`/api/games/${gameId}/move`, b, { type: 'hit', from: 0, to: 0 })).status, 409);
    assert.equal((await request(`/api/games/${gameId}/move`, a, { type: 'hit', from: 0, to: 0 })).status, 200);
    const next = await request(`/api/games/${gameId}`, b);
    assert.equal(next.data.game.state.hands[bid][0], 2);
    // The recipient can forfeit, increasing the other player's wins exactly once.
    const forfeited = await request(`/api/games/${gameId}/forfeit`, b, {});
    assert.equal(forfeited.status, 200);
    assert.equal(forfeited.data.game.winnerId, aid);
    assert.equal((await request(`/api/games/${gameId}/forfeit`, b, {})).status, 409);
    assert.equal((await request('/api/me', a)).data.user.wins, 1);
    assert.equal((await request('/api/me', b)).data.user.losses, 1);
    // Check room-code-only multiplayer and cancellation.
    const privateRoom = (await request('/api/games', b, {})).data.game;
    assert.equal((await request('/api/games/join', a, { code: privateRoom.code })).status, 200);
    assert.equal((await request('/api/games', a, { friendId: 87654 })).status, 403);

    // A complete, non-forfeit 9-move game proves hit-to-five wins are saved.
    const knockoutRoom = (await request('/api/games', a, {})).data.game;
    assert.equal((await request('/api/games/join', b, { code: knockoutRoom.code })).status, 200);
    const moves = [
      [a, 0, 0], [b, 1, 0], [a, 0, 0], [b, 0, 0], [a, 0, 0],
      [b, 1, 0], [a, 0, 1], [b, 1, 1], [a, 0, 1]
    ];
    let completed;
    for (const [jar, from, to] of moves) {
      completed = await request(`/api/games/${knockoutRoom.id}/move`, jar, { type: 'hit', from, to });
      assert.equal(completed.status, 200, JSON.stringify(completed));
    }
    assert.equal(completed.data.game.status, 'finished');
    assert.equal(completed.data.game.winnerId, aid);
    assert.deepEqual(completed.data.game.state.hands[bid], [0, 0]);
    assert.equal((await request('/api/me', a)).data.user.wins, 2);
    assert.equal((await request('/api/me', b)).data.user.losses, 2);

    // Matchmaking pairs two strangers and prevents a third player from seeing a private room.
    const c = {}, d = {};
    const rc = await request('/api/register', c, { username: 'PlayerGamma', password: 'testpassword03' });
    const rd = await request('/api/register', d, { username: 'PlayerDelta', password: 'testpassword04' });
    assert.equal(rc.status, 201); assert.equal(rd.status, 201);
    assert.equal((await request(`/api/games/${knockoutRoom.id}`, c)).status, 404);
    assert.equal((await request('/api/queue/join', c, {})).data.queued, true);
    const matched = await request('/api/queue/join', d, {});
    assert.equal(matched.status, 200);
    assert.equal(matched.data.game.status, 'active');
    assert.equal(matched.data.game.player1.id, rc.data.user.id);
    assert.equal(matched.data.game.player2.id, rd.data.user.id);
    assert.equal((await request('/api/queue', c)).data.queued, false);

    const pw = await request('/api/login', {}, { username: 'PlayerAlpha', password: 'wrong_password' });
    assert.equal(pw.status, 401);
    assert.equal((await request('/api/health')).status, 200);
  } finally {
    child.kill('SIGTERM');
    await pause(100);
    rmSync(dir, { recursive: true, force: true });
  }
});
