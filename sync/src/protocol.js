// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: wire protocol 'vrroom-sync.1', server side (client frame parser, server frame builders).

/** WebSocket subprotocol of this protocol version. */
export const SUBPROTOCOL = 'vrroom-sync.1';

/** Protocol version number (in welcome and the health answer). */
export const PROTOCOL_VERSION = 1;

/** Server version string. */
export const SERVER_VERSION = '0.1.0';

/** Largest frame accepted from a client, in bytes. */
export const MAX_FRAME = 4096;

/** Largest token in hello/auth, in characters. */
export const MAX_TOKEN = 3000;

/** Largest codec string in pose/state frames, in characters. */
export const MAX_DATA = 2048;

/** Largest app-level ping number. */
export const MAX_PING = 2147483647;

/** Close codes (build contract §2.4). */
export const CLOSE = Object.freeze({
    NORMAL: 1000,
    GOING_AWAY: 1001,
    TOO_BIG: 1009,
    PROTOCOL: 4000,
    HELLO_TIMEOUT: 4001,
    SLOW: 4008,
    UNAUTHORISED: 4401,
    FORBIDDEN: 4403,
    REPLACED: 4409,
    EXPIRED: 4410,
    RATE: 4429,
    FULL: 4503,
    BUSY: 4504,
});

/** Reasons in a leave frame. */
export const LEAVE_REASONS = Object.freeze(['left', 'timeout', 'replaced', 'expired', 'removed']);

/** Codes in an error frame. */
export const ERROR_CODES = Object.freeze(['auth', 'ratelimited', 'protocol', 'full', 'busy']);

/** Peer id shape. */
const PEER_ID = /^[0-9a-f]{32}$/;

/**
 * Whether a value is a peer id (32 lowercase hex characters).
 *
 * @param {*} value
 * @returns {boolean}
 */
export const isPeerId = (value) => typeof value === 'string' && PEER_ID.test(value);

/** Result of parseClient for a well-formed frame with an unknown type. */
export const UNKNOWN = 'unknown';

/**
 * Parse a frame received from a client.
 *
 * @param {Buffer|string} data
 * @param {boolean} isBinary
 * @returns {Object|null|string} A fresh frame object rebuilt from known keys; null when malformed
 *     (binary, not JSON, not an object, missing or invalid fields); UNKNOWN for an unknown `t`.
 */
export const parseClient = (data, isBinary) => {
    if (isBinary) {
        return null;
    }
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
    if (text === null || Buffer.byteLength(text, 'utf8') > MAX_FRAME) {
        return null;
    }
    let frame;
    try {
        frame = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.t !== 'string') {
        return null;
    }
    switch (frame.t) {
        case 'hello':
        case 'auth':
            if (typeof frame.token !== 'string' || frame.token.length < 1 || frame.token.length > MAX_TOKEN) {
                return null;
            }
            return {t: frame.t, token: frame.token};
        case 'pose':
            if (typeof frame.d !== 'string' || frame.d.length > MAX_DATA) {
                return null;
            }
            return {t: 'pose', d: frame.d};
        case 'state':
            if (typeof frame.d !== 'string' || frame.d.length > MAX_DATA) {
                return null;
            }
            if (frame.to !== undefined && frame.to !== null && frame.to !== '') {
                if (!isPeerId(frame.to)) {
                    return null;
                }
                return {t: 'state', d: frame.d, to: frame.to};
            }
            return {t: 'state', d: frame.d};
        case 'ping':
            if (!Number.isInteger(frame.n) || frame.n < 0 || frame.n > MAX_PING) {
                return null;
            }
            return {t: 'ping', n: frame.n};
        case 'leave':
            return {t: 'leave'};
        default:
            return UNKNOWN;
    }
};

/**
 * A peer as sent to clients.
 *
 * @param {{sub: string, name: string, kind: string}} peer
 * @returns {{p: string, name: string, kind: string}}
 */
const peerInfo = (peer) => ({p: peer.sub, name: peer.name, kind: peer.kind});

/**
 * welcome frame.
 *
 * @param {{self: Object, max: number, peers: Object[], exp: number, posehz: number}} data self and
 *     peers are peer objects ({sub, name, kind, state}).
 * @returns {string}
 */
export const welcome = ({self, max, peers, exp, posehz}) => JSON.stringify({
    t: 'welcome',
    protocol: PROTOCOL_VERSION,
    server: SERVER_VERSION,
    self: peerInfo(self),
    room: {max},
    peers: peers.map((peer) => Object.assign(peerInfo(peer), {s: peer.state || null})),
    exp,
    posehz,
});

/**
 * join frame.
 *
 * @param {Object} peer
 * @returns {string}
 */
export const join = (peer) => JSON.stringify({t: 'join', peer: peerInfo(peer)});

/**
 * leave frame.
 *
 * @param {string} p Peer id.
 * @param {string} r One of LEAVE_REASONS.
 * @returns {string}
 */
export const leave = (p, r) => JSON.stringify({t: 'leave', p, r});

/**
 * poses frame.
 *
 * @param {Array<Array<string>>} b [[peer id, pose codec string], …]
 * @returns {string}
 */
export const poses = (b) => JSON.stringify({t: 'poses', b});

/**
 * state frame.
 *
 * @param {string} p Peer id.
 * @param {string} d State codec string.
 * @returns {string}
 */
export const state = (p, d) => JSON.stringify({t: 'state', p, d});

/**
 * authok frame.
 *
 * @param {number} exp New session expiry (unix seconds).
 * @returns {string}
 */
export const authok = (exp) => JSON.stringify({t: 'authok', exp});

/**
 * pong frame.
 *
 * @param {number} n
 * @returns {string}
 */
export const pong = (n) => JSON.stringify({t: 'pong', n});

/**
 * error frame.
 *
 * @param {string} code One of ERROR_CODES.
 * @returns {string}
 */
export const error = (code) => JSON.stringify({t: 'error', code});
