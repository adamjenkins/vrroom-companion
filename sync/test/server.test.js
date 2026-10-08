// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync tests: the HTTP + WebSocket server end to end on an ephemeral 127.0.0.1 port.

import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {
    ISSUER, ORIGIN, POSE, STATE, connect, createClock, delay, joinAs, makeToken, peerId, poseAt, roomId, seconds,
    startServer,
} from './helpers.js';

describe('HTTP', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    test('GET /healthz answers ok, not cached, no CORS', async () => {
        const response = await fetch(server.http + '/healthz');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {status: 'ok', service: 'vrroom-sync', protocol: 1});
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.match(response.headers.get('content-type'), /^application\/json/);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
    });

    test('other paths and methods answer 404', async () => {
        for (const [path, method] of [['/', 'GET'], ['/sync', 'GET'], ['/healthz', 'POST'], ['/v1/other', 'GET']]) {
            const response = await fetch(server.http + path, {method});
            assert.equal(response.status, 404, `${method} ${path}`);
            assert.deepEqual(await response.json(), {error: 'notfound'});
        }
    });

    test('the listening line carries no address', () => {
        const line = server.lines.map((text) => JSON.parse(text)).find((entry) => entry.event === 'listening');
        assert.equal(line.port, server.port);
        assert.equal(line.version, '0.1.0');
        assert.equal(Object.hasOwn(line, 'host'), false);
    });
});

describe('upgrade checks', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    test('a wrong path is refused', async () => {
        await assert.rejects(connect(`ws://127.0.0.1:${server.port}/other`), (error) => error.status === 404);
    });

    test('a missing or other subprotocol gets 400', async () => {
        await assert.rejects(connect(server.url, {protocol: null}), (error) => error.status === 400);
        await assert.rejects(connect(server.url, {protocol: 'vrroom-sync.2'}), (error) => error.status === 400);
    });

    test('a foreign origin gets 403; the issuer origin and no origin are accepted', async () => {
        await assert.rejects(connect(server.url, {origin: 'https://evil.example.com'}), (error) => error.status === 403);
        const good = await connect(server.url, {origin: ORIGIN});
        assert.equal(good.ws.protocol, 'vrroom-sync.1');
        good.close();
        const none = await connect(server.url);
        none.close();
    });
});

describe('hello', () => {
    let server;
    let clock;
    before(async () => {
        clock = createClock();
        server = await startServer({}, {now: clock.now});
    });
    after(() => server.close());

    test('no hello within 5 s closes with 4001', async () => {
        const client = await connect(server.url);
        clock.advance(6000);
        assert.equal((await client.closed).code, 4001);
    });

    test('another frame before hello closes with 4000', async () => {
        const client = await connect(server.url);
        client.send({t: 'ping', n: 1});
        assert.equal((await client.closed).code, 4000);
    });

    test('a bad, expired or observe-purpose token closes with 4401', async () => {
        const now = seconds(clock.now());
        for (const token of [
            'junk',
            makeToken({exp: now - 1, iat: now - 100, nbf: now - 100}, {now}),
            makeToken({}, {now, secret: 'a-different-secret-0123456789abcdef0123'}),
            makeToken({vrroom: 'observe'}, {now}),
        ]) {
            const client = await connect(server.url);
            client.send({t: 'hello', token});
            assert.equal((await client.closed).code, 4401);
        }
    });

    test('a token from an issuer that is not allowed closes with 4403', async () => {
        const client = await connect(server.url);
        client.send({t: 'hello', token: makeToken({iss: 'https://other.example.org'}, {now: seconds(clock.now())})});
        assert.equal((await client.closed).code, 4403);
    });
});

describe('two clients in a room', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    test('welcome, join, poses, states, direct state, leave', async () => {
        const a = await joinAs(server, {sub: peerId(1), name: 'Ann', room: roomId(5)});
        assert.equal(a.welcome.protocol, 1);
        assert.deepEqual(a.welcome.self, {p: peerId(1), name: 'Ann', kind: 'attempt'});
        assert.deepEqual(a.welcome.peers, []);
        assert.equal(a.welcome.posehz, 15);

        // A state before the second client joins is part of its welcome.
        a.client.send({t: 'state', d: STATE});
        await delay(50);
        const b = await joinAs(server, {sub: peerId(2), name: 'Ben', room: roomId(5), kind: 'preview'});
        assert.deepEqual(b.welcome.peers, [{p: peerId(1), name: 'Ann', kind: 'attempt', s: STATE}]);
        const join = await a.client.next('join');
        assert.deepEqual(join.peer, {p: peerId(2), name: 'Ben', kind: 'preview'});

        // Poses are batched and relayed, never echoed.
        a.client.send({t: 'pose', d: poseAt(3)});
        const poses = await b.client.next('poses');
        assert.deepEqual(poses.b, [[peerId(1), poseAt(3)]]);
        assert.equal(await a.client.none('poses', 200), true);

        // State broadcast.
        b.client.send({t: 'state', d: STATE});
        assert.deepEqual(await a.client.next('state'), {t: 'state', p: peerId(2), d: STATE});

        // Direct state to one peer.
        a.client.send({t: 'state', d: STATE, to: peerId(2)});
        assert.deepEqual(await b.client.next('state'), {t: 'state', p: peerId(1), d: STATE});

        // Invalid codec payloads are not relayed.
        a.client.send({t: 'pose', d: '{"t":"p"}'});
        assert.equal(await b.client.none('poses', 200), true);

        // Ping.
        a.client.send({t: 'ping', n: 7});
        assert.deepEqual(await a.client.next('pong'), {t: 'pong', n: 7});

        // Leave.
        b.client.send({t: 'leave'});
        assert.equal((await b.client.closed).code, 1000);
        assert.deepEqual(await a.client.next('leave'), {t: 'leave', p: peerId(2), r: 'left'});
        a.client.close();
    });

    test('identity comes from the token only: extra keys in frames are ignored', async () => {
        const a = await joinAs(server, {sub: peerId(11), name: 'Ann', room: roomId(6)});
        const b = await joinAs(server, {sub: peerId(12), name: 'Ben', room: roomId(6)});
        await a.client.next('join');
        a.client.send({t: 'state', d: STATE, p: peerId(99), name: 'Mallory'});
        assert.deepEqual(await b.client.next('state'), {t: 'state', p: peerId(11), d: STATE});
        a.client.close();
        b.client.close();
    });

    test('a full room closes the next one with 4503 after error full', async () => {
        const a = await joinAs(server, {sub: peerId(21), room: roomId(7), max: 2});
        const b = await joinAs(server, {sub: peerId(22), room: roomId(7), max: 2});
        const c = await connect(server.url);
        c.send({t: 'hello', token: makeToken({sub: peerId(23), room: roomId(7), max: 2})});
        assert.deepEqual(await c.next('error'), {t: 'error', code: 'full'});
        assert.equal((await c.closed).code, 4503);
        a.client.close();
        b.client.close();
    });

    test('a second session of the same peer replaces the first (4409)', async () => {
        const first = await joinAs(server, {sub: peerId(31), room: roomId(8)});
        const second = await joinAs(server, {sub: peerId(31), room: roomId(8)});
        assert.equal((await first.client.closed).code, 4409);
        assert.deepEqual(second.welcome.self.p, peerId(31));
        second.client.close();
    });

    test('auth with a fresh token extends the session; a token for another peer is refused', async () => {
        const now = seconds();
        const a = await joinAs(server, {sub: peerId(41), room: roomId(9), exp: now + 100});
        assert.equal(a.welcome.exp, now + 100);
        a.client.send({t: 'auth', token: makeToken({sub: peerId(41), room: roomId(9), exp: now + 300}, {now})});
        assert.deepEqual(await a.client.next('authok'), {t: 'authok', exp: now + 300});
        // The auth bucket allows one per 10 s: use a second session for the refusal.
        const b = await joinAs(server, {sub: peerId(42), room: roomId(9)});
        b.client.send({t: 'auth', token: makeToken({sub: peerId(43), room: roomId(9)})});
        assert.deepEqual(await b.client.next('error'), {t: 'error', code: 'auth'});
        a.client.close();
        b.client.close();
    });

    test('an oversize frame closes with 1009', async () => {
        const a = await joinAs(server, {sub: peerId(51), room: roomId(10)});
        a.client.send(JSON.stringify({t: 'future', pad: 'x'.repeat(5000)}));
        assert.equal((await a.client.closed).code, 1009);
    });

    test('binary frames are dropped; 20 malformed frames in a row close with 4000', async () => {
        const a = await joinAs(server, {sub: peerId(61), room: roomId(11)});
        a.client.ws.send(Buffer.from([1, 2, 3]), {binary: true});
        a.client.send({t: 'ping', n: 1});
        assert.deepEqual(await a.client.next('pong'), {t: 'pong', n: 1});
        for (let i = 0; i < 20; i++) {
            a.client.send('{not json');
        }
        assert.deepEqual(await a.client.next('error'), {t: 'error', code: 'protocol'});
        assert.equal((await a.client.closed).code, 4000);
    });

    test('unknown frame types are dropped silently', async () => {
        const a = await joinAs(server, {sub: peerId(71), room: roomId(12)});
        for (let i = 0; i < 30; i++) {
            a.client.send({t: 'future', x: i});
        }
        a.client.send({t: 'ping', n: 2});
        assert.deepEqual(await a.client.next('pong'), {t: 'pong', n: 2});
        a.client.close();
    });
});

describe('expiry and grace', () => {
    let server;
    let clock;
    before(async () => {
        clock = createClock();
        server = await startServer({VRROOM_SYNC_GRACE_SECONDS: '10'}, {now: clock.now});
    });
    after(() => server.close());

    test('a session whose token expired more than 30 s ago is closed with 4410 and the others see leave expired', async () => {
        const now = seconds(clock.now());
        const a = await joinAs(server, {sub: peerId(81), room: roomId(20), iat: now, nbf: now, exp: now + 300});
        const b = await joinAs(server, {sub: peerId(82), room: roomId(20), iat: now, nbf: now, exp: now + 60});
        await a.client.next('join');
        clock.advance(100 * 1000);
        assert.equal((await b.client.closed).code, 4410);
        assert.deepEqual(await a.client.next('leave'), {t: 'leave', p: peerId(82), r: 'expired'});
        a.client.close();
    });

    test('an unexpected disconnect is told to the others only after the grace', async () => {
        const now = seconds(clock.now());
        const a = await joinAs(server, {sub: peerId(91), room: roomId(21), iat: now, nbf: now, exp: now + 300});
        const b = await joinAs(server, {sub: peerId(92), room: roomId(21), iat: now, nbf: now, exp: now + 300});
        await a.client.next('join');
        b.client.ws.terminate();
        await b.client.closed;
        assert.equal(await a.client.none('leave', 200), true);
        clock.advance(11000);
        assert.deepEqual(await a.client.next('leave'), {t: 'leave', p: peerId(92), r: 'timeout'});
        a.client.close();
    });
});

describe('shutdown', () => {
    test('close() closes every socket with 1001', async () => {
        const server = await startServer();
        const a = await joinAs(server, {sub: peerId(101), room: roomId(30)});
        const pending = await connect(server.url);
        await server.close();
        assert.equal((await a.client.closed).code, 1001);
        assert.equal((await pending.closed).code, 1001);
    });
});

describe('logging', () => {
    test('no log line contains a name, peer id, room id, token or address', async () => {
        const server = await startServer();
        const token = makeToken({sub: peerId(111), room: roomId(40), name: 'Distinctive Name'});
        const client = await connect(server.url);
        client.send({t: 'hello', token});
        await client.next('welcome');
        client.send({t: 'pose', d: POSE});
        client.close();
        await client.closed;
        await delay(50);
        await server.close();
        const text = server.lines.join('\n');
        for (const secret of ['Distinctive Name', peerId(111), roomId(40), token, '127.0.0.1', ISSUER]) {
            assert.equal(text.includes(secret), false, secret);
        }
    });
});
