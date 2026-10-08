// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync tests: GET /v1/challenge — the MAC Moodle recomputes, refusals and the rate limit.

import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {after, before, describe, test} from 'node:test';
import {CHALLENGE_PREFIX, challengeMac, createChallengeHandler} from '../src/challenge.js';
import {ISSUER, SECRET, makeTestToken, makeToken, seconds, startServer} from './helpers.js';

/**
 * Recompute the MAC the way Moodle does (hash_hmac('sha256', …)).
 *
 * @param {string} nonce
 * @param {string} iss
 * @param {number} ts
 * @returns {string}
 */
const moodleMac = (nonce, iss, ts) =>
    createHmac('sha256', SECRET).update('mavr-sync/challenge/1\n' + nonce + '\n' + iss + '\n' + ts).digest('hex');

describe('challenge over HTTP', () => {
    let server;
    before(async () => {
        server = await startServer();
    });
    after(() => server.close());

    /**
     * GET /v1/challenge.
     *
     * @param {string|null} token
     * @returns {Promise<{status: number, body: Object, headers: Headers}>}
     */
    const ask = async (token) => {
        const response = await fetch(server.http + '/v1/challenge', {
            headers: token === null ? {} : {Authorization: 'Bearer ' + token},
        });
        return {status: response.status, body: await response.json(), headers: response.headers};
    };

    test('a valid test token gets a MAC Moodle can recompute', async () => {
        const nonce = '0123456789abcdef0123456789abcdef';
        const start = seconds();
        const {status, body, headers} = await ask(makeTestToken({nonce}));
        assert.equal(status, 200);
        assert.equal(headers.get('cache-control'), 'no-store');
        assert.equal(body.service, 'mavr-sync');
        assert.equal(body.protocol, 1);
        assert.equal(body.version, '0.1.0');
        assert.equal(body.nonce, nonce);
        assert.equal(body.livekitadmin, false);
        assert.ok(body.ts >= start && body.ts <= seconds());
        assert.match(body.mac, /^[0-9a-f]{64}$/);
        assert.equal(body.mac, moodleMac(nonce, ISSUER, body.ts));
        assert.deepEqual(Object.keys(body).sort(), ['livekitadmin', 'mac', 'nonce', 'protocol', 'service', 'ts', 'version']);
    });

    test('the MAC uses the issuer without its trailing slash', async () => {
        const nonce = 'fedcba9876543210fedcba9876543210';
        const {body} = await ask(makeTestToken({nonce, iss: ISSUER + '/'}));
        assert.equal(body.mac, moodleMac(nonce, ISSUER, body.ts));
    });

    test('no token, an unsigned, expired or join-purpose token gets 401', async () => {
        const now = seconds();
        for (const token of [
            null,
            makeTestToken({}, {secret: 'not-the-shared-secret-0123456789abcdef'}),
            makeTestToken({iat: now - 120, nbf: now - 120, exp: now - 60}),
            makeToken(),
        ]) {
            const {status, body} = await ask(token);
            assert.equal(status, 401);
            assert.deepEqual(body, {error: 'unauthorised'});
        }
    });

    test('an issuer that is not allowed gets 403', async () => {
        const {status, body} = await ask(makeTestToken({iss: 'https://other.example.org'}));
        assert.equal(status, 403);
        assert.deepEqual(body, {error: 'forbidden'});
    });

    test('more than 10 challenges a minute get 429', async () => {
        // The earlier tests in this block used 7 of the 10.
        const statuses = [];
        for (let i = 0; i < 5; i++) {
            statuses.push((await ask(makeTestToken())).status);
        }
        assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
        const {body} = await ask(makeTestToken());
        assert.deepEqual(body, {error: 'ratelimited'});
    });
});

test('challengeMac matches an independent HMAC and depends on every input', () => {
    const mac = challengeMac(SECRET, 'a'.repeat(32), ISSUER, 1760000000);
    assert.equal(CHALLENGE_PREFIX, 'mavr-sync/challenge/1');
    assert.equal(mac, moodleMac('a'.repeat(32), ISSUER, 1760000000));
    assert.notEqual(mac, challengeMac(SECRET, 'b'.repeat(32), ISSUER, 1760000000));
    assert.notEqual(mac, challengeMac(SECRET, 'a'.repeat(32), ISSUER + '/x', 1760000000));
    assert.notEqual(mac, challengeMac(SECRET, 'a'.repeat(32), ISSUER, 1760000001));
    assert.notEqual(mac, challengeMac('another-secret-0123456789abcdef01234567', 'a'.repeat(32), ISSUER, 1760000000));
});

test('the handler reports livekitadmin and refuses a malformed Authorization header', () => {
    const handler = createChallengeHandler({secret: SECRET, issuers: [ISSUER]}, {livekitadmin: true});
    const ok = handler({headers: {authorization: 'Bearer ' + makeTestToken()}});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.livekitadmin, true);
    assert.equal(handler({headers: {authorization: 'Basic abc'}}).status, 401);
    assert.equal(handler({headers: {authorization: 'Bearer a b'}}).status, 401);
});
