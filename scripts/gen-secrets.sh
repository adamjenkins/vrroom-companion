#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright 2026 Adam Jenkins <adam@wisecat.net>
# Creates .env from .env.example with fresh secrets, and optionally loads it into Podman secrets.
#
# Usage: scripts/gen-secrets.sh [--force] [--podman-secrets] [--show]
#
#   (no option)       Create .env from .env.example when it does not exist, and fill every
#                     EMPTY secret (VRROOM_SYNC_SECRET, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).
#                     A secret that already has a value is never replaced.
#   --force           Replace the three secrets in .env even when they have values. Every other
#                     line of .env is kept. (Moodle must then get the new values.)
#   --podman-secrets  Also create the Podman secrets vrroom_sync_secret, vrroom_livekit_api_key and
#                     vrroom_livekit_api_secret from .env, and write the non-secret settings to
#                     ~/.config/vrroom-companion/vrroom-sync.env (for the Quadlet units). Run it again
#                     after every change to .env.
#   --show            Print the secret values (to copy them into Moodle). Off by default.
#
# The script works from any directory and contacts no network service.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
EXAMPLE_FILE="${ROOT}/.env.example"
QUADLET_DIR="${HOME}/.config/vrroom-companion"
QUADLET_ENV="${QUADLET_DIR}/vrroom-sync.env"

FORCE=0
PODMAN_SECRETS=0
SHOW=0

usage() {
    sed -n '6,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    printf 'gen-secrets: %s\n' "$*" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force) FORCE=1 ;;
        --podman-secrets) PODMAN_SECRETS=1 ;;
        --show) SHOW=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
done

umask 077

# Random lowercase hex string of $1 bytes (2 * $1 characters).
random_hex() {
    local bytes="$1" out=''
    if command -v openssl >/dev/null 2>&1; then
        out="$(openssl rand -hex "${bytes}")"
    else
        out="$(od -An -tx1 -N"${bytes}" /dev/urandom | tr -d ' \n')"
    fi
    [[ ${#out} -eq $((bytes * 2)) ]] || die "could not read random bytes"
    printf '%s' "${out}"
}

# Random string of $1 letters and digits.
random_alnum() {
    local length="$1" out='' chunk
    while [[ ${#out} -lt ${length} ]]; do
        # head ends first, so tr reads to the end and no pipe is broken.
        chunk="$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
        out="${out}${chunk}"
    done
    printf '%s' "${out:0:${length}}"
}

# Value of KEY in an env file (last assignment wins; surrounding quotes removed). The file is
# parsed, never sourced, so it cannot run commands.
env_get() {
    local file="$1" key="$2" line value='' found=1
    while IFS= read -r line || [[ -n "${line}" ]]; do
        line="${line%$'\r'}"
        if [[ "${line}" == "${key}="* ]]; then
            value="${line#*=}"
            found=0
        fi
    done < "${file}"
    if [[ ${#value} -ge 2 ]]; then
        if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
            value="${value:1:${#value}-2}"
        fi
    fi
    printf '%s' "${value}"
    return "${found}"
}

# Set KEY=VALUE in an env file: replaces every "KEY=" line, or appends one. Written through a
# temporary file in the same directory, then moved into place (mode 600).
env_set() {
    local file="$1" key="$2" value="$3" tmp
    tmp="$(mktemp "${file}.XXXXXX")"
    KEY="${key}" VALUE="${value}" awk '
        BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"]; done = 0 }
        index($0, key "=") == 1 { print key "=" value; done = 1; next }
        { print }
        END { if (!done) print key "=" value }
    ' "${file}" > "${tmp}"
    chmod 600 "${tmp}"
    mv -f "${tmp}" "${file}"
}

[[ -f "${EXAMPLE_FILE}" ]] || die "missing ${EXAMPLE_FILE}"

if [[ ! -f "${ENV_FILE}" ]]; then
    tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
    cp "${EXAMPLE_FILE}" "${tmp}"
    chmod 600 "${tmp}"
    mv -f "${tmp}" "${ENV_FILE}"
    printf 'Created %s from .env.example.\n' "${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

generated=()
# fill_secret KEY GENERATOR [ARGS...]: run the generator only when KEY needs a new value.
fill_secret() {
    local key="$1" current value
    shift
    current="$(env_get "${ENV_FILE}" "${key}" || true)"
    if [[ -z "${current}" || ${FORCE} -eq 1 ]]; then
        value="$("$@")"
        [[ -n "${value}" ]] || die "could not generate ${key}"
        env_set "${ENV_FILE}" "${key}" "${value}"
        generated+=("${key}")
    fi
}

livekit_key() {
    printf 'API%s' "$(random_alnum 12)"
}

fill_secret VRROOM_SYNC_SECRET random_hex 32
fill_secret LIVEKIT_API_KEY livekit_key
fill_secret LIVEKIT_API_SECRET random_alnum 48

if [[ ${#generated[@]} -gt 0 ]]; then
    printf 'New values in .env: %s\n' "${generated[*]}"
else
    printf 'The secrets in .env are already set (use --force to replace them).\n'
fi

SYNC_SECRET="$(env_get "${ENV_FILE}" VRROOM_SYNC_SECRET || true)"
LK_KEY="$(env_get "${ENV_FILE}" LIVEKIT_API_KEY || true)"
LK_SECRET="$(env_get "${ENV_FILE}" LIVEKIT_API_SECRET || true)"
ISSUERS="$(env_get "${ENV_FILE}" VRROOM_SYNC_ISSUERS || true)"

# Check values someone may have typed in by hand.
if [[ ${#SYNC_SECRET} -lt 32 || "${SYNC_SECRET}" =~ [[:space:]] ]]; then
    die "VRROOM_SYNC_SECRET in .env must be at least 32 characters with no spaces"
fi
if [[ ! "${LK_KEY}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    die "LIVEKIT_API_KEY in .env must contain only letters, digits, '_' and '-'"
fi
if [[ ${#LK_SECRET} -lt 32 || ! "${LK_SECRET}" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    die "LIVEKIT_API_SECRET in .env must be at least 32 characters of letters, digits, '.', '_', ':' or '-'"
fi

if [[ ${PODMAN_SECRETS} -eq 1 ]]; then
    command -v podman >/dev/null 2>&1 || die "podman is not installed (needed for --podman-secrets)"

    # podman secret create --replace needs Podman 4.7 or later; older versions: remove, then create.
    put_secret() {
        local name="$1" value="$2"
        if ! printf '%s' "${value}" | podman secret create --replace "${name}" - >/dev/null 2>&1; then
            podman secret rm "${name}" >/dev/null 2>&1 || true
            printf '%s' "${value}" | podman secret create "${name}" - >/dev/null \
                || die "could not create the Podman secret ${name}"
        fi
        printf 'Podman secret %s set.\n' "${name}"
    }
    put_secret vrroom_sync_secret "${SYNC_SECRET}"
    put_secret vrroom_livekit_api_key "${LK_KEY}"
    put_secret vrroom_livekit_api_secret "${LK_SECRET}"

    # Non-secret settings for the Quadlet unit: every active VRROOM_SYNC_* line except the secret,
    # plus LIVEKIT_API_URL.
    mkdir -p "${QUADLET_DIR}"
    chmod 700 "${QUADLET_DIR}"
    tmp="$(mktemp "${QUADLET_ENV}.XXXXXX")"
    {
        printf '# Written by vrroom-companion/scripts/gen-secrets.sh --podman-secrets from %s.\n' "${ENV_FILE}"
        printf '# Edit .env and run the script again instead of editing this file.\n'
        while IFS= read -r line || [[ -n "${line}" ]]; do
            line="${line%$'\r'}"
            case "${line}" in
                VRROOM_SYNC_SECRET=*) ;;
                VRROOM_SYNC_*=*|LIVEKIT_API_URL=*) printf '%s\n' "${line}" ;;
            esac
        done < "${ENV_FILE}"
    } > "${tmp}"
    chmod 600 "${tmp}"
    mv -f "${tmp}" "${QUADLET_ENV}"
    printf 'Wrote %s.\n' "${QUADLET_ENV}"
fi

if [[ "${ISSUERS}" == *"moodle.example.org"* || -z "${ISSUERS}" ]]; then
    printf '\nWARNING: VRROOM_SYNC_ISSUERS in .env is still the example. Set it to your Moodle wwwroot.\n'
    if [[ ${PODMAN_SECRETS} -eq 1 ]]; then
        printf 'Then run scripts/gen-secrets.sh --podman-secrets again.\n'
    fi
fi

if [[ ${SHOW} -eq 1 ]]; then
    printf '\nVRROOM_SYNC_SECRET=%s\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' \
        "${SYNC_SECRET}" "${LK_KEY}" "${LK_SECRET}"
fi

cat <<EOF

Next steps:
  1. Edit ${ENV_FILE}: VRROOM_SYNC_ISSUERS (your Moodle wwwroot) and LIVEKIT_NODE_IP.
  2. scripts/render-livekit-config.sh   (add --quadlet for the Quadlet install)
  3. Start the stack (README: Quadlet, podman compose or docker compose).
  4. In Moodle, Site administration > Plugins > Activity modules > VR room > Companion service:
       Companion address   (url)            https://companion.example.org
       Shared secret       (secret)         the VRROOM_SYNC_SECRET value of .env
       LiveKit address     (livekiturl)     wss://livekit.example.org
       LiveKit API key     (livekitkey)     the LIVEKIT_API_KEY value of .env
       LiveKit API secret  (livekitsecret)  the LIVEKIT_API_SECRET value of .env
     then press "Test the companion connection".
  The secrets are in .env (mode 600); print them with --show, or: grep -E '^(VRROOM_SYNC_SECRET|LIVEKIT_API_(KEY|SECRET))=' .env
EOF
