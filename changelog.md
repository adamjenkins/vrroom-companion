# Changelog

All notable changes to this stack are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `mavr-sync` 0.1.0: room sync service for MAVR companion live rooms (Node 22, one dependency
  `ws`), WebSocket protocol `mavr-sync.1` on `/sync`, `/healthz`, the admin challenge
  `/v1/challenge`, HS256 room tokens verified with the shared secret, per-room capacity (default
  50), rate and size limits, optional removal from LiveKit when a person leaves, and an
  in-process extension point (hooks and `/v1/ext/` routes) reserved for the Hubs observer bot.
- `compose.yaml` for `podman compose` and `docker compose`: `mavr-sync` (built from
  `sync/Containerfile`) and the LiveKit server image, both with host networking, a read-only root
  file system and all capabilities dropped.
- Rootless Podman Quadlet units `quadlet/mavr-sync.container` and
  `quadlet/mavr-livekit.container`, with the secrets as Podman secrets.
- `scripts/gen-secrets.sh` and `scripts/render-livekit-config.sh`.
- LiveKit configuration template (no external-IP discovery, TURN off, log level `warn`).
- nginx and Apache httpd reverse-proxy examples.
- Install guide (`README.md`), Podman first.
