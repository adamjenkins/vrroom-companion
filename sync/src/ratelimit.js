// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: token-bucket rate limits (time injected, so tests control the clock).

/** Per-session limits (build contract §6.6): rate per second and burst. */
export const LIMITS = Object.freeze({
    all: Object.freeze({rate: 40, burst: 80}),
    pose: Object.freeze({rate: 20, burst: 20}),
    state: Object.freeze({rate: 4, burst: 8}),
    auth: Object.freeze({rate: 0.1, burst: 1}),
    ping: Object.freeze({rate: 1, burst: 2}),
});

/** Global challenge limit: 10 per minute, burst 10. */
export const CHALLENGE_LIMIT = Object.freeze({rate: 10 / 60, burst: 10});

/** Dropped frames (all-frames bucket) within ABUSE_WINDOW_MS that end the session. */
export const ABUSE_DROPS = 400;

/** Window for ABUSE_DROPS. */
export const ABUSE_WINDOW_MS = 10000;

/**
 * Create a token bucket that starts full.
 *
 * @param {number} rate Tokens added per second.
 * @param {number} burst Capacity.
 * @param {number} now Current time in ms.
 * @returns {{take: function(number): boolean}} take(now) removes one token, false when empty.
 */
export const createBucket = (rate, burst, now) => {
    let tokens = burst;
    let last = now;
    return {
        take(time) {
            const elapsed = Math.max(0, time - last) / 1000;
            last = Math.max(last, time);
            tokens = Math.min(burst, tokens + elapsed * rate);
            if (tokens >= 1) {
                tokens -= 1;
                return true;
            }
            return false;
        },
    };
};

/**
 * Count events in a sliding window.
 *
 * @param {number} limit More than this many events within the window means abuse.
 * @param {number} windowms Window length in ms.
 * @returns {{add: function(number): boolean}} add(now) records one event and returns true when
 *     more than `limit` events happened within the window.
 */
export const createAbuseCounter = (limit = ABUSE_DROPS, windowms = ABUSE_WINDOW_MS) => {
    const times = [];
    return {
        add(time) {
            times.push(time);
            while (times.length > 0 && times[0] <= time - windowms) {
                times.shift();
            }
            if (times.length > limit + 1) {
                times.splice(0, times.length - limit - 1);
            }
            return times.length > limit;
        },
    };
};

/**
 * The set of per-session buckets.
 *
 * @param {number} now Current time in ms.
 * @returns {{all: Object, pose: Object, state: Object, auth: Object, ping: Object}}
 */
export const createSessionLimits = (now) => {
    const buckets = {};
    for (const [name, limit] of Object.entries(LIMITS)) {
        buckets[name] = createBucket(limit.rate, limit.burst, now);
    }
    return buckets;
};
