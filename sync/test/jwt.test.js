// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync tests: HS256 sign/verify and every claim rule of build contract §3.2.

import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {test} from 'node:test';
import {sign, verify} from '../src/jwt.js';
import {ISSUER, SECRET, makeClaims, makeTestToken, makeToken, seconds} from './helpers.js';

const NOW = seconds();
const JOIN = {purpose: 'join', issuers: [ISSUER], now: NOW};

/**
 * Build a token with an arbitrary header (signed correctly).
 *
 * @param {Object} header
 * @param {Object} payload
 * @param {string} secret
 * @returns {string}
 */
const raw = (header, payload, secret = SECRET) => {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = part(header) + '.' + part(payload);
    return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
};

test('a signed token verifies and returns the claims', () => {
    const token = makeToken({}, {now: NOW});
    const result = verify(token, SECRET, JOIN);
    assert.equal(result.ok, true);
    assert.equal(result.claims.iss, ISSUER);
    assert.equal(result.claims.sub, makeClaims().sub);
    assert.equal(result.claims.room, makeClaims().room);
    assert.equal(result.claims.name, 'Sam Student');
    assert.equal(result.claims.kind, 'attempt');
    assert.equal(result.claims.max, 50);
    assert.equal(result.claims.exp, NOW + 300);
    assert.ok(Object.isFrozen(result.claims));
});

test('the header is exactly what Firebase php-jwt writes', () => {
    const token = sign({a: 1}, SECRET);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.deepEqual(header, {typ: 'JWT', alg: 'HS256'});
    assert.deepEqual(Object.keys(header), ['typ', 'alg']);
});

test('a trailing slash on the issuer is ignored', () => {
    const result = verify(makeToken({iss: ISSUER + '/'}, {now: NOW}), SECRET, JOIN);
    assert.equal(result.ok, true);
    assert.equal(result.claims.iss, ISSUER);
});

test('alg none, HS512 and crit are refused', () => {
    const claims = makeClaims({}, NOW);
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const none = part({typ: 'JWT', alg: 'none'}) + '.' + part(claims) + '.x';
    assert.deepEqual(verify(none, SECRET, JOIN), {ok: false, code: 4401});
    assert.deepEqual(verify(raw({typ: 'JWT', alg: 'HS512'}, claims), SECRET, JOIN), {ok: false, code: 4401});
    assert.deepEqual(verify(raw({typ: 'JWT', alg: 'HS256', crit: ['x']}, claims), SECRET, JOIN), {ok: false, code: 4401});
    assert.deepEqual(verify(raw({typ: 'JOSE', alg: 'HS256'}, claims), SECRET, JOIN), {ok: false, code: 4401});
    assert.equal(verify(raw({alg: 'HS256'}, claims), SECRET, JOIN).ok, true);
});

test('a tampered payload or signature, a wrong secret and junk are refused', () => {
    const token = makeToken({}, {now: NOW});
    const [header, payload, signature] = token.split('.');
    const other = Buffer.from(JSON.stringify(makeClaims({name: 'Mallory'}, NOW))).toString('base64url');
    assert.equal(verify(`${header}.${other}.${signature}`, SECRET, JOIN).code, 4401);
    const flipped = signature.slice(0, -2) + (signature.slice(-2) === 'AA' ? 'BB' : 'AA');
    assert.equal(verify(`${header}.${payload}.${flipped}`, SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({}, {now: NOW, secret: 'another-secret-0123456789abcdef0123456789'}), SECRET, JOIN).code, 4401);
    for (const junk of [undefined, null, 42, '', 'a.b', 'a.b.c.d', 'a.b.c', `${header}.${payload}.`, 'x'.repeat(3001)]) {
        assert.equal(verify(junk, SECRET, JOIN).code, 4401);
    }
});

test('an issuer that is not allowed gets 4403', () => {
    assert.deepEqual(verify(makeToken({iss: 'https://other.example.org'}, {now: NOW}), SECRET, JOIN), {ok: false, code: 4403});
});

test('wrong audience, purpose or version is refused', () => {
    for (const overrides of [{aud: 'other'}, {aud: ['x', 'y']}, {vrroom: 'test'}, {vrroom: 'observe'}, {vrroom: undefined}, {v: 2}, {v: '1'}]) {
        assert.equal(verify(makeToken(overrides, {now: NOW}), SECRET, JOIN).code, 4401, JSON.stringify(overrides));
    }
    assert.equal(verify(makeToken({aud: ['x', 'vrroom-sync']}, {now: NOW}), SECRET, JOIN).ok, true);
});

test('times: expired, future nbf/iat beyond the leeway, lifetime over 300 s', () => {
    assert.equal(verify(makeToken({exp: NOW}, {now: NOW}), SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({exp: NOW - 1}, {now: NOW}), SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({nbf: NOW + 31}, {now: NOW}), SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({nbf: NOW + 30}, {now: NOW}), SECRET, JOIN).ok, true);
    assert.equal(verify(makeToken({iat: NOW + 31, exp: NOW + 320}, {now: NOW}), SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({exp: NOW + 301}, {now: NOW}), SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({exp: NOW + 300}, {now: NOW}), SECRET, JOIN).ok, true);
    assert.equal(verify(makeToken({iat: 1.5}, {now: NOW}), SECRET, JOIN).code, 4401);
    assert.equal(verify(makeToken({exp: String(NOW + 10)}, {now: NOW}), SECRET, JOIN).code, 4401);
});

test('bad sub, room, name, kind and max are refused', () => {
    const bad = [
        {sub: 'ABCDEF0123456789ABCDEF0123456789'},
        {sub: '123'},
        {sub: 5},
        {room: '0123456789abcdef0123456789abcdef'},
        {room: 'rXYZ'},
        {name: ''},
        {name: 'x'.repeat(101)},
        {name: 'Line\nbreak'},
        {name: 'Tab\there'},
        {name: 7},
        {kind: 'teacher'},
        {max: 1},
        {max: 101},
        {max: 2.5},
        {max: '50'},
    ];
    for (const overrides of bad) {
        assert.equal(verify(makeToken(overrides, {now: NOW}), SECRET, JOIN).code, 4401, JSON.stringify(overrides));
    }
    // 100 code points (astral characters count once) are fine.
    assert.equal(verify(makeToken({name: '\u{1F600}'.repeat(100)}, {now: NOW}), SECRET, JOIN).ok, true);
    assert.equal(verify(makeToken({kind: 'preview', max: 2}, {now: NOW}), SECRET, JOIN).ok, true);
});

test('test purpose: nonce required, lifetime at most 60 s, join tokens refused', () => {
    const TEST = {purpose: 'test', issuers: [ISSUER], now: NOW};
    const ok = verify(makeTestToken({}, {now: NOW}), SECRET, TEST);
    assert.equal(ok.ok, true);
    assert.equal(ok.claims.nonce, 'abcdef0123456789abcdef0123456789');
    assert.equal(verify(makeTestToken({nonce: 'short'}, {now: NOW}), SECRET, TEST).code, 4401);
    assert.equal(verify(makeTestToken({exp: NOW + 61}, {now: NOW}), SECRET, TEST).code, 4401);
    assert.equal(verify(makeToken({}, {now: NOW}), SECRET, TEST).code, 4401);
    assert.equal(verify(makeTestToken({}, {now: NOW}), SECRET, JOIN).code, 4401);
});

test('an unknown purpose option is refused even when the claim matches', () => {
    assert.equal(verify(makeToken({vrroom: 'observe'}, {now: NOW}), SECRET, {purpose: 'observe', issuers: [ISSUER], now: NOW}).code, 4401);
});
