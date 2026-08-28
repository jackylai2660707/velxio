#!/usr/bin/env bash
set -euo pipefail

# Fast production path for frontend-only changes. Keeps the running image
# (ESP-IDF/Arduino/QEMU layers) and replaces nginx static assets in-place.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
container_name="${VELXIO_CONTAINER:-ailab-app}"

cd "$repo_dir/frontend"
npm run build:docker
# Static assets must be readable by nginx/www-data. Restrictive source umasks
# otherwise make metadata JSON return 403 and empty the component registry.
chmod -R a+rX "$repo_dir/frontend/dist"
docker cp "$repo_dir/frontend/dist/." "$container_name:/usr/share/nginx/html/"
docker exec "$container_name" chmod -R a+rX /usr/share/nginx/html
docker exec "$container_name" nginx -s reload >/dev/null 2>&1 || true
echo "Frontend deployed to $container_name without rebuilding embedded toolchains."
