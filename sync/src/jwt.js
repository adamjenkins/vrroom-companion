// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync: HS256 JSON Web Tokens (sign and verify) with node:crypto only.

import {createHmac, timingSafeEqual} from 'node:crypto';
import {stripSlashes} from './config.js';

/** Expected audience. */
export const AUDIENCE = 'mavr-sync';

/** Token format version. */
export const TOKEN_VERSION = 1;

/** Largest token accepted, in characters. */
export const MAX_TOKEN_LENGTH = 3000;

/** Clock leeway for nbf and iat, in seconds. */
export const LEEWAY = 30;

/** Largest lifetime (exp - iat) per purpose, in seconds. */
export const MAX_LIFETIME = Object.freeze({join: 300, test: 60});

/** Close codes used as results (the same numbers as the wire protocol). */
const UNAUTHORISED = 4401;
const FORBIDDEN = 4403;

/** One base64url part. */
const PART = /^[A-Za-z0-9_-]+$/;

/** Peer id, room id and challenge nonce shapes. */
const PEER_ID = /^[0-9a-f]{32}$/;
const ROOM_ID = /^r[0-9a-f]{32}$/;
const NONCE = /^[0-9a-f]{32}$/;

/**
 * Base64url of a JSON value.
 *
 * @param {*} value
 * @returns {string}
 */
const encodePart = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * Parse a base64url JSON part into a plain object, or null.
 *
 * @param {string} part
 * @returns {Object|null}
 */
const decodePart = (part) => {
    try {
        const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (e) {
        return null;
    }
};

/**
 * HMAC-SHA256 of the signing input.
 *
 * @param {string} input header.payload
 * @param {string} secret
 * @returns {Buffer}
 */
const mac = (input, secret) => createHmac('sha256', secret).update(input, 'utf8').digest();

/**
 * Sign a payload (header {"typ":"JWT","alg":"HS256"}, as Firebase php-jwt writes it).
 *
 * @param {Object} payload
 * @param {string} secret
 * @returns {string}
 */
export const sign = (payload, secret) => {
    const input = encodePart({typ: 'JWT', alg: 'HS256'}) + '.' + encodePart(payload);
    return input + '.' + mac(input, secret).toString('base64url');
};

/**
 * Whether a value is an integer number of seconds.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isSeconds = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Whether a display name is acceptable: 1..100 code points, no control characters below U+0020.
 *
 * @param {*} name
 * @returns {boolean}
 */
const isName = (name) => {
    if (typeof name !== 'string') {
        return false;
    }
    const points = [...name];
    if (points.length < 1 || points.length > 100) {
        return false;
    }
    return points.every((point) => point.codePointAt(0) >= 0x20);
};

/**
 * Verify a token. The checks run in the order of the build contract §3.2; the first failure
 * decides. Never throws.
 *
 * @param {*} token
 * @param {string} secret
 * @param {{purpose: string, issuers: string[], now: number, maxLifetime?: number}} options
 *     purpose 'join' or 'test'; now in unix seconds.
 * @returns {{ok: true, claims: Object}|{ok: false, code: number}}
 */
export const verify = (token, secret, {purpose, issuers, now, maxLifetime}) => {
    const fail = (code) => ({ok: false, code});
    try {
        // 1. Shape.
        if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
            return fail(UNAUTHORISED);
        }
        const parts = token.split('.');
        if (parts.length !== 3 || !parts.every((part) => PART.test(part))) {
            return fail(UNAUTHORISED);
        }
        // 2. Header.
        const header = decodePart(parts[0]);
        if (!header || header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT') ||
                Object.hasOwn(header, 'crit')) {
            return fail(UNAUTHORISED);
        }
        // 3. Signature.
        const expected = mac(parts[0] + '.' + parts[1], secret);
        const given = Buffer.from(parts[2], 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected) ||
                given.toString('base64url') !== parts[2]) {
            return fail(UNAUTHORISED);
        }
        // 4. Issuer.
        const claims = decodePart(parts[1]);
        if (!claims || typeof claims.iss !== 'string') {
            return fail(UNAUTHORISED);
        }
        const iss = stripSlashes(claims.iss);
        if (!issuers.includes(iss)) {
            return fail(FORBIDDEN);
        }
        // 5. Audience, purpose, version.
        const audok = claims.aud === AUDIENCE || (Array.isArray(claims.aud) && claims.aud.includes(AUDIENCE));
        if (!audok || typeof purpose !== 'string' || claims.mavr !== purpose || claims.v !== TOKEN_VERSION) {
            return fail(UNAUTHORISED);
        }
        // 6. Purpose-specific claims.
        const result = {iss, iat: claims.iat, nbf: claims.nbf, exp: claims.exp};
        if (purpose === 'join') {
            if (typeof claims.sub !== 'string' || !PEER_ID.test(claims.sub) ||
                    typeof claims.room !== 'string' || !ROOM_ID.test(claims.room) ||
                    !isName(claims.name) || (claims.kind !== 'attempt' && claims.kind !== 'preview') ||
                    !Number.isInteger(claims.max) || claims.max < 2 || claims.max > 100) {
                return fail(UNAUTHORISED);
            }
            Object.assign(result, {sub: claims.sub, room: claims.room, name: claims.name, kind: claims.kind,
                max: claims.max});
        } else if (purpose === 'test') {
            if (typeof claims.nonce !== 'string' || !NONCE.test(claims.nonce)) {
                return fail(UNAUTHORISED);
            }
            result.nonce = claims.nonce;
        } else {
            return fail(UNAUTHORISED);
        }
        // 7. Times.
        const lifetime = Number.isInteger(maxLifetime) ? maxLifetime : MAX_LIFETIME[purpose];
        if (!isSeconds(claims.iat) || !isSeconds(claims.nbf) || !isSeconds(claims.exp) ||
                !Number.isFinite(now) || claims.nbf > now + LEEWAY || claims.iat > now + LEEWAY ||
                claims.exp <= now || claims.exp - claims.iat > lifetime) {
            return fail(UNAUTHORISED);
        }
        return {ok: true, claims: Object.freeze(result)};
    } catch (e) {
        return fail(UNAUTHORISED);
    }
};
