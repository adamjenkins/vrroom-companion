# vrroom-sync extensions

`vrroom-sync` has a small **in-process extension point**. Nothing uses it in this version: it is
reserved for Phase 5 of VR room, where the Hubs observer bot will run inside `vrroom-sync` and turn what
happens in a Hubs room into xAPI statements for Moodle. This page describes the interface so that
the work can start without changing the core of the service.

## Trust and rules

- Extensions run **inside the `vrroom-sync` process with full trust**. They can read every room's
  presence data (pseudonymous peer ids, display names, poses, states) that their hooks receive.
  Install only code you have reviewed.
- Extensions **must follow the logging rule of `vrroom-sync`**: never log or send elsewhere names,
  peer ids, room ids, tokens, IP addresses or message contents. Use the logger the host gives
  errors to (`extension_error` lines carry the extension name and hook only).
- Extensions **must not store** personal data beyond the live session (the companion is
  deliberately thin: it stores nothing and grades nothing). Statements still go from the browser
  to Moodle; a Phase 5 server channel will be specified separately.
- A failing extension never breaks a room: every hook call is wrapped, errors and rejected promises
  are caught and logged, and the caller never waits for a hook.

## Installing an extension

1. Put the module (an ES module, `.js` or `.mjs`) into the container under `/app/extensions/`, for
   example by mounting a read-only volume: `-v ./my-ext:/app/extensions/my-ext:ro,Z`.
2. List its absolute path in `VRROOM_SYNC_EXTENSIONS` (comma-separated), for example
   `VRROOM_SYNC_EXTENSIONS=/app/extensions/my-ext/index.js`. Paths outside `/app/extensions/` are
   refused at start (`config_error` with `variable: VRROOM_SYNC_EXTENSIONS`).
3. Restart `vrroom-sync`. An extension that cannot be imported or has an invalid definition stops
   the start (`extension_error`, `hook: load`).

## Module shape

```js
export default {
    // 1-32 characters: a-z first, then a-z, 0-9, '_' or '-'. Unique.
    name: 'observer',
    // Optional. Any of the five hooks below; sync or async functions.
    hooks: {
        roomOpened(view) {},
        peerJoined(view) {},
        peerLeft(view) {},
        stateChanged(view) {},
        roomClosed(view) {},
    },
    // Optional. HTTP routes under /v1/ext/<name>/<subpath>; node:http request and response.
    routes: {
        'status': (req, res) => {
            res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
            res.end('{"ok":true}');
        },
    },
};
```

### Hooks and views

Every view is a frozen plain object (nested objects are frozen too).

| Hook | When | View |
|---|---|---|
| `roomOpened` | the first peer is admitted to a room | `{room}` |
| `peerJoined` | a new peer is admitted (not for a reconnect within the away grace, not for a second tab taking over) | `{room, peer}` |
| `peerLeft` | a peer is removed | `{room, peer, reason}` — `reason` is `left`, `timeout`, `replaced`, `expired` or `removed` |
| `stateChanged` | a peer broadcasts a state | `{room, peer, state}` — `state` is the Phase 3 codec string (re-encoded by `vrroom-sync`) |
| `roomClosed` | the last peer of a room is removed | `{room}` |

- `room` = `{iss, room, size, max}`: the issuing Moodle site (its wwwroot), the opaque room id
  (`r` + 32 hex characters, an HMAC Moodle made; it does not contain activity or group ids), the
  current number of peers (joined and briefly away) and the effective capacity.
- `peer` = `{sub, name, kind}`: the opaque peer id (32 hex characters), the display name and
  `attempt` or `preview`. All three come from the token Moodle signed, never from the client.

Poses are not passed to hooks (they arrive at up to 20 per second per peer); an extension that
needs them will get a dedicated, rate-limited hook in Phase 5.

### Routes

`GET`/`POST`/… `/v1/ext/<name>/<subpath>` is passed to `routes[<subpath>]` of the extension called
`<name>`; an unknown name or sub-path answers 404 `{"error":"notfound"}`. A sub-path is one or
more `/`-separated segments of letters, digits and `._~-`; `.` and `..` segments are refused at
registration. A handler that throws
or rejects answers 500 `{"error":"internal"}` when nothing has been sent yet. Handlers must do
their own authentication — for example verify a Moodle-signed JWT with `src/jwt.js` — because the
reverse proxy forwards `/v1/` to `vrroom-sync` (see `proxy/` in the stack).

### Registering in-process (tests, embedding)

`createExtensionHost(log)` (`src/extensions.js`) returns `{register, load, emit, route, names}`;
`register(definition)` validates and adds a definition without a file, which is what the tests
use.

## Reserved for Phase 5: token purpose `observe`

Moodle's tokens carry a purpose claim `vrroom`: `join` (a browser joining a room) and `test` (the
admin challenge). The purpose `observe` is **reserved** for the Phase 5 observer bot. Until then
`vrroom-sync` refuses it on `/sync` like any other unknown purpose (close code 4401), so a token
minted for observation can never be used to join a room as a person.
