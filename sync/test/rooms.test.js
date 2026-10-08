// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync tests: rooms — capacity, takeover, replace, away grace, empty rooms, pose batching.

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MAX_BUFFERED, POSE_KEEP_MS, Rooms, SKIP_BUFFERED} from '../src/rooms.js';
import {ISSUER, POSE, STATE, fakeSession, makeClaims, peerId, poseAt, roomId} from './helpers.js';

const T0 = 1760000000000;

/**
 * Rooms with test defaults.
 *
 * @param {Object} overrides
 * @returns {Rooms}
 */
const makeRooms = (overrides = {}) => new Rooms(Object.assign({
    maxRoomPeers: 50,
    maxRooms: 1000,
    graceMs: 10000,
    poseHz: 15,
}, overrides));

/**
 * Admit a fake session as peer n of room r.
 *
 * @param {Rooms} rooms
 * @param {number} n
 * @param {Object} overrides Claim overrides.
 * @param {number} now
 * @returns {{session: Object, result: Object}}
 */
const admit = (rooms, n, overrides = {}, now = T0) => {
    const session = fakeSession();
    const claims = makeClaims(Object.assign({sub: peerId(n), name: 'Person ' + n}, overrides));
    const result = rooms.admit(session, claims, now);
    return {session, result};
};

test('admit sends welcome to the newcomer and join to the others', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    assert.deepEqual(a.result, {ok: true});
    const welcome = a.session.of('welcome')[0];
    assert.equal(welcome.self.p, peerId(1));
    assert.deepEqual(welcome.peers, []);
    assert.equal(welcome.room.max, 50);
    assert.equal(welcome.posehz, 15);

    const b = admit(rooms, 2);
    const welcomeb = b.session.of('welcome')[0];
    assert.deepEqual(welcomeb.peers, [{p: peerId(1), name: 'Person 1', kind: 'attempt', s: null}]);
    assert.deepEqual(a.session.of('join'), [{t: 'join', peer: {p: peerId(2), name: 'Person 2', kind: 'attempt'}}]);
    assert.equal(b.session.of('join').length, 0);
});

test('capacity is min(token max, MAX_ROOM_PEERS); the next one gets 4503', () => {
    const rooms = makeRooms({maxRoomPeers: 3});
    for (let n = 1; n <= 3; n++) {
        assert.equal(admit(rooms, n, {max: 50}).result.ok, true);
    }
    assert.deepEqual(admit(rooms, 4, {max: 50}).result, {ok: false, code: 4503});

    const small = makeRooms();
    assert.equal(admit(small, 1, {max: 2}).result.ok, true);
    assert.equal(admit(small, 2, {max: 2}).result.ok, true);
    assert.deepEqual(admit(small, 3, {max: 2}).result, {ok: false, code: 4503});
});

test('an away peer still counts until the grace runs out, then leave timeout', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1, {max: 2});
    const b = admit(rooms, 2, {max: 2});
    const room = b.session.room;
    rooms.away(room, b.session.peer, T0);
    assert.deepEqual(admit(rooms, 3, {max: 2}).result, {ok: false, code: 4503});
    assert.equal(a.session.of('leave').length, 0);

    rooms.sweep(T0 + 9999);
    assert.equal(a.session.of('leave').length, 0);
    rooms.sweep(T0 + 10000);
    assert.deepEqual(a.session.of('leave'), [{t: 'leave', p: peerId(2), r: 'timeout'}]);
    assert.equal(admit(rooms, 3, {max: 2}).result.ok, true);
});

test('a return within the grace takes the peer back without a join broadcast', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    const b = admit(rooms, 2);
    rooms.away(b.session.room, b.session.peer, T0);
    const again = admit(rooms, 2, {}, T0 + 5000);
    assert.equal(again.result.ok, true);
    assert.equal(a.session.of('join').length, 1);
    assert.equal(a.session.of('leave').length, 0);
    rooms.sweep(T0 + 20000);
    assert.equal(a.session.of('leave').length, 0);
});

test('same peer, same room: the new session takes over, the old one gets 4409, nobody is told', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    const b1 = admit(rooms, 2);
    const b2 = admit(rooms, 2);
    assert.equal(b2.result.ok, true);
    assert.equal(b1.session.kicked, 4409);
    assert.equal(b2.session.peer.session, b2.session);
    assert.equal(a.session.of('join').length, 1);
    assert.equal(a.session.of('leave').length, 0);
    assert.equal(rooms.counts().peers, 2);
});

test('same peer in another room: old session 4409 and leave replaced in the old room', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1, {room: roomId(1)});
    const b1 = admit(rooms, 2, {room: roomId(1)});
    const b2 = admit(rooms, 2, {room: roomId(2)});
    assert.equal(b2.result.ok, true);
    assert.equal(b1.session.kicked, 4409);
    assert.deepEqual(a.session.of('leave'), [{t: 'leave', p: peerId(2), r: 'replaced'}]);
    assert.equal(rooms.counts().rooms, 2);
});

test('a join refused for capacity leaves the presence in the other room untouched', () => {
    const rooms = makeRooms();
    admit(rooms, 5, {room: roomId(9), max: 2});
    admit(rooms, 6, {room: roomId(9), max: 2});
    const b1 = admit(rooms, 2, {room: roomId(1)});
    const refused = admit(rooms, 2, {room: roomId(9), max: 2});
    assert.deepEqual(refused.result, {ok: false, code: 4503});
    assert.equal(b1.session.kicked, null);
    assert.equal(b1.session.peer.session, b1.session);
});

test('rooms are separate per issuer', () => {
    const rooms = makeRooms();
    admit(rooms, 1, {max: 2});
    admit(rooms, 2, {max: 2});
    assert.equal(admit(rooms, 3, {max: 2, iss: 'https://other.example.org'}).result.ok, true);
    assert.equal(rooms.counts().rooms, 2);
    assert.ok(ISSUER);
});

test('an empty room is deleted; MAX_ROOMS refuses a new room with 4504', () => {
    const rooms = makeRooms({maxRooms: 1});
    const a = admit(rooms, 1, {room: roomId(1)});
    assert.deepEqual(admit(rooms, 2, {room: roomId(2)}).result, {ok: false, code: 4504});
    rooms.remove(a.session.room, a.session.peer, 'left');
    assert.equal(rooms.counts().rooms, 0);
    assert.equal(admit(rooms, 2, {room: roomId(2)}).result.ok, true);
});

test('moving the only peer of the last room to a new room is allowed at MAX_ROOMS', () => {
    const rooms = makeRooms({maxRooms: 1});
    admit(rooms, 1, {room: roomId(1)});
    assert.equal(admit(rooms, 1, {room: roomId(2)}).result.ok, true);
    assert.equal(rooms.counts().rooms, 1);
});

test('tick batches changed poses, never the own pose', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    const b = admit(rooms, 2);
    const c = admit(rooms, 3);
    rooms.setPose(a.session.peer, poseAt(1), T0);
    rooms.setPose(b.session.peer, poseAt(2), T0);
    rooms.tick(T0 + 10);
    assert.deepEqual(a.session.of('poses'), [{t: 'poses', b: [[peerId(2), poseAt(2)]]}]);
    assert.deepEqual(c.session.of('poses'), [{t: 'poses', b: [[peerId(1), poseAt(1)], [peerId(2), poseAt(2)]]}]);

    // Nothing changed: no frame.
    rooms.tick(T0 + 80);
    assert.equal(a.session.of('poses').length, 1);

    // Only the changed pose.
    rooms.setPose(b.session.peer, poseAt(3), T0 + 100);
    rooms.tick(T0 + 150);
    assert.deepEqual(c.session.of('poses')[1], {t: 'poses', b: [[peerId(2), poseAt(3)]]});
    assert.equal(b.session.of('poses').length, 1);
});

test('a newcomer gets poses younger than 3 s once, older ones only when they change', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    const b = admit(rooms, 2);
    rooms.setPose(a.session.peer, POSE, T0);
    rooms.setPose(b.session.peer, poseAt(5), T0 + POSE_KEEP_MS + 500);
    const c = admit(rooms, 3, {}, T0 + POSE_KEEP_MS + 600);
    rooms.tick(T0 + POSE_KEEP_MS + 700);
    assert.deepEqual(c.session.of('poses'), [{t: 'poses', b: [[peerId(2), poseAt(5)]]}]);
    rooms.setPose(a.session.peer, poseAt(6), T0 + POSE_KEEP_MS + 800);
    rooms.tick(T0 + POSE_KEEP_MS + 900);
    assert.deepEqual(c.session.of('poses')[1], {t: 'poses', b: [[peerId(1), poseAt(6)]]});
});

test('slow consumers skip ticks and are failed with 4008 above 4 MiB', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    const b = admit(rooms, 2);
    rooms.setPose(b.session.peer, POSE, T0);
    a.session.bufferedAmount = SKIP_BUFFERED + 1;
    rooms.tick(T0 + 10);
    assert.equal(a.session.of('poses').length, 0);
    assert.equal(a.session.failed, null);
    a.session.bufferedAmount = MAX_BUFFERED + 1;
    rooms.tick(T0 + 20);
    assert.equal(a.session.failed, 4008);
});

test('state is stored, relayed at once and sent to newcomers in welcome; direct state only to its target', () => {
    const rooms = makeRooms();
    const a = admit(rooms, 1);
    const b = admit(rooms, 2);
    rooms.setState(a.session.room, a.session.peer, STATE);
    assert.deepEqual(b.session.of('state'), [{t: 'state', p: peerId(1), d: STATE}]);
    assert.equal(a.session.of('state').length, 0);
    const c = admit(rooms, 3);
    const welcome = c.session.of('welcome')[0];
    assert.equal(welcome.peers.find((peer) => peer.p === peerId(1)).s, STATE);

    assert.equal(rooms.sendStateTo(c.session.room, c.session.peer, peerId(1), STATE), true);
    assert.deepEqual(a.session.of('state'), [{t: 'state', p: peerId(3), d: STATE}]);
    assert.equal(b.session.of('state').length, 1);
    assert.equal(rooms.sendStateTo(c.session.room, c.session.peer, peerId(99), STATE), false);
    assert.equal(rooms.sendStateTo(c.session.room, c.session.peer, peerId(3), STATE), false);
});

test('remove calls the LiveKit removal for every reason; a takeover does not', async () => {
    const calls = [];
    const rooms = makeRooms({livekit: {enabled: true, removeParticipant: (room, identity) => calls.push([room, identity])}});
    const a = admit(rooms, 1);
    admit(rooms, 1);
    assert.equal(calls.length, 0);
    rooms.remove(a.session.room, a.session.peer, 'left');
    assert.deepEqual(calls, [[roomId(1), peerId(1)]]);
});

test('a grace of 0 removes an away peer at once', () => {
    const rooms = makeRooms({graceMs: 0});
    const a = admit(rooms, 1);
    const b = admit(rooms, 2);
    rooms.away(b.session.room, b.session.peer, T0);
    assert.deepEqual(a.session.of('leave'), [{t: 'leave', p: peerId(2), r: 'timeout'}]);
});
