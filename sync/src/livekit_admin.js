// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2024 LiveKit, Inc.
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: optional removal of a participant from the LiveKit room when they leave the sync room.
//
// The Twirp request (POST /twirp/livekit.RoomService/RemoveParticipant, JSON body {room, identity})
// and the admin grant {roomAdmin: true, room} mirror livekit-server-sdk 2.19.1
// (src/RoomServiceClient.ts, src/TwirpRPC.ts, src/ServiceBase.ts; Apache-2.0). No LiveKit code is
// copied: the request is built with fetch and our own HS256 signer.

import {sign} from './jwt.js';

/** Twirp path of RoomService.RemoveParticipant. */
export const REMOVE_PATH = '/twirp/livekit.RoomService/RemoveParticipant';

/** Lifetime of the admin token, in seconds. */
export const ADMIN_TOKEN_TTL = 60;

/** Request timeout, in ms. */
export const TIMEOUT_MS = 3000;

/**
 * Create the LiveKit admin client.
 *
 * @param {{url?: string, key?: string, secret?: string}} settings LiveKit API URL (http(s), no
 *     trailing slash), API key and API secret. Disabled unless all three are set.
 * @param {{fetch?: Function, now?: function(): number, log?: Object}} options now in ms.
 * @returns {{enabled: boolean, removeParticipant: function(string, string): Promise<void>}}
 */
export const createLiveKitAdmin = (settings = {}, options = {}) => {
    const url = typeof settings.url === 'string' ? settings.url.replace(/\/+$/, '') : '';
    const key = typeof settings.key === 'string' ? settings.key : '';
    const secret = typeof settings.secret === 'string' ? settings.secret : '';
    const enabled = url !== '' && key !== '' && secret !== '';
    const doFetch = options.fetch || globalThis.fetch;
    const now = options.now || Date.now;
    const log = options.log || null;

    /**
     * Remove a participant from a LiveKit room. Never rejects; failures are logged with the HTTP
     * status only.
     *
     * @param {string} room LiveKit room name (the sync room id).
     * @param {string} identity Participant identity (the peer id).
     * @returns {Promise<void>}
     */
    const removeParticipant = async (room, identity) => {
        if (!enabled) {
            return;
        }
        const nbf = Math.floor(now() / 1000);
        const token = sign({iss: key, nbf, exp: nbf + ADMIN_TOKEN_TTL, video: {roomAdmin: true, room}}, secret);
        try {
            const response = await doFetch(url + REMOVE_PATH, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({room, identity}),
                redirect: 'error',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            try {
                await response.arrayBuffer();
            } catch (e) {
                // The body is not needed.
            }
            if (!response.ok && log) {
                // 404: the person was not (or no longer) in the voice room, which is normal.
                const level = response.status === 404 ? 'debug' : 'warn';
                log[level]('livekit_remove_failed', {status: response.status});
            }
        } catch (e) {
            if (log) {
                log.warn('livekit_remove_failed', {status: 0});
            }
        }
    };

    return Object.freeze({enabled, removeParticipant});
};
