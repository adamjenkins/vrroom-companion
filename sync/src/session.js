// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync: one client WebSocket — hello, token checks, rate limits, frame handling, deadlines.

import {decode, encode} from './codec.js';
import {verify, MAX_LIFETIME} from './jwt.js';
import * as Protocol from './protocol.js';
import {createAbuseCounter, createSessionLimits} from './ratelimit.js';

const {CLOSE} = Protocol;

/** WebSocket readyState OPEN. */
const OPEN = 1;

/** Time a client has to send hello, in ms. */
export const HELLO_TIMEOUT_MS = 5000;

/** Grace after token expiry before a joined session is closed (4410), in seconds. */
export const EXPIRY_GRACE = 30;

/** Malformed frames in a row that close the session (4000). */
export const MAX_MALFORMED = 20;

/** Missed WebSocket pongs that end the connection. */
export const MAX_MISSED_PONGS = 2;

/**
 * One client connection.
 */
export class Session {
    /**
     * @param {Object} ws A ws WebSocket (or a test double with the same surface).
     * @param {Object} context
     * @param {Object} context.config Configuration (src/config.js).
     * @param {Object} context.rooms Rooms (src/rooms.js).
     * @param {Object} context.log Logger.
     * @param {function(): number} context.now Clock in ms.
     * @param {function(Session, number): void} [context.onDone] Called once when the socket closed.
     */
    constructor(ws, {config, rooms, log, now, onDone = null}) {
        this.ws = ws;
        this.config = config;
        this.rooms = rooms;
        this.log = log;
        this.now = now;
        this.onDone = onDone;
        const start = now();
        /** 'pending' → 'joined' → 'closed' */
        this.phase = 'pending';
        this.helloDeadline = start + HELLO_TIMEOUT_MS;
        this.limits = createSessionLimits(start);
        this.abuse = createAbuseCounter();
        this.malformed = 0;
        this.room = null;
        this.peer = null;
        this.iss = '';
        this.sub = '';
        this.roomid = '';
        this.exp = 0;
        this.seen = null;
        this.awaitingPong = false;
        this.missedPongs = 0;
        this.done = false;

        ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
        ws.on('close', (code) => this.onSocketClose(code));
        ws.on('error', () => {
            // ws closes the socket itself (e.g. 1009 for an oversize frame); 'close' follows.
        });
        ws.on('pong', () => {
            this.awaitingPong = false;
            this.missedPongs = 0;
        });
    }

    /**
     * Buffered outgoing bytes.
     *
     * @returns {number}
     */
    get bufferedAmount() {
        return Number(this.ws.bufferedAmount) || 0;
    }

    /**
     * Whether this session is the live session of its peer.
     *
     * @returns {boolean}
     */
    get joined() {
        return this.phase === 'joined' && this.peer !== null && this.peer.session === this;
    }

    /**
     * Send a frame when the socket is open.
     *
     * @param {string} frame
     */
    send(frame) {
        if (this.ws.readyState === OPEN) {
            this.ws.send(frame);
        }
    }

    /**
     * Rooms calls this when the session has been admitted.
     *
     * @param {Object} room
     * @param {Object} peer
     */
    attach(room, peer) {
        this.room = room;
        this.peer = peer;
        this.phase = 'joined';
        this.seen = new Map();
    }

    /**
     * Close the socket without further room handling (Rooms has done it, or there is nothing to do).
     *
     * @param {number} code
     */
    kick(code) {
        this.phase = 'closed';
        this.closeSocket(code);
    }

    /**
     * Remove the peer from its room (when this is its live session), then close.
     *
     * @param {number} code Close code.
     * @param {string} reason Leave reason for the others.
     */
    end(code, reason) {
        if (this.joined) {
            this.rooms.remove(this.room, this.peer, reason);
        }
        this.kick(code);
    }

    /**
     * Remove the peer (reason 'removed') and close — slow consumer, rate limit, protocol violation.
     *
     * @param {number} code
     */
    fail(code) {
        this.end(code, 'removed');
    }

    /**
     * Server shutdown: close with 1001 and keep the peer state as it is (the process ends).
     */
    shutdown() {
        this.kick(CLOSE.GOING_AWAY);
    }

    /**
     * Close the socket if it is still open.
     *
     * @param {number} code
     */
    closeSocket(code) {
        try {
            if (this.ws.readyState === OPEN || this.ws.readyState === 0) {
                this.ws.close(code);
            }
        } catch (e) {
            this.ws.terminate();
        }
    }

    /**
     * The socket closed (for whatever reason).
     *
     * @param {number} code
     */
    onSocketClose(code) {
        if (this.done) {
            return;
        }
        this.done = true;
        if (this.joined) {
            // Unexpected close: away for the grace period, the others are told later if needed.
            this.rooms.away(this.room, this.peer, this.now());
        }
        this.phase = 'closed';
        if (this.onDone) {
            this.onDone(this, code);
        }
    }

    /**
     * Count a malformed frame; too many in a row close the session.
     */
    onMalformed() {
        this.malformed += 1;
        if (this.malformed >= MAX_MALFORMED) {
            this.send(Protocol.error('protocol'));
            this.fail(CLOSE.PROTOCOL);
        }
    }

    /**
     * A frame arrived.
     *
     * @param {Buffer} data
     * @param {boolean} isBinary
     */
    onMessage(data, isBinary) {
        if (this.phase === 'closed') {
            return;
        }
        const now = this.now();
        if (!this.limits.all.take(now)) {
            if (this.abuse.add(now)) {
                this.send(Protocol.error('ratelimited'));
                this.fail(CLOSE.RATE);
            }
            return;
        }
        const frame = Protocol.parseClient(data, isBinary);
        if (this.phase === 'pending') {
            if (frame === null || frame === Protocol.UNKNOWN || frame.t !== 'hello') {
                this.send(Protocol.error('protocol'));
                this.kick(CLOSE.PROTOCOL);
                return;
            }
            this.onHello(frame.token, now);
            return;
        }
        if (frame === Protocol.UNKNOWN) {
            return;
        }
        if (frame === null) {
            this.onMalformed();
            return;
        }
        switch (frame.t) {
            case 'auth':
                this.malformed = 0;
                if (this.limits.auth.take(now)) {
                    this.onAuth(frame.token, now);
                }
                return;
            case 'pose':
                if (!this.limits.pose.take(now)) {
                    return;
                }
                this.onPose(frame.d, now);
                return;
            case 'state':
                if (!this.limits.state.take(now)) {
                    return;
                }
                this.onState(frame.d, frame.to);
                return;
            case 'ping':
                this.malformed = 0;
                if (this.limits.ping.take(now)) {
                    this.send(Protocol.pong(frame.n));
                }
                return;
            case 'leave':
                this.malformed = 0;
                this.end(CLOSE.NORMAL, 'left');
                return;
            default:
                // A second hello: protocol misuse.
                this.onMalformed();
        }
    }

    /**
     * hello: verify the token and ask the rooms to admit this session.
     *
     * @param {string} token
     * @param {number} now ms
     */
    onHello(token, now) {
        const result = verify(token, this.config.secret, {
            purpose: 'join',
            issuers: this.config.issuers,
            now: Math.floor(now / 1000),
            maxLifetime: MAX_LIFETIME.join,
        });
        if (!result.ok) {
            this.kick(result.code);
            return;
        }
        const claims = result.claims;
        this.iss = claims.iss;
        this.sub = claims.sub;
        this.roomid = claims.room;
        this.exp = claims.exp;
        const admitted = this.rooms.admit(this, claims, now);
        if (!admitted.ok) {
            this.send(Protocol.error(admitted.code === CLOSE.FULL ? 'full' : 'busy'));
            this.kick(admitted.code);
        }
    }

    /**
     * auth: a fresh token for the same peer and room extends the session.
     *
     * @param {string} token
     * @param {number} now ms
     */
    onAuth(token, now) {
        if (!this.joined) {
            return;
        }
        const seconds = Math.floor(now / 1000);
        const result = verify(token, this.config.secret, {
            purpose: 'join',
            issuers: this.config.issuers,
            now: seconds,
            maxLifetime: MAX_LIFETIME.join,
        });
        if (!result.ok || result.claims.iss !== this.iss || result.claims.sub !== this.sub ||
                result.claims.room !== this.roomid || result.claims.exp <= seconds) {
            this.send(Protocol.error('auth'));
            return;
        }
        this.exp = Math.max(this.exp, result.claims.exp);
        this.send(Protocol.authok(this.exp));
    }

    /**
     * pose: validate with the Phase 3 codec, store the re-encoded string for the next tick.
     *
     * @param {string} data
     * @param {number} now ms
     */
    onPose(data, now) {
        if (!this.joined) {
            return;
        }
        const message = decode('pose', data);
        const clean = message ? encode('pose', message) : null;
        if (clean === null) {
            this.onMalformed();
            return;
        }
        this.malformed = 0;
        this.rooms.setPose(this.peer, clean, now);
    }

    /**
     * state: validate, then relay to everyone (stored) or to one peer (not stored).
     *
     * @param {string} data
     * @param {string|undefined} to
     */
    onState(data, to) {
        if (!this.joined) {
            return;
        }
        const message = decode('state', data);
        const clean = message ? encode('state', message) : null;
        if (clean === null) {
            this.onMalformed();
            return;
        }
        this.malformed = 0;
        if (to) {
            this.rooms.sendStateTo(this.room, this.peer, to, clean);
        } else {
            this.rooms.setState(this.room, this.peer, clean);
        }
    }

    /**
     * Deadlines, checked by the server's sweep: hello timeout and session expiry.
     *
     * @param {number} now ms
     */
    checkDeadlines(now) {
        if (this.phase === 'pending' && now >= this.helloDeadline) {
            this.kick(CLOSE.HELLO_TIMEOUT);
            return;
        }
        if (this.joined && now >= (this.exp + EXPIRY_GRACE) * 1000) {
            this.end(CLOSE.EXPIRED, 'expired');
        }
    }

    /**
     * WebSocket ping, every server ping interval; missing pongs end the connection.
     */
    heartbeat() {
        if (this.phase === 'closed' || this.ws.readyState !== OPEN) {
            return;
        }
        if (this.awaitingPong) {
            this.missedPongs += 1;
            if (this.missedPongs >= MAX_MISSED_PONGS) {
                // Counts as an unexpected close: the peer is away for the grace period.
                this.ws.terminate();
                return;
            }
        }
        this.awaitingPong = true;
        try {
            this.ws.ping();
        } catch (e) {
            this.ws.terminate();
        }
    }
}
