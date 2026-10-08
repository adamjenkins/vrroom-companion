// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync tests: the Phase 5 extension point — hooks, isolation, routes, loading, 'observe' refused.

import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {ExtensionError, HOOKS, createExtensionHost} from '../src/extensions.js';
import {Rooms} from '../src/rooms.js';
import {STATE, captureLog, connect, delay, fakeSession, makeClaims, makeToken, peerId, startServer} from './helpers.js';

test('the hook list is fixed', () => {
    assert.deepEqual([...HOOKS], ['roomOpened', 'peerJoined', 'peerLeft', 'stateChanged', 'roomClosed']);
});

test('hooks receive frozen views from the rooms', () => {
    const {log} = captureLog();
    const host = createExtensionHost(log);
    const seen = [];
    host.register({
        name: 'recorder',
        hooks: Object.fromEntries(HOOKS.map((hook) => [hook, (view) => seen.push([hook, view])])),
    });
    const rooms = new Rooms({maxRoomPeers: 50, maxRooms: 10, graceMs: 0, poseHz: 15, hooks: host});
    const a = fakeSession();
    rooms.admit(a, makeClaims({sub: peerId(1)}), 0);
    rooms.setState(a.room, a.peer, STATE);
    rooms.away(a.room, a.peer, 0);

    assert.deepEqual(seen.map(([hook]) => hook), ['roomOpened', 'peerJoined', 'stateChanged', 'peerLeft', 'roomClosed']);
    for (const [, view] of seen) {
        assert.ok(Object.isFrozen(view));
        assert.ok(Object.isFrozen(view.room));
        assert.deepEqual(Object.keys(view.room), ['iss', 'room', 'size', 'max']);
    }
    const joined = seen[1][1];
    assert.deepEqual(joined.peer, {sub: peerId(1), name: 'Sam Student', kind: 'attempt'});
    assert.ok(Object.isFrozen(joined.peer));
    assert.equal(seen[2][1].state, STATE);
    assert.equal(seen[3][1].reason, 'timeout');
    assert.throws(() => {
        joined.room.size = 99;
    });
});

test('a throwing or rejecting hook does not break admit and is logged with name and hook only', async () => {
    const {log, lines} = captureLog();
    const host = createExtensionHost(log);
    host.register({name: 'broken', hooks: {peerJoined: () => {
        throw new Error('boom ' + peerId(2));
    }, roomOpened: async () => {
        throw new Error('async boom');
    }}});
    const rooms = new Rooms({maxRoomPeers: 50, maxRooms: 10, graceMs: 0, poseHz: 15, hooks: host});
    const session = fakeSession();
    assert.deepEqual(rooms.admit(session, makeClaims({sub: peerId(2)}), 0), {ok: true});
    assert.equal(session.of('welcome').length, 1);
    await delay(10);
    const entries = lines.map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.event, entry.extension, entry.hook]).sort(), [
        ['extension_error', 'broken', 'peerJoined'],
        ['extension_error', 'broken', 'roomOpened'],
    ]);
    assert.equal(lines.join('\n').includes(peerId(2)), false);
    assert.equal(lines.join('\n').includes('boom'), false);
});

test('invalid definitions are refused', () => {
    const host = createExtensionHost(captureLog().log);
    for (const definition of [
        null,
        {},
        {name: 'Bad Name'},
        {name: 'x', hooks: {unknownHook: () => undefined}},
        {name: 'x', hooks: {peerJoined: 'not a function'}},
        {name: 'x', routes: {'../escape': () => undefined}},
        {name: 'x', routes: {'ok': 'not a function'}},
    ]) {
        assert.throws(() => host.register(definition), ExtensionError);
    }
    host.register({name: 'once'});
    assert.throws(() => host.register({name: 'once'}), ExtensionError);
    assert.deepEqual(host.names(), ['once']);
});

test('routes under /v1/ext/<name>/<subpath>', async () => {
    const host = createExtensionHost(captureLog().log);
    host.register({
        name: 'x',
        routes: {
            'y': (req, res) => {
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end('{"ext":"x"}');
            },
            'fails': () => {
                throw new Error('handler error');
            },
        },
    });
    const server = await startServer({}, {extensions: host});
    try {
        const ok = await fetch(server.http + '/v1/ext/x/y?q=1');
        assert.equal(ok.status, 200);
        assert.deepEqual(await ok.json(), {ext: 'x'});
        for (const missing of ['/v1/ext/x/z', '/v1/ext/other/y', '/v1/ext/x', '/v1/ext/']) {
            assert.equal((await fetch(server.http + missing)).status, 404, missing);
        }
        const failed = await fetch(server.http + '/v1/ext/x/fails');
        assert.equal(failed.status, 500);
        assert.deepEqual(await failed.json(), {error: 'internal'});
    } finally {
        await server.close();
    }
});

test('load() imports modules from files and refuses broken ones', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mavr-sync-ext-'));
    try {
        const good = path.join(dir, 'good.mjs');
        writeFileSync(good, "export default {name: 'good', hooks: {roomOpened() {}}};\n");
        const bad = path.join(dir, 'bad.mjs');
        writeFileSync(bad, "export default {name: 'Not Valid'};\n");
        const host = createExtensionHost(captureLog().log);
        await host.load([good]);
        assert.deepEqual(host.names(), ['good']);
        await assert.rejects(host.load([bad]), (error) => error instanceof ExtensionError && error.extension === 'bad.mjs');
        await assert.rejects(host.load([path.join(dir, 'missing.mjs')]), ExtensionError);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test("the reserved token purpose 'observe' is refused on /sync", async () => {
    const server = await startServer();
    try {
        const client = await connect(server.url);
        client.send({t: 'hello', token: makeToken({mavr: 'observe'})});
        assert.equal((await client.closed).code, 4401);
    } finally {
        await server.close();
    }
});
