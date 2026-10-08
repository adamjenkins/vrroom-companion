// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: JSON-lines logger that drops anything that could be personal data.

/**
 * Log levels, most severe first.
 */
export const LEVELS = Object.freeze({error: 0, warn: 1, info: 2, debug: 3});

/**
 * The only field names that may carry a string value. Everything else must be a number or a
 * boolean. Names, peer ids, room ids, tokens, IP addresses and message contents are never logged:
 * the logger enforces this itself as a defence against accidental personal data.
 */
export const STRING_FIELDS = Object.freeze(['code', 'reason', 'hook', 'extension', 'variable', 'status', 'version']);

/** Field and event names. */
const NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** Allowed string values (identifiers, version numbers, signal names). */
const SAFE_STRING = /^[A-Za-z0-9._:-]{0,64}$/;

/** Keys the logger sets itself. */
const RESERVED = new Set(['ts', 'level', 'event']);

/**
 * Keep only the fields that are allowed in a log line.
 *
 * @param {*} fields
 * @returns {Object}
 */
export const cleanFields = (fields) => {
    const clean = {};
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        return clean;
    }
    for (const [key, value] of Object.entries(fields)) {
        if (!NAME.test(key) || RESERVED.has(key)) {
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            clean[key] = value;
        } else if (typeof value === 'boolean') {
            clean[key] = value;
        } else if (typeof value === 'string' && STRING_FIELDS.includes(key) && SAFE_STRING.test(value)) {
            clean[key] = value;
        }
    }
    return clean;
};

/**
 * Create a logger.
 *
 * @param {string} level One of the LEVELS names; unknown names mean 'info'.
 * @param {function(string): void} write Receives one JSON line (without the newline).
 * @returns {{error: Function, warn: Function, info: Function, debug: Function}} Each takes
 *     (event, fields).
 */
export const createLog = (level = 'info', write = (line) => process.stdout.write(line + '\n')) => {
    const max = Object.hasOwn(LEVELS, level) ? LEVELS[level] : LEVELS.info;
    const emitter = (name) => (event, fields) => {
        if (LEVELS[name] > max) {
            return;
        }
        const line = Object.assign({
            ts: new Date().toISOString(),
            level: name,
            event: typeof event === 'string' && NAME.test(event) ? event : 'invalid_event',
        }, cleanFields(fields));
        try {
            write(JSON.stringify(line));
        } catch (e) {
            // Logging must never break the service.
        }
    };
    return Object.freeze({
        error: emitter('error'),
        warn: emitter('warn'),
        info: emitter('info'),
        debug: emitter('debug'),
    });
};
