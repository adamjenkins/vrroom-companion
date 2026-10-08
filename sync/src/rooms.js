// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync: rooms and peers, in memory only while used (capacity, replace, away grace, pose batching).

import * as Protocol from './protocol.js';

const {CLOSE} = Protocol;

/** A newcomer's first pose tick includes poses younger than this (ms). */
export const POSE_KEEP_MS = 3000;

/** Buffered bytes above which a session skips pose ticks. */
export const SKIP_BUFFERED = 262144;

/** Buffered bytes above which a session is closed as a slow consumer. */
export const MAX_BUFFERED = 4 * 1024 * 1024;

/**
 * Session interface used by Rooms (src/session.js implements it; tests use fakes):
 * - send(frame: string): void — send if open;
 * - attach(room, peer): void — the session joined (Rooms calls it before sending welcome);
 * - kick(code: number): void — close the socket without any further room handling;
 * - fail(code: number): void — remove the peer (reason 'removed') and close;
 * - bufferedAmount: number;
 * - seen: Map<string, number> — pose sequence last sent per peer (set by attach).
 */

/**
 * Rooms of all issuers.
 */
export class Rooms {
    /**
     * @param {Object} options
     * @param {number} options.maxRoomPeers Global room capacity (MAVR_SYNC_MAX_ROOM_PEERS).
     * @param {number} options.maxRooms MAVR_SYNC_MAX_ROOMS.
     * @param {number} options.graceMs Away grace in ms.
     * @param {number} options.poseHz Pose tick rate (sent in welcome).
     * @param {Object} [options.hooks] Extension host ({emit}).
     * @param {Object} [options.livekit] LiveKit admin ({enabled, removeParticipant}).
     * @param {Object} [options.log] Logger.
     */
    constructor({maxRoomPeers, maxRooms, graceMs, poseHz, hooks = null, livekit = null, log = null}) {
        this.maxRoomPeers = maxRoomPeers;
        this.maxRooms = maxRooms;
        this.graceMs = graceMs;
        this.poseHz = poseHz;
        this.hooks = hooks;
        this.livekit = livekit;
        this.log = log;
        /** @type {Map<string, Object>} room key (iss \n room) → room */
        this.rooms = new Map();
        /** @type {Map<string, string>} iss \n sub → room key */
        this.index = new Map();
        this.seq = 0;
    }

    /**
     * Call an extension hook (never throws).
     *
     * @param {string} hook
     * @param {Object} view
     */
    emit(hook, view) {
        if (this.hooks) {
            this.hooks.emit(hook, view);
        }
    }

    /**
     * Room view for hooks.
     *
     * @param {Object} room
     * @returns {Object}
     */
    static roomView(room) {
        return {iss: room.iss, room: room.room, size: room.peers.size, max: room.max};
    }

    /**
     * Peer view for hooks.
     *
     * @param {Object} peer
     * @returns {Object}
     */
    static peerView(peer) {
        return {sub: peer.sub, name: peer.name, kind: peer.kind};
    }

    /**
     * Send a frame to every peer of a room that has a session, except one.
     *
     * @param {Object} room
     * @param {string} frame
     * @param {string|null} except Peer id to skip.
     */
    broadcast(room, frame, except) {
        for (const peer of room.peers.values()) {
            if (peer.sub !== except && peer.session) {
                peer.session.send(frame);
            }
        }
    }

    /**
     * Send welcome to a session that has just been attached to a peer.
     *
     * @param {Object} room
     * @param {Object} peer
     * @param {number} exp Session expiry (unix seconds).
     */
    sendWelcome(room, peer, exp) {
        const others = [...room.peers.values()].filter((other) => other.sub !== peer.sub);
        peer.session.send(Protocol.welcome({self: peer, max: room.max, peers: others, exp, posehz: this.poseHz}));
    }

    /**
     * Admit a session whose hello token has been verified.
     *
     * @param {Object} session
     * @param {Object} claims Verified join claims ({iss, sub, room, name, kind, max, exp}).
     * @param {number} now ms
     * @returns {{ok: true}|{ok: false, code: number}} code 4503 (room full) or 4504 (server full).
     */
    admit(session, claims, now) {
        const peerkey = claims.iss + '\n' + claims.sub;
        const key = claims.iss + '\n' + claims.room;
        const cap = Math.min(claims.max, this.maxRoomPeers);
        const previouskey = this.index.get(peerkey);

        // Same peer, same room: a second tab or a reconnect within the away grace takes over.
        if (previouskey === key) {
            const room = this.rooms.get(key);
            const peer = room.peers.get(claims.sub);
            const old = peer.session;
            peer.session = session;
            peer.awayUntil = 0;
            room.max = cap;
            session.attach(room, peer);
            if (old && old !== session) {
                old.kick(CLOSE.REPLACED);
            }
            this.sendWelcome(room, peer, claims.exp);
            return {ok: true};
        }

        // Capacity first, so a refused join leaves an existing presence elsewhere untouched.
        let room = this.rooms.get(key);
        if (!room) {
            const freed = previouskey !== undefined && this.rooms.get(previouskey).peers.size === 1 ? 1 : 0;
            if (this.rooms.size - freed >= this.maxRooms) {
                return {ok: false, code: CLOSE.BUSY};
            }
        } else if (room.peers.size >= cap) {
            return {ok: false, code: CLOSE.FULL};
        }

        // Same peer in another room: one live presence per user and activity.
        if (previouskey !== undefined) {
            const oldroom = this.rooms.get(previouskey);
            const oldpeer = oldroom.peers.get(claims.sub);
            const old = oldpeer.session;
            oldpeer.session = null;
            if (old) {
                old.kick(CLOSE.REPLACED);
            }
            this.remove(oldroom, oldpeer, 'replaced');
        }

        if (!room) {
            room = {key, iss: claims.iss, room: claims.room, max: cap, peers: new Map()};
            this.rooms.set(key, room);
            this.emit('roomOpened', {room: Rooms.roomView(room)});
        }
        room.max = cap;
        const peer = {
            sub: claims.sub,
            name: claims.name,
            kind: claims.kind,
            session,
            awayUntil: 0,
            pose: null,
            poseAt: 0,
            poseSeq: 0,
            state: null,
        };
        room.peers.set(peer.sub, peer);
        this.index.set(peerkey, key);
        session.attach(room, peer);
        this.sendWelcome(room, peer, claims.exp);
        this.broadcast(room, Protocol.join(peer), peer.sub);
        this.emit('peerJoined', {room: Rooms.roomView(room), peer: Rooms.peerView(peer)});
        return {ok: true};
    }

    /**
     * A joined session closed unexpectedly: the peer is away for the grace period.
     *
     * @param {Object} room
     * @param {Object} peer
     * @param {number} now ms
     */
    away(room, peer, now) {
        peer.session = null;
        if (this.graceMs <= 0) {
            this.remove(room, peer, 'timeout');
            return;
        }
        peer.awayUntil = now + this.graceMs;
    }

    /**
     * Remove a peer: tell the others, drop an empty room, remove the person from voice, call hooks.
     * The caller closes the peer's socket when needed.
     *
     * @param {Object} room
     * @param {Object} peer
     * @param {string} reason One of protocol LEAVE_REASONS.
     */
    remove(room, peer, reason) {
        if (room.peers.get(peer.sub) !== peer) {
            return;
        }
        room.peers.delete(peer.sub);
        const peerkey = room.iss + '\n' + peer.sub;
        if (this.index.get(peerkey) === room.key) {
            this.index.delete(peerkey);
        }
        for (const other of room.peers.values()) {
            if (other.session && other.session.seen) {
                other.session.seen.delete(peer.sub);
            }
        }
        this.broadcast(room, Protocol.leave(peer.sub, reason), peer.sub);
        this.emit('peerLeft', {room: Rooms.roomView(room), peer: Rooms.peerView(peer), reason});
        if (this.livekit && this.livekit.enabled) {
            // Voice presence follows room presence. Never rejects.
            this.livekit.removeParticipant(room.room, peer.sub);
        }
        if (room.peers.size === 0) {
            this.rooms.delete(room.key);
            this.emit('roomClosed', {room: Rooms.roomView(room)});
        }
    }

    /**
     * Store a peer's latest pose (already validated and re-encoded).
     *
     * @param {Object} peer
     * @param {string} pose Codec string.
     * @param {number} now ms
     */
    setPose(peer, pose, now) {
        this.seq += 1;
        peer.pose = pose;
        peer.poseAt = now;
        peer.poseSeq = this.seq;
    }

    /**
     * Store a peer's latest state and relay it to the others at once.
     *
     * @param {Object} room
     * @param {Object} peer
     * @param {string} state Codec string.
     */
    setState(room, peer, state) {
        peer.state = state;
        this.broadcast(room, Protocol.state(peer.sub, state), peer.sub);
        this.emit('stateChanged', {room: Rooms.roomView(room), peer: Rooms.peerView(peer), state});
    }

    /**
     * Relay a state to one peer of the same room (not stored).
     *
     * @param {Object} room
     * @param {Object} peer Sender.
     * @param {string} to Receiver's peer id.
     * @param {string} state Codec string.
     * @returns {boolean} Whether it was sent.
     */
    sendStateTo(room, peer, to, state) {
        const target = room.peers.get(to);
        if (!target || target === peer || !target.session) {
            return false;
        }
        target.session.send(Protocol.state(peer.sub, state));
        return true;
    }

    /**
     * Remove peers whose away grace has run out.
     *
     * @param {number} now ms
     */
    sweep(now) {
        const expired = [];
        for (const room of this.rooms.values()) {
            for (const peer of room.peers.values()) {
                if (!peer.session && peer.awayUntil > 0 && peer.awayUntil <= now) {
                    expired.push([room, peer]);
                }
            }
        }
        for (const [room, peer] of expired) {
            this.remove(room, peer, 'timeout');
        }
    }

    /**
     * Pose tick: one poses frame per joined session with the poses changed since its last tick.
     *
     * @param {number} now ms
     */
    tick(now) {
        const slow = [];
        for (const room of this.rooms.values()) {
            if (room.peers.size < 2) {
                continue;
            }
            for (const receiver of room.peers.values()) {
                const session = receiver.session;
                if (!session || !session.seen) {
                    continue;
                }
                const buffered = Number(session.bufferedAmount) || 0;
                if (buffered > MAX_BUFFERED) {
                    slow.push(session);
                    continue;
                }
                if (buffered > SKIP_BUFFERED) {
                    continue;
                }
                const batch = [];
                for (const sender of room.peers.values()) {
                    if (sender === receiver || !sender.pose) {
                        continue;
                    }
                    const last = session.seen.get(sender.sub);
                    if (last === undefined) {
                        session.seen.set(sender.sub, sender.poseSeq);
                        if (now - sender.poseAt <= POSE_KEEP_MS) {
                            batch.push([sender.sub, sender.pose]);
                        }
                    } else if (sender.poseSeq > last) {
                        session.seen.set(sender.sub, sender.poseSeq);
                        batch.push([sender.sub, sender.pose]);
                    }
                }
                if (batch.length > 0) {
                    session.send(Protocol.poses(batch));
                }
            }
        }
        for (const session of slow) {
            session.fail(CLOSE.SLOW);
        }
    }

    /**
     * Counts for the summary log line.
     *
     * @returns {{rooms: number, peers: number, away: number}}
     */
    counts() {
        let peers = 0;
        let away = 0;
        for (const room of this.rooms.values()) {
            peers += room.peers.size;
            for (const peer of room.peers.values()) {
                if (!peer.session) {
                    away += 1;
                }
            }
        }
        return {rooms: this.rooms.size, peers, away};
    }
}
