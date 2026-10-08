# Changes

## Unreleased

- First version (VR room Phase 4): the container stack behind the *Companion service* run mode of
  the VR room activity (`vrroomruntime_companion`). Live rooms of up to 50 people, with positions and
  states relayed by `vrroom-sync` 0.1.0 (Node 22, WebSocket protocol `vrroom-sync.1`) and voice by a
  LiveKit server. The stack stores nothing, grades nothing and logs no personal data; it accepts
  only short-lived room tokens signed by the Moodle site with the shared secret.
- Runs under rootless Podman (Quadlet units or `podman compose`) or Docker (`docker compose`).
- Scripts to generate the secrets (`scripts/gen-secrets.sh`, optionally as Podman secrets) and to
  render the LiveKit configuration (`scripts/render-livekit-config.sh`).
- Reverse-proxy examples for nginx and Apache httpd (TLS and WebSocket).
- An extension point in `vrroom-sync` for the Hubs observer bot of a later phase (not used yet).
