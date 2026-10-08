// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync: the admin challenge (GET /v1/challenge) proving that this service holds the shared secret.

import {createHmac} from 'node:crypto';
import {verify} from './jwt.js';
import {PROTOCOL_VERSION, SERVER_VERSION} from './protocol.js';
import {CHALLENGE_LIMIT, createBucket} from './ratelimit.js';

/** First line of the MAC input; versioned so that the format can change safely. */
export const CHALLENGE_PREFIX = 'mavr-sync/challenge/1';

/** Bearer token shape. */
const BEARER = /^Bearer ([A-Za-z0-9._-]{1,3000})$/;

/**
 * The challenge MAC: hex HMAC-SHA256(secret, prefix \n nonce \n iss \n ts). Moodle recomputes it
 * with hash_hmac('sha256', …) and compares with hash_equals.
 *
 * @param {string} secret
 * @param {string} nonce
 * @param {string} iss
 * @param {number} ts
 * @returns {string}
 */
export const challengeMac = (secret, nonce, iss, ts) =>
    createHmac('sha256', secret).update(`${CHALLENGE_PREFIX}\n${nonce}\n${iss}\n${ts}`, 'utf8').digest('hex');

/**
 * Create the challenge handler.
 *
 * @param {{secret: string, issuers: string[]}} config
 * @param {{now?: function(): number, livekitadmin?: boolean}} options now in ms.
 * @returns {function(Object): {status: number, body: Object}} Takes the HTTP request.
 */
export const createChallengeHandler = (config, options = {}) => {
    const now = options.now || Date.now;
    const livekitadmin = !!options.livekitadmin;
    const bucket = createBucket(CHALLENGE_LIMIT.rate, CHALLENGE_LIMIT.burst, now());
    return (req) => {
        const time = now();
        if (!bucket.take(time)) {
            return {status: 429, body: {error: 'ratelimited'}};
        }
        const header = req && req.headers ? req.headers.authorization : undefined;
        const match = typeof header === 'string' ? BEARER.exec(header) : null;
        if (!match) {
            return {status: 401, body: {error: 'unauthorised'}};
        }
        const seconds = Math.floor(time / 1000);
        const result = verify(match[1], config.secret, {purpose: 'test', issuers: config.issuers, now: seconds});
        if (!result.ok) {
            return result.code === 4403 ?
                {status: 403, body: {error: 'forbidden'}} :
                {status: 401, body: {error: 'unauthorised'}};
        }
        const {nonce, iss} = result.claims;
        return {
            status: 200,
            body: {
                service: 'mavr-sync',
                protocol: PROTOCOL_VERSION,
                version: SERVER_VERSION,
                nonce,
                ts: seconds,
                livekitadmin,
                mac: challengeMac(config.secret, nonce, iss, seconds),
            },
        };
    };
};
