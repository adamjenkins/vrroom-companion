// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: entry point — HTTP routes, WebSocket upgrade on /sync, timers and graceful shutdown.

import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createChallengeHandler} from './challenge.js';
import {ConfigError, loadConfig} from './config.js';
import {createExtensionHost, ROUTE_PREFIX} from './extensions.js';
import {createLiveKitAdmin} from './livekit_admin.js';
import {createLog} from './log.js';
import {MAX_FRAME, PROTOCOL_VERSION, SERVER_VERSION, SUBPROTOCOL} from './protocol.js';
import {Rooms} from './rooms.js';
import {Session} from './session.js';

/** WebSocket path. */
export const SYNC_PATH = '/sync';

/** Default timer periods in ms. */
export const TIMERS = Object.freeze({sweepMs: 1000, pingMs: 15000, summaryMs: 60000});

/** Time allowed for a graceful shutdown before remaining sockets are cut, in ms. */
export const SHUTDOWN_MS = 4000;

/** Common response headers: JSON, never cached, no CORS. */
const HEADERS = Object.freeze({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
});

/**
 * Write a JSON response.
 *
 * @param {Object} res
 * @param {number} status
 * @param {Object} body
 */
const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, Object.assign({'Content-Length': Buffer.byteLength(text)}, HEADERS));
    res.end(text);
};

/**
 * Refuse an upgrade request with a plain HTTP answer.
 *
 * @param {Object} socket
 * @param {number} status
 * @param {string} error
 */
const refuseUpgrade = (socket, status, error) => {
    if (socket.writable) {
        const text = JSON.stringify({error});
        socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n` +
            'Connection: close\r\n' +
            'Content-Type: application/json\r\n' +
            'Cache-Control: no-store\r\n' +
            `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` + text);
    }
    socket.destroy();
};

/**
 * Subprotocols offered in Sec-WebSocket-Protocol.
 *
 * @param {*} header
 * @returns {string[]}
 */
const offeredProtocols = (header) => (typeof header === 'string' ?
    header.split(',').map((item) => item.trim()).filter((item) => item !== '') : []);

/**
 * Path part of a request URL.
 *
 * @param {Object} req
 * @returns {string}
 */
const pathOf = (req) => String(req.url || '/').split('?')[0];

/**
 * Create the service.
 *
 * @param {Object} config From loadConfig().
 * @param {Object} [options]
 * @param {Object} [options.log] Logger.
 * @param {function(): number} [options.now] Clock in ms (tests inject one).
 * @param {Object} [options.extensions] Extension host (already loaded).
 * @param {Function} [options.fetch] fetch for the LiveKit admin client.
 * @param {Object} [options.timers] Overrides of TIMERS.
 * @returns {{listen: Function, close: Function, address: Function, rooms: Rooms, sessions: Set}}
 */
export const createServer = (config, options = {}) => {
    const log = options.log || createLog(config.logLevel);
    const now = options.now || Date.now;
    const timers = Object.assign({}, TIMERS, options.timers || {});
    const extensions = options.extensions || createExtensionHost(log);
    const livekit = createLiveKitAdmin(config.livekit, {fetch: options.fetch, now, log});
    const rooms = new Rooms({
        maxRoomPeers: config.maxRoomPeers,
        maxRooms: config.maxRooms,
        graceMs: config.graceSeconds * 1000,
        poseHz: config.poseHz,
        hooks: extensions,
        livekit,
        log,
    });
    const challenge = createChallengeHandler(config, {now, livekitadmin: livekit.enabled});
    const sessions = new Set();
    const closes = new Map();
    const intervals = [];
    let closing = false;

    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_FRAME,
        perMessageDeflate: false,
        clientTracking: true,
        handleProtocols: (set) => (set.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });

    const pendingCount = () => {
        let count = 0;
        for (const session of sessions) {
            if (session.phase === 'pending') {
                count += 1;
            }
        }
        return count;
    };

    const onRequest = (req, res) => {
        const pathname = pathOf(req);
        if (req.method === 'GET' && pathname === '/healthz') {
            sendJson(res, 200, {status: 'ok', service: 'vrroom-sync', protocol: PROTOCOL_VERSION});
            return;
        }
        if (req.method === 'GET' && pathname === '/v1/challenge') {
            const result = challenge(req);
            sendJson(res, result.status, result.body);
            return;
        }
        if (pathname.startsWith(ROUTE_PREFIX) && extensions.route(req, res)) {
            return;
        }
        sendJson(res, 404, {error: 'notfound'});
    };

    const onConnection = (ws) => {
        const session = new Session(ws, {
            config,
            rooms,
            log,
            now,
            onDone: (done, code) => {
                sessions.delete(done);
                const key = String(Number.isInteger(code) ? code : 1006);
                closes.set(key, (closes.get(key) || 0) + 1);
                log.debug('session_closed', {code: Number(key)});
            },
        });
        sessions.add(session);
    };

    const onUpgrade = (req, socket, head) => {
        socket.on('error', () => {
            // Broken connections are simply dropped.
        });
        if (closing) {
            refuseUpgrade(socket, 503, 'unavailable');
            return;
        }
        if (pathOf(req) !== SYNC_PATH) {
            refuseUpgrade(socket, 404, 'notfound');
            return;
        }
        if (!offeredProtocols(req.headers['sec-websocket-protocol']).includes(SUBPROTOCOL)) {
            refuseUpgrade(socket, 400, 'subprotocol');
            return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !config.origins.includes(origin)) {
            refuseUpgrade(socket, 403, 'origin');
            return;
        }
        if (wss.clients.size >= config.maxConnections || pendingCount() >= config.maxPending) {
            refuseUpgrade(socket, 503, 'busy');
            return;
        }
        wss.handleUpgrade(req, socket, head, onConnection);
    };

    const server = http.createServer(onRequest);
    server.on('upgrade', onUpgrade);
    server.on('clientError', (error, socket) => {
        if (socket.writable) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        } else {
            socket.destroy();
        }
    });

    const startTimers = () => {
        const every = (ms, fn) => {
            const handle = setInterval(fn, ms);
            handle.unref();
            intervals.push(handle);
        };
        every(Math.max(1, Math.round(1000 / config.poseHz)), () => rooms.tick(now()));
        every(timers.sweepMs, () => {
            const time = now();
            rooms.sweep(time);
            for (const session of [...sessions]) {
                session.checkDeadlines(time);
            }
        });
        every(timers.pingMs, () => {
            for (const session of [...sessions]) {
                session.heartbeat();
            }
        });
        every(timers.summaryMs, () => {
            const counts = rooms.counts();
            const fields = {rooms: counts.rooms, peers: counts.peers, away: counts.away, sessions: sessions.size};
            for (const [code, count] of closes) {
                fields['close_' + code] = count;
            }
            closes.clear();
            log.info('summary', fields);
        });
    };

    /**
     * Start listening.
     *
     * @param {{host?: string, port?: number}} [where] Overrides of config.listen (tests use port 0).
     * @returns {Promise<{address: string, port: number}>}
     */
    const listen = (where = {}) => new Promise((resolve, reject) => {
        const host = where.host || config.listen.host;
        const port = Number.isInteger(where.port) ? where.port : config.listen.port;
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.off('error', onError);
            startTimers();
            const address = server.address();
            log.info('listening', {port: address.port, version: SERVER_VERSION});
            resolve({address: address.address, port: address.port});
        });
    });

    /**
     * Graceful shutdown: every socket is closed with 1001 (clients reconnect), then the server stops.
     *
     * @returns {Promise<void>}
     */
    const close = () => {
        if (closing) {
            return Promise.resolve();
        }
        closing = true;
        for (const handle of intervals) {
            clearInterval(handle);
        }
        for (const session of [...sessions]) {
            session.shutdown();
        }
        return new Promise((resolve) => {
            const force = setTimeout(() => {
                for (const client of wss.clients) {
                    client.terminate();
                }
                server.closeAllConnections();
            }, SHUTDOWN_MS);
            force.unref();
            server.close(() => {
                wss.close(() => {
                    clearTimeout(force);
                    resolve();
                });
            });
            server.closeIdleConnections();
        });
    };

    const address = () => server.address();

    return {listen, close, address, rooms, sessions};
};

/**
 * Run as the main module: load the configuration and extensions, listen, stop on SIGTERM/SIGINT.
 */
const main = async () => {
    let config;
    try {
        config = loadConfig(process.env);
    } catch (error) {
        const variable = error instanceof ConfigError ? error.variable : 'unknown';
        createLog('error').error('config_error', {variable});
        process.exit(1);
    }
    const log = createLog(config.logLevel);
    const extensions = createExtensionHost(log);
    try {
        await extensions.load(config.extensions);
    } catch (error) {
        log.error('extension_error', {extension: error && error.extension ? error.extension : 'unknown', hook: 'load'});
        process.exit(1);
    }
    if (config.livekit.partial) {
        log.warn('livekit_admin_incomplete', {});
    }
    const app = createServer(config, {log, extensions});
    try {
        await app.listen();
    } catch (error) {
        log.error('listen_failed', {code: error && typeof error.code === 'string' ? error.code : 'unknown'});
        process.exit(1);
    }
    let stopping = false;
    const stop = (signal) => {
        if (stopping) {
            return;
        }
        stopping = true;
        log.info('shutdown', {reason: signal});
        setTimeout(() => process.exit(0), 5000).unref();
        app.close().then(() => process.exit(0), () => process.exit(0));
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
    process.on('uncaughtException', (error) => {
        log.error('fatal', {code: error && typeof error.code === 'string' ? error.code : 'exception'});
        process.exit(1);
    });
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    main();
}

