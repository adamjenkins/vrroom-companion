# mavr-companion

The container stack behind the **Companion service** run mode of the MAVR activity for Moodle
(`mod_mavr` with the sub-plugin `mavrruntime_companion`). It makes live rooms of up to 50 people
possible, with voice, and keeps participants' IP addresses away from each other.

Two services:

- **mavr-sync** (this repository, `sync/`): a small Node.js WebSocket service. Browsers in a live
  room send it their position and state; it passes them on to the others in the same room.
- **LiveKit** (the Apache-2.0 [LiveKit server](https://github.com/livekit/livekit), pulled as an
  image): relays the voices of the people in a room.

The stack is deliberately thin:

- It **stores nothing** (no database, no files, no volumes) and **grades nothing**. Rooms exist in
  memory while people are in them. Attempts, xAPI statements and grades still go from the browser
  to Moodle, as in the other run modes.
- It accepts a browser only with a **room token signed by the Moodle site** with the shared secret.
  Tokens live five minutes and are renewed through Moodle, which re-checks access each time, so a
  person who loses access (attempt finished, removed from the group, live mode off) is out within
  about five minutes. Tokens carry a pseudonymous id, never the Moodle user id.
- `mavr-sync` logs counts and codes only: no names, ids, IP addresses, tokens or message contents.
- A later phase adds a Hubs observer bot to `mavr-sync` through its extension point
  (`sync/extensions/README.md`); nothing uses it yet.

```
Browser ──wss──► reverse proxy (TLS) ──► mavr-sync 127.0.0.1:8090 ──(optional)──► LiveKit API
   │   └─wss──► reverse proxy (TLS) ──► LiveKit   127.0.0.1:7880
   └── voice: UDP 50000-50199 (or TCP 7881) ──────► LiveKit (directly, no proxy)
Moodle ── admin connection test ──► /healthz, /v1/challenge, LiveKit
```

## Contents

- [Requirements](#requirements)
- [Ports and firewall](#ports-and-firewall)
- [Install with rootless Podman and Quadlet](#install-with-rootless-podman-and-quadlet)
- [Install with podman compose](#install-with-podman-compose)
- [Install with Docker](#install-with-docker)
- [Reverse proxy](#reverse-proxy)
- [Configure Moodle](#configure-moodle)
- [Settings reference](#settings-reference)
- [Voice and TURN](#voice-and-turn)
- [Testing without TLS](#testing-without-tls)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)
- [Licences](#licences)

## Requirements

- A Linux host (the Moodle server itself or another machine) with one of:
  - **Podman 4.6 or later** (recommended, rootless), with a compose provider (`podman-compose`
    or `docker-compose`) if you use `podman compose` instead of the Quadlet units;
  - Docker Engine with the compose plugin.
- Two DNS names pointing at the host, for example `companion.example.org` and
  `livekit.example.org`, with **browser-trusted TLS certificates** on the site's reverse proxy
  (nginx or Apache). Browsers allow the microphone only on secure pages, and a secure page may
  only open secure WebSockets.
- The firewall ports below.
- About 256 MB of memory for `mavr-sync` and 512 MB or more for LiveKit at 50 people (estimate).
- The Moodle plugins `mod_mavr` (with `mavrruntime_builtin`) and `mavrruntime_companion`.

Rootless Podman cannot bind ports below 1024, so neither service listens on 443: the site's
existing reverse proxy terminates TLS and forwards to them. Both containers use **host
networking**: LiveKit needs it for its UDP range, and with it `mavr-sync` reaches LiveKit's API at
`127.0.0.1:7880` the same way under Podman and Docker.

## Ports and firewall

| Port | Service | Open to the internet? |
|---|---|---|
| 443/tcp | your reverse proxy (both names) | yes |
| 8090/tcp | mavr-sync (listens on 127.0.0.1 only) | no |
| 7880/tcp | LiveKit signalling (listens on all interfaces) | **no**: block it, the proxy forwards to it |
| 7881/tcp | LiveKit ICE over TCP (voice for networks that block UDP) | yes |
| 50000–50199/udp | LiveKit voice (`LIVEKIT_UDP_START`–`LIVEKIT_UDP_END`) | yes |
| 3478/udp, 5349/tcp | optional embedded TURN (off by default) | only if you enable TURN |

Example with `ufw`:

```sh
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50199/udp
sudo ufw deny 7880/tcp
```

Example with `firewalld`:

```sh
sudo firewall-cmd --permanent --add-port=7881/tcp --add-port=50000-50199/udp
sudo firewall-cmd --reload
```

If the host is behind NAT, forward 7881/tcp and the UDP range to it, and set `LIVEKIT_NODE_IP` to
the **public** address.

## Install with rootless Podman and Quadlet

Run everything as the ordinary user that will own the services (not root).

1. Get the stack:

   ```sh
   git clone <this repository> mavr-companion
   cd mavr-companion
   ```

2. Create `.env` with fresh secrets:

   ```sh
   scripts/gen-secrets.sh
   ```

3. Edit `.env`:
   - `MAVR_SYNC_ISSUERS`: your Moodle `wwwroot` exactly as in Moodle's `config.php`, without a
     trailing slash (several sites: comma-separated);
   - `LIVEKIT_NODE_IP`: the IP address browsers use to reach this host.

4. Load the secrets into Podman and write the non-secret settings to
   `~/.config/mavr-companion/mavr-sync.env`:

   ```sh
   scripts/gen-secrets.sh --podman-secrets
   ```

   (It reuses the values in `.env`; it generates nothing new. Run it again after every change to
   `.env`.)

5. Render LiveKit's configuration to `~/.config/mavr-companion/livekit.yaml`:

   ```sh
   scripts/render-livekit-config.sh --quadlet
   ```

6. Build the `mavr-sync` image and pull LiveKit:

   ```sh
   podman build -t localhost/mavr-sync:0.1.0 sync
   podman pull docker.io/livekit/livekit-server:v1.13.9
   ```

7. Install the units and start them:

   ```sh
   mkdir -p ~/.config/containers/systemd
   cp quadlet/mavr-sync.container quadlet/mavr-livekit.container ~/.config/containers/systemd/
   systemctl --user daemon-reload
   systemctl --user start mavr-sync mavr-livekit
   ```

8. Keep them running after you log out and start them at boot:

   ```sh
   loginctl enable-linger "$USER"
   ```

   (Quadlet units are started at boot through their `[Install]` section; `systemctl --user enable`
   is not needed and does not work for generated units.)

9. Check:

   ```sh
   systemctl --user status mavr-sync mavr-livekit
   journalctl --user -u mavr-sync -u mavr-livekit --since -10min
   curl -s http://127.0.0.1:8090/healthz      # {"status":"ok","service":"mavr-sync","protocol":1}
   ```

Then set up the [reverse proxy](#reverse-proxy) and [Moodle](#configure-moodle).

## Install with podman compose

```sh
git clone <this repository> mavr-companion
cd mavr-companion
scripts/gen-secrets.sh
# edit .env: MAVR_SYNC_ISSUERS and LIVEKIT_NODE_IP
scripts/render-livekit-config.sh
podman compose up -d --build
podman compose ps
podman compose logs mavr-sync
```

`podman compose` hands the file to an external provider (`podman-compose` or `docker-compose`);
both read `compose.yaml` and `.env` from this directory. To start the stack at boot with this
method, use the Quadlet units instead (or your provider's own systemd integration).

## Install with Docker

```sh
git clone <this repository> mavr-companion
cd mavr-companion
scripts/gen-secrets.sh
# edit .env: MAVR_SYNC_ISSUERS and LIVEKIT_NODE_IP
scripts/render-livekit-config.sh
sudo chown root:root livekit/livekit.yaml   # rootful Docker only, see below
docker compose up -d --build
docker compose ps
docker compose logs mavr-sync
```

- `restart: unless-stopped` brings the services back after a reboot when the Docker service starts.
- The `:Z` volume option (an SELinux relabel for Podman) is accepted by Docker and has no effect
  on hosts without SELinux.
- `livekit/livekit.yaml` holds the LiveKit API secret and is created with mode 600 for your user.
  The containers run with **all capabilities dropped**, so under **rootful** Docker the container's
  root user cannot read a file owned by someone else: give the file to root as shown (after every
  render). Rootless Podman and rootless Docker need no change, because the container's root is
  your own user there.

## Reverse proxy

Examples: [`proxy/nginx.conf.example`](proxy/nginx.conf.example) and
[`proxy/apache.conf.example`](proxy/apache.conf.example).

- `companion.example.org`: `/sync` (WebSocket upgrade) → `http://127.0.0.1:8090`; `/healthz` and
  `/v1/` → the same; everything else 404.
- `livekit.example.org`: everything (WebSocket upgrade) → `http://127.0.0.1:7880`, with a long read
  timeout.
- Apache needs httpd 2.4.47 or later for `upgrade=websocket` (the example shows the older
  `mod_proxy_wstunnel` form too).
- Voice (UDP and 7881/tcp) does not pass through the proxy.
- mavr-sync answers only the exact paths `/sync`, `/healthz` and `/v1/…`. If you publish it under a
  path prefix (Moodle's companion address `https://example.org/mavr` means browsers open
  `wss://example.org/mavr/sync` and Moodle calls `https://example.org/mavr/healthz`), the proxy must
  strip the prefix before passing the request on (nginx: `location /mavr/ { proxy_pass
  http://127.0.0.1:8090/; … }`; Apache: `ProxyPass "/mavr/sync" "http://127.0.0.1:8090/sync"
  upgrade=websocket` and the same for the other two paths).

## Configure Moodle

In *Site administration > Plugins > Activity modules > MAVR > Companion service*:

| Setting | Name | Value |
|---|---|---|
| Companion address | `url` | `https://companion.example.org` (browsers connect to `wss://companion.example.org/sync`) |
| Address used by this server (optional) | `serverurl` | only if Moodle reaches the stack by another address, for example `http://127.0.0.1:8090` when Moodle runs on the same host |
| Shared secret | `secret` | `MAVR_SYNC_SECRET` from `.env` |
| Maximum people per room | `maxusers` | 2–50 (default 50; also capped by `MAVR_SYNC_MAX_ROOM_PEERS`) |
| LiveKit address | `livekiturl` | `wss://livekit.example.org` |
| LiveKit API key | `livekitkey` | `LIVEKIT_API_KEY` from `.env` |
| LiveKit API secret | `livekitsecret` | `LIVEKIT_API_SECRET` from `.env` |

Leave the three LiveKit settings empty for live rooms without voice. Print the secrets with
`scripts/gen-secrets.sh --show`, or read them from `.env` (mode 600).

Save, then open **Test the companion connection** (linked from the settings page). Moodle checks
that the companion answers, that it **knows the same shared secret** (Moodle sends a signed
challenge and the service answers with an HMAC; the secret itself is never sent, and another
server at that address fails this check), that LiveKit answers and that it accepts the API key.
*Check from this browser* then opens a WebSocket from your own browser.

Teachers choose the run mode *Companion service* in the activity settings, switch *Live mode* on
and choose the room size.

## Settings reference

`.env` (compose) or `~/.config/mavr-companion/mavr-sync.env` plus Podman secrets (Quadlet):

| Variable | Default | Meaning |
|---|---|---|
| `MAVR_SYNC_SECRET` | (required) | Shared secret with Moodle, at least 32 characters, no spaces. |
| `MAVR_SYNC_ISSUERS` | (required) | Moodle `wwwroot` values allowed to issue tokens, comma-separated. |
| `MAVR_SYNC_LISTEN` | `127.0.0.1:8090` | Listen address and port (port 1024–65535). The health checks connect to 127.0.0.1, so use `127.0.0.1` or `0.0.0.0`. If you change the port, change the proxy too. |
| `MAVR_SYNC_ORIGINS` | origins of the issuers | Browser origins allowed to open the WebSocket. |
| `MAVR_SYNC_MAX_ROOM_PEERS` | 50 | Largest room (2–100). |
| `MAVR_SYNC_MAX_ROOMS` | 1000 | Rooms at the same time. |
| `MAVR_SYNC_MAX_CONNECTIONS` | 2000 | WebSocket connections at the same time. |
| `MAVR_SYNC_MAX_PENDING` | 200 | Connections that have not sent their token yet. |
| `MAVR_SYNC_POSE_HZ` | 15 | Position updates sent to each browser per second (1–30). |
| `MAVR_SYNC_GRACE_SECONDS` | 10 | Seconds before the others are told that a dropped connection has left (0–60). |
| `MAVR_SYNC_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. |
| `MAVR_SYNC_EXTENSIONS` | empty | Extension modules (see `sync/extensions/README.md`). |
| `LIVEKIT_API_URL` | `http://127.0.0.1:7880` | LiveKit's API for mavr-sync. With the key and secret set, a person who leaves a room is also removed from its voice room. Empty: off. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | (generated) | LiveKit API credentials (also written into LiveKit's configuration). |
| `LIVEKIT_TAG` | `v1.13.9` | LiveKit image tag for compose. The Quadlet unit names the tag itself. |
| `LIVEKIT_NODE_IP` | (required for voice) | IP address LiveKit announces to browsers. |
| `LIVEKIT_UDP_START`, `LIVEKIT_UDP_END` | 50000, 50199 | UDP range for voice. |

After a change: for compose, `podman compose up -d` (or `docker compose up -d`); for Quadlet,
`scripts/gen-secrets.sh --podman-secrets` and `systemctl --user restart mavr-sync`. LiveKit
settings need `scripts/render-livekit-config.sh` (with `--quadlet` for Quadlet) and a LiveKit
restart.

## Voice and TURN

- LiveKit is configured **not** to discover its public address (that would contact a public STUN
  server) and announces `LIVEKIT_NODE_IP` instead. Nothing outside your host is contacted by
  default.
- Browsers send voice over UDP to the configured range; where UDP is blocked they fall back to TCP
  port 7881.
- Very restrictive networks may need TURN over TLS. LiveKit's embedded TURN is off; the template
  `livekit/livekit.yaml.template` shows how to switch it on. Rootless Podman cannot bind 443, so
  TURN/TLS uses 5349 here, which some networks block too.
- Room tokens from Moodle allow the **microphone only** (no camera, screen or data messages) and
  cap each voice room at the activity's room size.

## Testing without TLS

On a test machine without certificates, Moodle may use `http://` and `ws://` addresses (the
settings accept them for testing). Set `MAVR_SYNC_LISTEN=0.0.0.0:8090`, use
`http://<host>:8090` as the companion address and `ws://<host>:7880` as the LiveKit address, and
open 8090 and 7880 to the test browsers. Browsers refuse the microphone on non-secure pages unless
you start them with flags that treat the site as secure. Never run a real site this way.

## Upgrading

The stack keeps no data, so upgrading is: get the new version, rebuild, restart. People in a live
room at that moment are reconnected automatically.

```sh
git pull
# Quadlet
podman build -t localhost/mavr-sync:0.1.0 sync     # the tag of the new version, see quadlet/mavr-sync.container
cp quadlet/*.container ~/.config/containers/systemd/ && systemctl --user daemon-reload
systemctl --user restart mavr-sync mavr-livekit
# compose
podman compose up -d --build                       # or: docker compose up -d --build
```

To move to a newer LiveKit server, change `LIVEKIT_TAG` in `.env` and the `Image=` line of
`quadlet/mavr-livekit.container` together, then pull and restart.

## Troubleshooting

- **Health:** `curl -s http://127.0.0.1:8090/healthz` on the host, and
  `https://companion.example.org/healthz` from outside, answer
  `{"status":"ok","service":"mavr-sync","protocol":1}`.
- **Logs:** `journalctl --user -u mavr-sync -u mavr-livekit` (Quadlet), or `podman compose logs` /
  `docker compose logs`. `mavr-sync` writes one JSON line per event; a `config_error` line names the
  variable that is wrong, then the service exits. LiveKit logs at level `warn`: look there for
  configuration errors after a start.
- **Admin test fails at "proved that it knows the shared secret":** the `secret` setting in Moodle
  and `MAVR_SYNC_SECRET` differ, or another server answers at that address. "Does not accept tokens
  from this site": add Moodle's `wwwroot` to `MAVR_SYNC_ISSUERS`. "Clock differs": synchronise the
  clocks (NTP) of both servers.
- **Browsers cannot join although the admin test passes:** check the browser check on the test
  page; the proxy must pass the WebSocket upgrade for `/sync`, and `MAVR_SYNC_ORIGINS` must contain
  the Moodle site's origin (the default takes it from `MAVR_SYNC_ISSUERS`).
- **No voice:** check the LiveKit settings and the firewall (UDP range and 7881/tcp), and that
  `LIVEKIT_NODE_IP` is the address browsers can reach.

WebSocket close codes of `mavr-sync` (visible in the browser's developer tools):

| Code | Meaning | What the browser does |
|---|---|---|
| 1000 | Normal close (the person left) | — |
| 1001 | The service is shutting down (restart, upgrade) | reconnects |
| 1006 | Connection lost (no close frame) | reconnects |
| 1009 | Message too large | gives up while joining, reconnects when in the room |
| 4000 | Protocol error | gives up while joining, reconnects when in the room |
| 4001 | No token within 5 seconds of connecting | reconnects |
| 4008 | The browser could not keep up (too much unsent data) | reconnects |
| 4401 | Token invalid or expired (wrong secret, wrong purpose, bad clock) | asks Moodle for a new token once |
| 4403 | Moodle site (issuer) or browser origin not allowed | gives up: check `MAVR_SYNC_ISSUERS` / `MAVR_SYNC_ORIGINS` |
| 4409 | The same person joined again elsewhere (another tab or room) | leaves |
| 4410 | Session expired (no renewed token in time) | asks Moodle for a new token |
| 4429 | Too many messages | gives up while joining, reconnects when in the room |
| 4503 | Room full | shows "The live room is full" |
| 4504 | Service full (connections or rooms) | gives up while joining, reconnects when in the room |

Reconnection waits 1, 2, 4, 8, then 15 seconds between attempts and gives up after 2 minutes.

## Privacy

- **mavr-sync** sees, while a person is in a room: a pseudonymous peer id (made by Moodle from the
  user and activity with a secret salt; it is not the user id), the full name, whether it is an
  attempt or a teacher's preview, the latest position and state, and the browser's IP address
  (through the proxy, as the connection's source). Nothing is written to disk; everything is gone
  when the room is empty.
- **LiveKit** sees the same peer id and name, the IP address, and the voice while the microphone is
  on. It relays voice and records nothing.
- **Other participants** see the name, position, state and voice, but **not** the IP address.
- **Logging:** `mavr-sync` logs no personal data. LiveKit runs at level `warn`, which keeps
  participant identities and room names out of its log. The site's reverse proxy logs client IP
  addresses as it does for any page; no token or name appears in a URL.
- The Moodle plugin `mavrruntime_companion` declares both services as external locations in its
  privacy metadata.

## Licences

- This repository (mavr-sync, configuration, scripts, documentation): **GNU GPL v3 or later**, see
  [`LICENSE`](LICENSE). © 2026 Adam Jenkins.
- **LiveKit server** is © LiveKit, Inc. under the **Apache License 2.0**. It is not included in this
  repository: the image `docker.io/livekit/livekit-server` is pulled when you install. The
  configuration template follows LiveKit's documented configuration format.
- **ws** (the WebSocket library of mavr-sync) is under the **MIT** licence and installed from npm
  when the image is built (exact version in `sync/package-lock.json`).
- The `node:22-alpine` base image contains Node.js (MIT) and Alpine Linux packages under their own
  licences.
