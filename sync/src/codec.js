// Copied verbatim from moodle-mod_mavr runtime/builtin/amd/src/live/codec.js (2026-10-08).
// Keep both copies identical: mavr-sync relays only what the Phase 3 decoder accepts.
// SPDX-License-Identifier: GPL-3.0-or-later
// This file is part of Moodle - https://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Encoder and validator of live-room data-channel messages.
 *
 * pose  {t: 'p', q, ts, sc, m, h, l, r}: q sequence 0..2^31-1, ts sender clock in ms, sc scene id,
 *       m '3d'|'vr'|'mr'|'ar', h head and l/r hands (or null) as [x, y, z, qx, qy, qz, qw] in
 *       room coordinates; positions |v| <= 1000 with 3 decimals, quaternion components in
 *       [-1.01, 1.01] with 4 decimals, normalised on decode. At most 1024 bytes.
 * state {t: 's', m: '3d'|'vr'|'mr'|'ar'|'list', sc: scene id or '', mic: 'off'|'on'|'muted'}.
 *       At most 512 bytes.
 *
 * Anything else encodes and decodes to null. Messages come from other people's browsers: decode
 * rebuilds every message from known keys only.
 *
 * Dependency-free ES module (no imports) so that both grunt (AMD build) and node --test load it.
 *
 * @module     mavrruntime_builtin/live/codec
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Size limits in bytes and the coordinate bound in metres. */
export const LIMITS = Object.freeze({pose: 1024, state: 512, maxcoord: 1000});

/** Largest sequence number. */
const MAX_SEQ = 2147483647;

/** Largest absolute quaternion component accepted before normalisation. */
const MAX_QUAT = 1.01;

/** Pose modes. */
const POSE_MODES = Object.freeze(['3d', 'vr', 'mr', 'ar']);

/** State modes. */
const STATE_MODES = Object.freeze(['3d', 'vr', 'mr', 'ar', 'list']);

/** Microphone states. */
const MIC_STATES = Object.freeze(['off', 'on', 'muted']);

/**
 * Whether a value is a finite number.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isNumber = (value) => typeof value === 'number' && isFinite(value);

/**
 * Whether a value is a plain (non-array) object.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Round to a number of decimals; never returns -0.
 *
 * @param {number} value
 * @param {number} factor 10 to the power of the decimals.
 * @returns {number}
 */
const round = (value, factor) => {
    const rounded = Math.round(value * factor) / factor;
    return rounded === 0 ? 0 : rounded;
};

/**
 * UTF-8 byte length of a string.
 *
 * @param {string} text
 * @returns {number}
 */
const byteLength = (text) => {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
};

/**
 * Whether a value is a scene id: 1..36 characters of [A-Za-z0-9_-] (the id rule of
 * mod_mavr's scene_validator::ID_PATTERN, capped at its MAX_SCENE_ID_LENGTH of 36).
 *
 * @param {*} value
 * @returns {boolean}
 */
export const isSceneId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(value);

/**
 * Normalise a quaternion [x, y, z, w].
 *
 * @param {*} q
 * @returns {number[]|null} The unit quaternion, or null for anything that is not four finite
 *     numbers with a non-zero length.
 */
export const normaliseQuat = (q) => {
    if (!Array.isArray(q) || q.length !== 4 || !q.every(isNumber)) {
        return null;
    }
    const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (!isFinite(length) || length < 1e-6) {
        return null;
    }
    return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};

/**
 * Check and normalise a [x, y, z, qx, qy, qz, qw] pose array.
 *
 * @param {*} value
 * @returns {number[]|null} Position unchanged, quaternion normalised; null when invalid.
 */
const checkPose = (value) => {
    if (!Array.isArray(value) || value.length !== 7 || !value.every(isNumber)) {
        return null;
    }
    for (let i = 0; i < 3; i++) {
        if (Math.abs(value[i]) > LIMITS.maxcoord) {
            return null;
        }
    }
    for (let i = 3; i < 7; i++) {
        if (Math.abs(value[i]) > MAX_QUAT) {
            return null;
        }
    }
    const quat = normaliseQuat(value.slice(3, 7));
    if (!quat) {
        return null;
    }
    return [value[0], value[1], value[2], quat[0], quat[1], quat[2], quat[3]];
};

/**
 * Check an optional hand pose: null/undefined stays null, anything else must be a valid pose.
 *
 * @param {*} value
 * @returns {{ok: boolean, pose: (number[]|null)}}
 */
const checkHand = (value) => {
    if (value === null || value === undefined) {
        return {ok: true, pose: null};
    }
    const pose = checkPose(value);
    return {ok: pose !== null, pose: pose};
};

/**
 * Round a checked pose for the wire.
 *
 * @param {number[]|null} pose
 * @returns {number[]|null}
 */
const roundPose = (pose) => {
    if (!pose) {
        return null;
    }
    return pose.map((v, i) => round(v, i < 3 ? 1000 : 10000));
};

/**
 * Validate a pose message and rebuild it from its known keys.
 *
 * @param {*} message
 * @returns {Object|null}
 */
const buildPose = (message) => {
    if (!isObject(message) || message.t !== 'p') {
        return null;
    }
    if (!Number.isInteger(message.q) || message.q < 0 || message.q > MAX_SEQ) {
        return null;
    }
    if (!Number.isInteger(message.ts) || message.ts < 0 || message.ts > Number.MAX_SAFE_INTEGER) {
        return null;
    }
    if (!isSceneId(message.sc) || POSE_MODES.indexOf(message.m) === -1) {
        return null;
    }
    const head = checkPose(message.h);
    const left = checkHand(message.l);
    const right = checkHand(message.r);
    if (!head || !left.ok || !right.ok) {
        return null;
    }
    return {t: 'p', q: message.q, ts: message.ts, sc: message.sc, m: message.m, h: head, l: left.pose, r: right.pose};
};

/**
 * Validate a state message and rebuild it from its known keys.
 *
 * @param {*} message
 * @returns {Object|null}
 */
const buildState = (message) => {
    if (!isObject(message) || message.t !== 's') {
        return null;
    }
    if (STATE_MODES.indexOf(message.m) === -1 || MIC_STATES.indexOf(message.mic) === -1) {
        return null;
    }
    if (message.sc !== '' && !isSceneId(message.sc)) {
        return null;
    }
    return {t: 's', m: message.m, sc: message.sc, mic: message.mic};
};

/**
 * Encode a message for a channel.
 *
 * @param {string} channel 'pose' or 'state'.
 * @param {Object} message The message (see the module description).
 * @returns {string|null} JSON, or null when the message breaks the rules or is too large.
 */
export const encode = (channel, message) => {
    let built = null;
    if (channel === 'pose') {
        built = buildPose(message);
        if (built) {
            built.h = roundPose(built.h);
            built.l = roundPose(built.l);
            built.r = roundPose(built.r);
        }
    } else if (channel === 'state') {
        built = buildState(message);
    }
    if (!built) {
        return null;
    }
    const text = JSON.stringify(built);
    return byteLength(text) <= LIMITS[channel] ? text : null;
};

/**
 * Decode a message received on a channel.
 *
 * @param {string} channel 'pose' or 'state'.
 * @param {*} data The received data (a string).
 * @returns {Object|null} The rebuilt message (quaternions normalised), or null when invalid or
 *     too large.
 */
export const decode = (channel, data) => {
    if (channel !== 'pose' && channel !== 'state') {
        return null;
    }
    if (typeof data !== 'string' || data.length > LIMITS[channel] || byteLength(data) > LIMITS[channel]) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(data);
    } catch (e) {
        return null;
    }
    return channel === 'pose' ? buildPose(parsed) : buildState(parsed);
};
