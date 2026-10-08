// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync tests: client frame parsing, server frame builders, the codec copy.

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import * as Protocol from '../src/protocol.js';
import {POSE, STATE, peerId} from './helpers.js';

const {parseClient, UNKNOWN} = Protocol;

/**
 * Parse a JSON value as a text frame.
 *
 * @param {*} value
 * @returns {*}
 */
const parse = (value) => parseClient(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), false);

test('every client frame type parses into a fresh object with known keys only', () => {
    assert.deepEqual(parse({t: 'hello', token: 'a.b.c', extra: 1}), {t: 'hello', token: 'a.b.c'});
    assert.deepEqual(parse({t: 'auth', token: 'a.b.c'}), {t: 'auth', token: 'a.b.c'});
    assert.deepEqual(parse({t: 'pose', d: POSE, x: true}), {t: 'pose', d: POSE});
    assert.deepEqual(parse({t: 'state', d: STATE}), {t: 'state', d: STATE});
    assert.deepEqual(parse({t: 'state', d: STATE, to: peerId(7)}), {t: 'state', d: STATE, to: peerId(7)});
    assert.deepEqual(parse({t: 'state', d: STATE, to: null}), {t: 'state', d: STATE});
    assert.deepEqual(parse({t: 'ping', n: 0}), {t: 'ping', n: 0});
    assert.deepEqual(parse({t: 'ping', n: 2147483647}), {t: 'ping', n: 2147483647});
    assert.deepEqual(parse({t: 'leave'}), {t: 'leave'});
});

test('an unknown type is reported as unknown, not malformed', () => {
    assert.equal(parse({t: 'future'}), UNKNOWN);
    assert.equal(parse({t: 'chat', text: 'hi'}), UNKNOWN);
});

test('malformed frames give null', () => {
    const bad = [
        'not json',
        '[]',
        '"string"',
        'null',
        '42',
        {},
        {t: 1},
        {t: 'hello'},
        {t: 'hello', token: ''},
        {t: 'hello', token: 'x'.repeat(3001)},
        {t: 'auth', token: 5},
        {t: 'pose'},
        {t: 'pose', d: {t: 'p'}},
        {t: 'pose', d: 'x'.repeat(2049)},
        {t: 'state', d: 'x'.repeat(2049)},
        {t: 'state', d: STATE, to: 'ABC'},
        {t: 'state', d: STATE, to: 12},
        {t: 'ping'},
        {t: 'ping', n: -1},
        {t: 'ping', n: 2147483648},
        {t: 'ping', n: 1.5},
    ];
    for (const value of bad) {
        assert.equal(parse(value), null, JSON.stringify(value));
    }
});

test('binary frames and frames over 4096 bytes give null', () => {
    assert.equal(parseClient(Buffer.from(JSON.stringify({t: 'leave'})), true), null);
    const big = JSON.stringify({t: 'future', pad: 'x'.repeat(4100)});
    assert.equal(parseClient(Buffer.from(big), false), null);
});

test('server frame builders', () => {
    const self = {sub: peerId(1), name: 'Sam', kind: 'attempt', state: null};
    const other = {sub: peerId(2), name: 'Kim', kind: 'preview', state: STATE};
    assert.deepEqual(JSON.parse(Protocol.welcome({self, max: 50, peers: [other], exp: 123, posehz: 15})), {
        t: 'welcome',
        protocol: 1,
        server: '0.1.0',
        self: {p: peerId(1), name: 'Sam', kind: 'attempt'},
        room: {max: 50},
        peers: [{p: peerId(2), name: 'Kim', kind: 'preview', s: STATE}],
        exp: 123,
        posehz: 15,
    });
    assert.deepEqual(JSON.parse(Protocol.join(other)), {t: 'join', peer: {p: peerId(2), name: 'Kim', kind: 'preview'}});
    assert.deepEqual(JSON.parse(Protocol.leave(peerId(2), 'timeout')), {t: 'leave', p: peerId(2), r: 'timeout'});
    assert.deepEqual(JSON.parse(Protocol.poses([[peerId(2), POSE]])), {t: 'poses', b: [[peerId(2), POSE]]});
    assert.deepEqual(JSON.parse(Protocol.state(peerId(2), STATE)), {t: 'state', p: peerId(2), d: STATE});
    assert.deepEqual(JSON.parse(Protocol.authok(99)), {t: 'authok', exp: 99});
    assert.deepEqual(JSON.parse(Protocol.pong(5)), {t: 'pong', n: 5});
    assert.deepEqual(JSON.parse(Protocol.error('full')), {t: 'error', code: 'full'});
});

test('constants match the contract', () => {
    assert.equal(Protocol.SUBPROTOCOL, 'vrroom-sync.1');
    assert.equal(Protocol.MAX_FRAME, 4096);
    assert.deepEqual({...Protocol.CLOSE}, {
        NORMAL: 1000, GOING_AWAY: 1001, TOO_BIG: 1009, PROTOCOL: 4000, HELLO_TIMEOUT: 4001, SLOW: 4008,
        UNAUTHORISED: 4401, FORBIDDEN: 4403, REPLACED: 4409, EXPIRED: 4410, RATE: 4429, FULL: 4503, BUSY: 4504,
    });
});

test('the codec copy is identical to the Phase 3 codec (when the plugin repo is next to this one)', (t) => {
    const original = fileURLToPath(new URL('../../../moodle-mod_vrroom/runtime/builtin/amd/src/live/codec.js', import.meta.url));
    if (!existsSync(original)) {
        t.skip('moodle-mod_vrroom is not checked out next to vrroom-companion');
        return;
    }
    const copy = readFileSync(new URL('../src/codec.js', import.meta.url), 'utf8');
    const lines = copy.split('\n');
    assert.match(lines[0], /^\/\/ Copied verbatim from moodle-mod_vrroom /);
    assert.match(lines[1], /^\/\/ Keep both copies identical/);
    assert.equal(lines[2], '// SPDX-License-Identifier: GPL-3.0-or-later');
    assert.equal(lines.slice(3).join('\n'), readFileSync(original, 'utf8'));
});
