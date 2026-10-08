// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: configuration from environment variables, validated at start.

import {isIP} from 'node:net';
import path from 'node:path';

/** Directory extension modules must live in (inside the container). */
export const EXTENSIONS_DIR = '/app/extensions';

/** Smallest shared-secret length (the Moodle setting has the same rule). */
export const MIN_SECRET_LENGTH = 32;

/**
 * A configuration error. The message and the `variable` property name the variable only, never
 * its value (it may be a secret).
 */
export class ConfigError extends Error {
    /**
     * @param {string} variable Name of the environment variable.
     */
    constructor(variable) {
        super(`Invalid value in ${variable}`);
        this.name = 'ConfigError';
        this.variable = variable;
    }
}

/**
 * Trimmed value of a variable, '' when unset.
 *
 * @param {Object} env
 * @param {string} name
 * @returns {string}
 */
const value = (env, name) => (typeof env[name] === 'string' ? env[name].trim() : '');

/**
 * Comma-separated list, empty items removed.
 *
 * @param {string} raw
 * @returns {string[]}
 */
const list = (raw) => raw.split(',').map((item) => item.trim()).filter((item) => item !== '');

/**
 * An integer variable with a default and bounds.
 *
 * @param {Object} env
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
const integer = (env, name, fallback, min, max) => {
    const raw = value(env, name);
    if (raw === '') {
        return fallback;
    }
    if (!/^\d{1,9}$/.test(raw)) {
        throw new ConfigError(name);
    }
    const number = Number(raw);
    if (number < min || number > max) {
        throw new ConfigError(name);
    }
    return number;
};

/**
 * Whether a string is a host name, an IPv4 or an IPv6 address.
 *
 * @param {string} host
 * @returns {boolean}
 */
const isHost = (host) => isIP(host) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/.test(host);

/**
 * Parse VRROOM_SYNC_LISTEN ('host:port', IPv6 in brackets).
 *
 * @param {string} raw
 * @returns {{host: string, port: number}}
 */
const parseListen = (raw) => {
    const name = 'VRROOM_SYNC_LISTEN';
    const colon = raw.lastIndexOf(':');
    if (colon <= 0) {
        throw new ConfigError(name);
    }
    let host = raw.slice(0, colon);
    const port = raw.slice(colon + 1);
    if (host.startsWith('[') && host.endsWith(']')) {
        host = host.slice(1, -1);
        if (isIP(host) !== 6) {
            throw new ConfigError(name);
        }
    } else if (host.includes(':') || !isHost(host)) {
        throw new ConfigError(name);
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
        throw new ConfigError(name);
    }
    return {host, port: Number(port)};
};

/**
 * Parse an http(s) URL without credentials, query or fragment.
 *
 * @param {string} raw
 * @param {string} name Variable name for the error.
 * @returns {URL}
 */
const parseHttpUrl = (raw, name) => {
    let url;
    try {
        url = new URL(raw);
    } catch (e) {
        throw new ConfigError(name);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' ||
            url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
            raw.includes('?') || raw.includes('#')) {
        throw new ConfigError(name);
    }
    return url;
};

/**
 * Remove trailing slashes.
 *
 * @param {string} text
 * @returns {string}
 */
export const stripSlashes = (text) => text.replace(/\/+$/, '');

/**
 * Parse VRROOM_SYNC_ISSUERS: the wwwroot of each Moodle site allowed to sign tokens.
 *
 * @param {string} raw
 * @returns {string[]}
 */
const parseIssuers = (raw) => {
    const name = 'VRROOM_SYNC_ISSUERS';
    const issuers = list(raw).map((item) => {
        const stripped = stripSlashes(item);
        parseHttpUrl(stripped, name);
        return stripped;
    });
    if (issuers.length === 0) {
        throw new ConfigError(name);
    }
    return [...new Set(issuers)];
};

/**
 * Parse VRROOM_SYNC_ORIGINS (or derive them from the issuers).
 *
 * @param {string} raw
 * @param {string[]} issuers
 * @returns {string[]}
 */
const parseOrigins = (raw, issuers) => {
    const name = 'VRROOM_SYNC_ORIGINS';
    if (raw === '') {
        return [...new Set(issuers.map((issuer) => new URL(issuer).origin))];
    }
    const origins = list(raw).map((item) => {
        const url = parseHttpUrl(stripSlashes(item), name);
        if (url.pathname !== '/') {
            throw new ConfigError(name);
        }
        return url.origin;
    });
    if (origins.length === 0) {
        throw new ConfigError(name);
    }
    return [...new Set(origins)];
};

/**
 * Parse VRROOM_SYNC_EXTENSIONS: absolute paths of .js/.mjs modules under EXTENSIONS_DIR.
 *
 * @param {string} raw
 * @returns {string[]}
 */
const parseExtensions = (raw) => list(raw).map((item) => {
    if (!path.isAbsolute(item) || path.normalize(item) !== item || !item.startsWith(EXTENSIONS_DIR + '/') ||
            !/\.m?js$/.test(item)) {
        throw new ConfigError('VRROOM_SYNC_EXTENSIONS');
    }
    return item;
});

/**
 * Deep-freeze a plain configuration object.
 *
 * @param {Object} object
 * @returns {Object}
 */
const deepFreeze = (object) => {
    for (const item of Object.values(object)) {
        if (item !== null && typeof item === 'object') {
            deepFreeze(item);
        }
    }
    return Object.freeze(object);
};

/**
 * Load and validate the configuration.
 *
 * @param {Object} env Environment (process.env by default; tests pass their own).
 * @returns {Object} A frozen configuration object.
 * @throws {ConfigError} Naming the first invalid variable.
 */
export const loadConfig = (env = process.env) => {
    const listenraw = value(env, 'VRROOM_SYNC_LISTEN');
    const listen = parseListen(listenraw === '' ? '127.0.0.1:8090' : listenraw);

    const secret = value(env, 'VRROOM_SYNC_SECRET');
    if (secret.length < MIN_SECRET_LENGTH || /\s/.test(secret)) {
        throw new ConfigError('VRROOM_SYNC_SECRET');
    }

    const issuers = parseIssuers(value(env, 'VRROOM_SYNC_ISSUERS'));
    const origins = parseOrigins(value(env, 'VRROOM_SYNC_ORIGINS'), issuers);

    const logLevel = value(env, 'VRROOM_SYNC_LOG_LEVEL') || 'info';
    if (!['error', 'warn', 'info', 'debug'].includes(logLevel)) {
        throw new ConfigError('VRROOM_SYNC_LOG_LEVEL');
    }

    const livekiturl = value(env, 'LIVEKIT_API_URL');
    const livekitkey = value(env, 'LIVEKIT_API_KEY');
    const livekitsecret = value(env, 'LIVEKIT_API_SECRET');
    if (livekiturl !== '') {
        parseHttpUrl(stripSlashes(livekiturl), 'LIVEKIT_API_URL');
    }
    if (/\s/.test(livekitkey)) {
        throw new ConfigError('LIVEKIT_API_KEY');
    }
    if (/\s/.test(livekitsecret)) {
        throw new ConfigError('LIVEKIT_API_SECRET');
    }
    const livekitset = [livekiturl, livekitkey, livekitsecret].filter((item) => item !== '').length;

    return deepFreeze({
        listen,
        secret,
        issuers,
        origins,
        maxRoomPeers: integer(env, 'VRROOM_SYNC_MAX_ROOM_PEERS', 50, 2, 100),
        maxRooms: integer(env, 'VRROOM_SYNC_MAX_ROOMS', 1000, 1, 1000000),
        maxConnections: integer(env, 'VRROOM_SYNC_MAX_CONNECTIONS', 2000, 1, 1000000),
        maxPending: integer(env, 'VRROOM_SYNC_MAX_PENDING', 200, 1, 1000000),
        poseHz: integer(env, 'VRROOM_SYNC_POSE_HZ', 15, 1, 30),
        graceSeconds: integer(env, 'VRROOM_SYNC_GRACE_SECONDS', 10, 0, 60),
        logLevel,
        extensions: parseExtensions(value(env, 'VRROOM_SYNC_EXTENSIONS')),
        livekit: {
            url: stripSlashes(livekiturl),
            key: livekitkey,
            secret: livekitsecret,
            enabled: livekitset === 3,
            partial: livekitset > 0 && livekitset < 3,
        },
    });
};
