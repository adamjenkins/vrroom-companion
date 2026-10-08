// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync tests: token minting, an ephemeral server, ws clients with a frame queue.

import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
import {encode} from '../src/codec.js';
import {loadConfig} from '../src/config.js';
import {sign} from '../src/jwt.js';
import {createLog} from '../src/log.js';
import {SUBPROTOCOL} from '../src/protocol.js';
import {createServer} from '../src/server.js';

export const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
export const ISSUER = 'https://moodle.example.org';
export const ORIGIN = 'https://moodle.example.org';

/** Base environment for loadConfig in tests. */
export const BASE_ENV = Object.freeze({
    MAVR_SYNC_SECRET: SECRET,
    MAVR_SYNC_ISSUERS: ISSUER,
    MAVR_SYNC_LISTEN: '127.0.0.1:8090',
    MAVR_SYNC_LOG_LEVEL: 'debug',
});

/**
 * Current unix time in seconds.
 *
 * @param {number} [ms]
 * @returns {number}
 */
export const seconds = (ms = Date.now()) => Math.floor(ms / 1000);

/**
 * A peer id (32 hex) from a number.
 *
 * @param {number} n
 * @returns {string}
 */
export const peerId = (n) => n.toString(16).padStart(32, '0');

/**
 * A room id ('r' + 32 hex) from a number.
 *
 * @param {number} n
 * @returns {string}
 */
export const roomId = (n) => 'r' + n.toString(16).padStart(32, '0');

/**
 * Join claims with overrides.
 *
 * @param {Object} overrides
 * @param {number} [now] Unix seconds.
 * @returns {Object}
 */
export const makeClaims = (overrides = {}, now = seconds()) => Object.assign({
    iss: ISSUER,
    aud: 'mavr-sync',
    sub: peerId(1),
    room: roomId(1),
    name: 'Sam Student',
    kind: 'attempt',
    max: 50,
    iat: now,
    nbf: now,
    exp: now + 300,
    mavr: 'join',
    v: 1,
}, overrides);

/**
 * A signed join token.
 *
 * @param {Object} overrides Claim overrides.
 * @param {Object} [options] {secret, now}
 * @returns {string}
 */
export const makeToken = (overrides = {}, options = {}) =>
    sign(makeClaims(overrides, options.now), options.secret || SECRET);

/**
 * A signed admin test token.
 *
 * @param {Object} overrides
 * @param {Object} [options] {secret, now}
 * @returns {string}
 */
export const makeTestToken = (overrides = {}, options = {}) => {
    const now = options.now === undefined ? seconds() : options.now;
    return sign(Object.assign({
        iss: ISSUER,
        aud: 'mavr-sync',
        mavr: 'test',
        v: 1,
        nonce: 'abcdef0123456789abcdef0123456789',
        iat: now,
        nbf: now,
        exp: now + 60,
    }, overrides), options.secret || SECRET);
};

/** A valid pose codec string. */
export const POSE = encode('pose', {t: 'p', q: 1, ts: 1000, sc: 'scene1', m: '3d', h: [0, 1.6, 0, 0, 0, 0, 1], l: null, r: null});

/**
 * A pose codec string with another sequence number and position.
 *
 * @param {number} q
 * @returns {string}
 */
export const poseAt = (q) => encode('pose', {t: 'p', q, ts: 1000 + q, sc: 'scene1', m: 'vr', h: [q / 10, 1.6, 0, 0, 0, 0, 1], l: null, r: null});

/** A valid state codec string. */
export const STATE = encode('state', {t: 's', m: '3d', sc: 'scene1', mic: 'on'});

/**
 * A capturing logger.
 *
 * @returns {{log: Object, lines: string[]}}
 */
export const captureLog = () => {
    const lines = [];
    return {log: createLog('debug', (line) => lines.push(line)), lines};
};

/**
 * A clock that runs with real time plus an offset the test can advance.
 *
 * @returns {{now: function(): number, advance: function(number): void}}
 */
export const createClock = () => {
    let offset = 0;
    return {
        now: () => Date.now() + offset,
        advance: (ms) => {
            offset += ms;
        },
    };
};

/**
 * Wait.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a server on an ephemeral port.
 *
 * @param {Object} envOverrides
 * @param {Object} options createServer options (now, extensions, fetch, timers).
 * @returns {Promise<Object>} {app, config, lines, port, http, url, close}
 */
export const startServer = async (envOverrides = {}, options = {}) => {
    const config = loadConfig(Object.assign({}, BASE_ENV, envOverrides));
    const {log, lines} = captureLog();
    const app = createServer(config, Object.assign({
        log,
        timers: {sweepMs: 50, pingMs: 15000, summaryMs: 60000},
    }, options));
    const {port} = await app.listen({host: '127.0.0.1', port: 0});
    return {
        app,
        config,
        lines,
        port,
        http: `http://127.0.0.1:${port}`,
        url: `ws://127.0.0.1:${port}/sync`,
        close: () => app.close(),
    };
};

/**
 * Wrap a ws client: queue of parsed frames, close promise.
 *
 * @param {WebSocket} ws
 * @returns {Object}
 */
const wrap = (ws) => {
    const frames = [];
    const waiters = [];
    const flush = () => {
        for (const waiter of [...waiters]) {
            const index = frames.findIndex(waiter.match);
            if (index !== -1) {
                const [frame] = frames.splice(index, 1);
                waiters.splice(waiters.indexOf(waiter), 1);
                clearTimeout(waiter.timer);
                waiter.resolve(frame);
            }
        }
    };
    const closed = new Promise((resolve) => {
        ws.on('close', (code, reason) => resolve({code, reason: reason.toString()}));
    });
    ws.on('error', () => {
        // Reported through 'close'.
    });
    ws.on('message', (data) => {
        let frame;
        try {
            frame = JSON.parse(data.toString());
        } catch (e) {
            frame = {t: '(invalid)'};
        }
        frames.push(frame);
        flush();
    });
    return {
        ws,
        frames,
        closed,
        send(value) {
            ws.send(typeof value === 'string' ? value : JSON.stringify(value));
        },
        next(t, timeout = 3000) {
            return new Promise((resolve, reject) => {
                const waiter = {
                    match: (frame) => frame.t === t,
                    resolve,
                    timer: setTimeout(() => {
                        waiters.splice(waiters.indexOf(waiter), 1);
                        reject(new Error(`No '${t}' frame within ${timeout} ms`));
                    }, timeout),
                };
                waiters.push(waiter);
                flush();
            });
        },
        async none(t, ms = 300) {
            await delay(ms);
            return !frames.some((frame) => frame.t === t);
        },
        close(code = 1000) {
            ws.close(code);
        },
    };
};

/**
 * Open a WebSocket client.
 *
 * @param {string} url
 * @param {{protocol?: (string|null), origin?: string}} options protocol null = none offered.
 * @returns {Promise<Object>} The wrapped client; rejects with an Error carrying `status` when the
 *     server refuses the upgrade.
 */
export const connect = (url, options = {}) => new Promise((resolve, reject) => {
    const protocol = options.protocol === undefined ? SUBPROTOCOL : options.protocol;
    const ws = new WebSocket(url, protocol === null ? [] : [protocol], options.origin ? {origin: options.origin} : {});
    const client = wrap(ws);
    ws.once('open', () => resolve(client));
    ws.once('error', (error) => {
        const match = /Unexpected server response: (\d+)/.exec(error.message);
        const failure = new Error(error.message);
        failure.status = match ? Number(match[1]) : 0;
        reject(failure);
    });
});

/**
 * Connect, say hello with a join token, wait for welcome.
 *
 * @param {Object} server From startServer().
 * @param {Object} claims Claim overrides.
 * @param {Object} [options] connect options.
 * @returns {Promise<{client: Object, welcome: Object}>}
 */
export const joinAs = async (server, claims = {}, options = {}) => {
    const client = await connect(server.url, options);
    client.send({t: 'hello', token: makeToken(claims)});
    const welcome = await client.next('welcome');
    return {client, welcome};
};

/**
 * A fake ws socket for unit tests of Session.
 *
 * @returns {EventEmitter} With readyState, bufferedAmount, sent[], closedWith, send/close/ping/terminate.
 */
export const fakeSocket = () => {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.bufferedAmount = 0;
    ws.sent = [];
    ws.closedWith = null;
    ws.send = (frame) => ws.sent.push(JSON.parse(frame));
    ws.close = (code) => {
        ws.closedWith = code;
        ws.readyState = 3;
        ws.emit('close', code);
    };
    ws.ping = () => undefined;
    ws.terminate = () => {
        ws.readyState = 3;
        ws.emit('close', 1006);
    };
    return ws;
};

/**
 * A fake session for unit tests of Rooms.
 *
 * @returns {Object}
 */
export const fakeSession = () => ({
    sent: [],
    kicked: null,
    failed: null,
    bufferedAmount: 0,
    seen: null,
    send(frame) {
        this.sent.push(JSON.parse(frame));
    },
    attach(room, peer) {
        this.room = room;
        this.peer = peer;
        this.seen = new Map();
    },
    kick(code) {
        this.kicked = code;
    },
    fail(code) {
        this.failed = code;
    },
    of(t) {
        return this.sent.filter((frame) => frame.t === t);
    },
});
