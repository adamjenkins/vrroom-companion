// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// vrroom-sync: in-process extension point (Phase 5: the Hubs observer bot). Unused in Phase 4.

import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Hooks an extension may implement. */
export const HOOKS = Object.freeze(['roomOpened', 'peerJoined', 'peerLeft', 'stateChanged', 'roomClosed']);

/** URL prefix of extension routes. */
export const ROUTE_PREFIX = '/v1/ext/';

/** Extension names. */
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Route sub-paths: unreserved characters in '/'-separated segments, no '.' or '..' segment. */
const SUBPATH = /^(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/;

/**
 * An invalid extension. `extension` is the extension name or the module's file name.
 */
export class ExtensionError extends Error {
    /**
     * @param {string} extension
     */
    constructor(extension) {
        super(`Invalid extension ${extension}`);
        this.name = 'ExtensionError';
        this.extension = extension;
    }
}

/**
 * Freeze a view (one level of nested objects).
 *
 * @param {Object} view
 * @returns {Object}
 */
const freezeView = (view) => {
    const copy = {};
    for (const [key, value] of Object.entries(view || {})) {
        copy[key] = value !== null && typeof value === 'object' ? Object.freeze(Object.assign({}, value)) : value;
    }
    return Object.freeze(copy);
};

/**
 * Create the extension host.
 *
 * Extension module: `export default {name, hooks: {<hook>: fn(view)}, routes: {<subpath>: fn(req, res)}}`.
 *
 * @param {Object} log Logger (src/log.js).
 * @returns {{register: Function, load: Function, emit: Function, route: Function, names: Function}}
 */
export const createExtensionHost = (log) => {
    const extensions = new Map();

    /**
     * Register an extension definition (load() calls this; tests and embedders may too).
     *
     * @param {Object} definition
     * @param {string} label Name used in errors when the definition has no valid name.
     */
    const register = (definition, label = 'unknown') => {
        if (definition === null || typeof definition !== 'object' || typeof definition.name !== 'string' ||
                !NAME.test(definition.name)) {
            throw new ExtensionError(label);
        }
        const name = definition.name;
        if (extensions.has(name)) {
            throw new ExtensionError(name);
        }
        const hooks = {};
        const rawhooks = definition.hooks === undefined ? {} : definition.hooks;
        if (rawhooks === null || typeof rawhooks !== 'object') {
            throw new ExtensionError(name);
        }
        for (const [hook, fn] of Object.entries(rawhooks)) {
            if (!HOOKS.includes(hook) || typeof fn !== 'function') {
                throw new ExtensionError(name);
            }
            hooks[hook] = fn;
        }
        const routes = new Map();
        const rawroutes = definition.routes === undefined ? {} : definition.routes;
        if (rawroutes === null || typeof rawroutes !== 'object') {
            throw new ExtensionError(name);
        }
        for (const [subpath, fn] of Object.entries(rawroutes)) {
            if (!SUBPATH.test(subpath) || typeof fn !== 'function') {
                throw new ExtensionError(name);
            }
            routes.set(subpath, fn);
        }
        extensions.set(name, Object.freeze({name, hooks: Object.freeze(hooks), routes}));
    };

    /**
     * Import and register the configured extension modules.
     *
     * @param {string[]} paths Absolute file paths.
     * @returns {Promise<void>}
     * @throws {ExtensionError}
     */
    const load = async (paths) => {
        for (const file of paths || []) {
            const label = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
            let module;
            try {
                module = await import(pathToFileURL(file).href);
            } catch (e) {
                throw new ExtensionError(label);
            }
            register(module ? module.default : null, label);
        }
    };

    /**
     * Call a hook on every extension. Never throws and never makes the caller wait: errors (also
     * rejected promises) are caught and logged with the extension name and hook only.
     *
     * @param {string} hook One of HOOKS.
     * @param {Object} view Plain data for the hook; frozen before it is passed on.
     */
    const emit = (hook, view) => {
        if (extensions.size === 0) {
            return;
        }
        const frozen = freezeView(view);
        for (const extension of extensions.values()) {
            const fn = extension.hooks[hook];
            if (!fn) {
                continue;
            }
            const report = () => log.error('extension_error', {extension: extension.name, hook});
            try {
                const result = fn(frozen);
                if (result && typeof result.then === 'function') {
                    result.then(undefined, report);
                }
            } catch (e) {
                report();
            }
        }
    };

    /**
     * Route a request under /v1/ext/<name>/<subpath> to its extension.
     *
     * @param {Object} req node:http request.
     * @param {Object} res node:http response.
     * @returns {boolean} false when no extension route matches (the caller answers 404).
     */
    const route = (req, res) => {
        const pathname = String(req.url || '').split('?')[0];
        if (!pathname.startsWith(ROUTE_PREFIX)) {
            return false;
        }
        const rest = pathname.slice(ROUTE_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) {
            return false;
        }
        const extension = extensions.get(rest.slice(0, slash));
        const handler = extension ? extension.routes.get(rest.slice(slash + 1)) : undefined;
        if (!handler) {
            return false;
        }
        const failed = () => {
            log.error('extension_error', {extension: extension.name, hook: 'route'});
            if (!res.headersSent) {
                res.writeHead(500, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
                res.end('{"error":"internal"}');
            } else if (!res.writableEnded) {
                res.end();
            }
        };
        try {
            const result = handler(req, res);
            if (result && typeof result.then === 'function') {
                result.then(undefined, failed);
            }
        } catch (e) {
            failed();
        }
        return true;
    };

    /**
     * Names of the registered extensions.
     *
     * @returns {string[]}
     */
    const names = () => [...extensions.keys()];

    return Object.freeze({register, load, emit, route, names});
};
