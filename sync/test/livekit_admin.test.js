// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync tests: LiveKit RemoveParticipant against a fake local Twirp server.

import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import http from 'node:http';
import {test} from 'node:test';
import {ADMIN_TOKEN_TTL, REMOVE_PATH, createLiveKitAdmin} from '../src/livekit_admin.js';
import {captureLog, peerId, roomId} from './helpers.js';

const KEY = 'APItestkey0001';
const SECRET = 'livekit-secret-0123456789abcdef0123456789abcdef';

/**
 * Start a fake LiveKit API on 127.0.0.1.
 *
 * @param {number} status Status to answer with.
 * @returns {Promise<{url: string, requests: Object[], close: Function}>}
 */
const fakeLiveKit = (status = 200) => new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            requests.push({method: req.method, url: req.url, headers: req.headers, body});
            res.writeHead(status, {'Content-Type': 'application/json'});
            res.end(status === 200 ? '{}' : '{"code":"not_found","msg":"participant not found"}');
        });
    });
    server.listen(0, '127.0.0.1', () => {
        resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            requests,
            close: () => new Promise((done) => server.close(done)),
        });
    });
});

/**
 * Verify an HS256 JWT signed with SECRET and return its payload.
 *
 * @param {string} token
 * @returns {Object}
 */
const payloadOf = (token) => {
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', SECRET).update(header + '.' + payload).digest('base64url');
    assert.equal(signature, expected);
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {typ: 'JWT', alg: 'HS256'});
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
};

test('RemoveParticipant: Twirp path, JSON body and a Bearer admin token for that room', async () => {
    const livekit = await fakeLiveKit(200);
    const now = 1760000000000;
    const admin = createLiveKitAdmin({url: livekit.url + '/', key: KEY, secret: SECRET}, {now: () => now});
    assert.equal(admin.enabled, true);
    await admin.removeParticipant(roomId(3), peerId(4));
    await livekit.close();

    assert.equal(livekit.requests.length, 1);
    const request = livekit.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, REMOVE_PATH);
    assert.equal(request.url, '/twirp/livekit.RoomService/RemoveParticipant');
    assert.match(request.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(request.body), {room: roomId(3), identity: peerId(4)});
    const match = /^Bearer (.+)$/.exec(request.headers.authorization);
    assert.ok(match);
    const claims = payloadOf(match[1]);
    assert.deepEqual(claims, {
        iss: KEY,
        nbf: 1760000000,
        exp: 1760000000 + ADMIN_TOKEN_TTL,
        video: {roomAdmin: true, room: roomId(3)},
    });
});

test('disabled unless url, key and secret are all set: no request at all', async () => {
    let calls = 0;
    const fetch = async () => {
        calls++;
        return new Response('{}');
    };
    for (const settings of [{}, {url: 'http://127.0.0.1:1', key: KEY}, {key: KEY, secret: SECRET}, {url: 'http://x', secret: SECRET}]) {
        const admin = createLiveKitAdmin(settings, {fetch});
        assert.equal(admin.enabled, false);
        await admin.removeParticipant(roomId(1), peerId(1));
    }
    assert.equal(calls, 0);
});

test('errors are swallowed and logged with the status only', async () => {
    const livekit = await fakeLiveKit(500);
    const {log, lines} = captureLog();
    const admin = createLiveKitAdmin({url: livekit.url, key: KEY, secret: SECRET}, {log});
    await admin.removeParticipant(roomId(5), peerId(6));
    await livekit.close();

    const failing = createLiveKitAdmin({url: 'http://127.0.0.1:9', key: KEY, secret: SECRET}, {
        log,
        fetch: async () => {
            throw new Error('ECONNREFUSED ' + peerId(6));
        },
    });
    await failing.removeParticipant(roomId(5), peerId(6));

    const entries = lines.map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => [entry.event, entry.status]), [
        ['livekit_remove_failed', 500],
        ['livekit_remove_failed', 0],
    ]);
    const text = lines.join('\n');
    assert.equal(text.includes(peerId(6)), false);
    assert.equal(text.includes(roomId(5)), false);
});

test('404 (not in the voice room) is logged at debug level only', async () => {
    const livekit = await fakeLiveKit(404);
    const {log, lines} = captureLog();
    const admin = createLiveKitAdmin({url: livekit.url, key: KEY, secret: SECRET}, {log});
    await admin.removeParticipant(roomId(7), peerId(8));
    await livekit.close();
    assert.deepEqual(lines.map((line) => JSON.parse(line).level), ['debug']);
});
