// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync tests: token buckets, the abuse counter, and the per-session limits through Session.

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLog} from '../src/log.js';
import {ABUSE_DROPS, LIMITS, createAbuseCounter, createBucket} from '../src/ratelimit.js';
import {Rooms} from '../src/rooms.js';
import {Session} from '../src/session.js';
import {ISSUER, POSE, SECRET, STATE, fakeSocket, makeToken, peerId, seconds} from './helpers.js';

test('a bucket starts full, empties and refills with time', () => {
    const bucket = createBucket(4, 8, 0);
    for (let i = 0; i < 8; i++) {
        assert.equal(bucket.take(0), true);
    }
    assert.equal(bucket.take(0), false);
    assert.equal(bucket.take(200), false);
    assert.equal(bucket.take(250), true);
    assert.equal(bucket.take(250), false);
    // Never more than the burst, however long the pause.
    let taken = 0;
    while (bucket.take(1000000)) {
        taken++;
    }
    assert.equal(taken, 8);
});

test('a bucket ignores a clock going backwards', () => {
    const bucket = createBucket(1, 1, 1000);
    assert.equal(bucket.take(1000), true);
    assert.equal(bucket.take(500), false);
    assert.equal(bucket.take(1999), false);
    assert.equal(bucket.take(2010), true);
});

test('the auth bucket allows one per 10 s', () => {
    const bucket = createBucket(LIMITS.auth.rate, LIMITS.auth.burst, 0);
    assert.equal(bucket.take(0), true);
    assert.equal(bucket.take(9999), false);
    assert.equal(bucket.take(10010), true);
});

test('the abuse counter trips above 400 events within 10 s only', () => {
    const counter = createAbuseCounter();
    for (let i = 0; i < ABUSE_DROPS; i++) {
        assert.equal(counter.add(i), false);
    }
    assert.equal(counter.add(ABUSE_DROPS), true);

    const slow = createAbuseCounter();
    for (let i = 0; i < 1000; i++) {
        assert.equal(slow.add(i * 30), false);
    }
});

/**
 * A joined Session on a fake socket with a frozen clock.
 *
 * @param {Rooms} rooms
 * @param {number} n Peer number.
 * @param {number} now ms
 * @returns {{session: Session, ws: Object}}
 */
const joined = (rooms, n, now) => {
    const ws = fakeSocket();
    const config = {secret: SECRET, issuers: [ISSUER]};
    const session = new Session(ws, {config, rooms, log: createLog('error', () => undefined), now: () => now});
    ws.emit('message', Buffer.from(JSON.stringify({t: 'hello', token: makeToken({sub: peerId(n)}, {now: seconds(now)})})), false);
    assert.equal(ws.sent[0].t, 'welcome');
    return {session, ws};
};

/**
 * Send a frame to a fake socket.
 *
 * @param {Object} ws
 * @param {Object} frame
 */
const deliver = (ws, frame) => ws.emit('message', Buffer.from(JSON.stringify(frame)), false);

test('a pose flood is cut to the pose bucket, extra poses are dropped silently', () => {
    const now = Date.now();
    const rooms = new Rooms({maxRoomPeers: 50, maxRooms: 10, graceMs: 10000, poseHz: 15});
    const {ws} = joined(rooms, 1, now);
    for (let i = 0; i < 50; i++) {
        deliver(ws, {t: 'pose', d: POSE});
    }
    assert.equal(rooms.seq, LIMITS.pose.burst);
    assert.equal(ws.closedWith, null);
    assert.equal(ws.sent.filter((frame) => frame.t === 'error').length, 0);
});

test('a state flood is cut to the state bucket', () => {
    const now = Date.now();
    const rooms = new Rooms({maxRoomPeers: 50, maxRooms: 10, graceMs: 10000, poseHz: 15});
    joined(rooms, 1, now);
    const b = joined(rooms, 2, now);
    const a = joined(rooms, 3, now);
    for (let i = 0; i < 30; i++) {
        deliver(a.ws, {t: 'state', d: STATE});
    }
    assert.equal(b.ws.sent.filter((frame) => frame.t === 'state').length, LIMITS.state.burst);
});

test('persistent abuse closes with 4429 after an error frame, and the others see leave removed', () => {
    const now = Date.now();
    const rooms = new Rooms({maxRoomPeers: 50, maxRooms: 10, graceMs: 10000, poseHz: 15});
    const other = joined(rooms, 1, now);
    const abuser = joined(rooms, 2, now);
    // The hello frame took one token of the all-frames bucket (frozen clock, no refill), so the
    // remaining burst - 1 frames pass and the next ABUSE_DROPS are dropped without closing.
    for (let i = 0; i < LIMITS.all.burst - 1 + ABUSE_DROPS; i++) {
        deliver(abuser.ws, {t: 'ping', n: i});
    }
    assert.equal(abuser.ws.closedWith, null);
    deliver(abuser.ws, {t: 'ping', n: 1});
    assert.equal(abuser.ws.closedWith, 4429);
    assert.deepEqual(abuser.ws.sent.at(-1), {t: 'error', code: 'ratelimited'});
    assert.deepEqual(other.ws.sent.filter((frame) => frame.t === 'leave'), [{t: 'leave', p: peerId(2), r: 'removed'}]);
    // Pings beyond the ping bucket were answered only up to its burst.
    assert.equal(abuser.ws.sent.filter((frame) => frame.t === 'pong').length, LIMITS.ping.burst);
});
