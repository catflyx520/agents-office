#!/bin/bash
set -euo pipefail
release_sha="$1"
if ! [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'A full Git commit SHA is required' >&2
  exit 1
fi
release_dir="/opt/agents-office/releases/$release_sha"
mkdir -p "$release_dir"
curl --fail --silent --show-error --location --retry 3 \
  "https://api.github.com/repos/catflyx520/agents-office/tarball/$release_sha" \
  | tar -xz --strip-components=1 -C "$release_dir"
docker build --pull -t "agents-office:$release_sha" "$release_dir"
previous_image="$(docker inspect --format '{{.Config.Image}}' agents-office 2>/dev/null || true)"
docker rm -f agents-office 2>/dev/null || true
start_office() {
  docker run -d --name agents-office --restart unless-stopped \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 640m --memory-swap 1792m --pids-limit 256 \
    --log-opt max-size=10m --log-opt max-file=3 \
    --tmpfs /tmp:rw,nosuid,size=96m \
    -p 127.0.0.1:3000:3000 \
    --env-file /etc/agents-office/providers.env \
    -v /var/lib/agents-office/home:/home/node:rw \
    "$1" >/dev/null
}
start_office "agents-office:$release_sha"
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then
    printf '%s\n' "$release_sha" > /var/lib/agents-office/release-commit
    echo "Release healthy: $release_sha"
    exit 0
  fi
  sleep 3
done
echo 'New release failed its health check' >&2
docker rm -f agents-office >/dev/null 2>&1 || true
if [ -n "$previous_image" ]; then start_office "$previous_image"; fi
exit 1
