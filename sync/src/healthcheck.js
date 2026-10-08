// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 Adam Jenkins <adam@wisecat.net>
// mavr-sync: container health check (`node /app/src/healthcheck.js`). Exit 0 when GET /healthz on
// 127.0.0.1 at the port of MAVR_SYNC_LISTEN answers 2xx within 4 s, else 1. A script file instead of
// `node -e "..."`, because podman-compose turns an exec-form test into a shell string and breaks the
// quoting of inline code.

const listen = process.env.MAVR_SYNC_LISTEN || '127.0.0.1:8090';
const port = listen.split(':').pop();

fetch(`http://127.0.0.1:${port}/healthz`, {signal: AbortSignal.timeout(4000)})
    .then((response) => process.exit(response.ok ? 0 : 1))
    .catch(() => process.exit(1));
