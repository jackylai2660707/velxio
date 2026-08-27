#!/usr/bin/env bash
# Provision the ESP32-S3 boot ROM used by the lcgamboa QEMU machine.
#
# The ROM is intentionally not checked into this repository (it is a binary
# asset).  Keep the URL and digest pinned so a fresh clone gets reproducible
# bytes, while still allowing an operator to point the script at a local test
# mirror via ESP32_S3_ROM_URL.
set -Eeuo pipefail

readonly ROM_FILE_NAME="esp32s3_rev0_rom.bin"
readonly ROM_SHA256="b5c7090cc22efce51c1323cef31ca96fcd673a5b1d1b1017e219d393f2659913"
readonly ROM_COMMIT="b49c8e10721200d0c001c3c9345672f5d09327ba"
readonly PINNED_ROM_URL="https://raw.githubusercontent.com/lcgamboa/qemu/${ROM_COMMIT}/pc-bios/${ROM_FILE_NAME}"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/.." && pwd)
if [[ -n "${ESP32_S3_ROM_PATH:-}" ]]; then
  dest_file=${ESP32_S3_ROM_PATH}
else
  dest_dir=${ESP32_S3_ROM_DIR:-"${repo_root}/prebuilt/qemu"}
  dest_file="${dest_dir}/${ROM_FILE_NAME}"
fi
dest_parent=$(dirname -- "${dest_file}")
rom_url=${ESP32_S3_ROM_URL:-"${PINNED_ROM_URL}"}
force=${ESP32_S3_ROM_FORCE:-0}

die() {
  echo "provision-esp32s3-rom: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

[[ "${dest_file##*/}" == "${ROM_FILE_NAME}" ]] || \
  die "destination must be named ${ROM_FILE_NAME}: ${dest_file}"
[[ ! -L "${dest_file}" ]] || die "refusing to write through symlink: ${dest_file}"

if [[ -f "${dest_file}" ]]; then
  actual=$(sha256sum -- "${dest_file}" | awk '{print $1}')
  if [[ "${actual}" == "${ROM_SHA256}" ]]; then
    echo "ESP32-S3 ROM already provisioned: ${dest_file}"
    exit 0
  fi
  [[ "${force}" == "1" || "${force,,}" == "true" || "${force,,}" == "yes" ]] || \
    die "existing ${dest_file} has SHA-256 ${actual}; refusing to overwrite (set ESP32_S3_ROM_FORCE=1 to replace)"
  echo "Replacing existing ${dest_file} (digest ${actual})"
elif [[ -e "${dest_file}" ]]; then
  die "destination exists but is not a regular file: ${dest_file}"
fi

mkdir -p -- "${dest_parent}"
# Keep the temporary file beside the destination so mv remains atomic even
# when ESP32_S3_ROM_PATH points at a different filesystem.
tmp_file=$(mktemp "${dest_parent}/.${ROM_FILE_NAME}.XXXXXX")
cleanup() { rm -f -- "${tmp_file}"; }
trap cleanup EXIT

echo "Downloading pinned ESP32-S3 ROM (${ROM_COMMIT}) ..."
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 \
  --output "${tmp_file}" "${rom_url}"
actual=$(sha256sum -- "${tmp_file}" | awk '{print $1}')
[[ "${actual}" == "${ROM_SHA256}" ]] || \
  die "downloaded ROM SHA-256 mismatch: expected ${ROM_SHA256}, got ${actual}"

chmod 0644 -- "${tmp_file}"
mv -- "${tmp_file}" "${dest_file}"
trap - EXIT
echo "Provisioned ${dest_file} (SHA-256 ${ROM_SHA256})"
