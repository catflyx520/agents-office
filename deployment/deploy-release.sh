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
previous_proxy="$(mktemp)"
cp /etc/nginx/nginx.conf "$previous_proxy"
trap 'rm -f "$previous_proxy"' EXIT
docker rm -f agents-office 2>/dev/null || true
start_office() {
  local -a workspace_flags=(-v /var/lib/agents-office/home:/home/node:rw --env-file /etc/agents-office/providers.env)
  if [ "$(docker image inspect --format '{{index .Config.Labels "org.agents-office.access"}}' "$1")" = 'public' ]; then
    # Public visitors never receive the owner's old home, keys or CLI login.
    workspace_flags=(--tmpfs '/home/node:rw,uid=1000,gid=1000,size=16m')
  fi
  docker run -d --name agents-office --restart unless-stopped \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 1400m --memory-swap 2800m --pids-limit 256 \
    --log-opt max-size=10m --log-opt max-file=3 \
    --tmpfs /tmp:rw,nosuid,size=256m \
    -p 127.0.0.1:3000:3000 \
    "${workspace_flags[@]}" \
    "$1" >/dev/null
}
start_office "agents-office:$release_sha"
activate_proxy() {
  # Bootstrap checks its private entry; publication activates the public proxy.
  if ! systemctl is-active --quiet nginx; then return 0; fi
  local proxy_file="$release_dir/deployment/nginx.conf"
  local expected_status=401
  if [ -f "$release_dir/deployment/nginx.public.conf" ]; then
    proxy_file="$release_dir/deployment/nginx.public.conf"
    expected_status=200
  fi
  install -m 644 "$proxy_file" /etc/nginx/nginx.conf || return 1
  nginx -t || return 1
  systemctl reload nginx || return 1
  local proxy_probe proxy_code=000
  # systemctl's reload completes before old Nginx workers have exited.
  for ((proxy_probe = 0; proxy_probe < 20; proxy_probe++)); do
    proxy_code="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' http://127.0.0.1/)" || proxy_code=000
    if [ "$proxy_code" = "$expected_status" ]; then
      echo "Proxy ready: HTTP $proxy_code"
      return 0
    fi
    sleep 1
  done
  echo "Proxy activation failed: expected HTTP $expected_status, received $proxy_code" >&2
  return 1
}
for ((attempt = 0; attempt < 60; attempt++)); do
  if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then
    if activate_proxy; then
      printf '%s\n' "$release_sha" > /var/lib/agents-office/release-commit
      echo "Release healthy: $release_sha"
      exit 0
    fi
    break
  fi
  sleep 3
done
echo 'New release failed its health check' >&2
docker rm -f agents-office >/dev/null 2>&1 || true
if [ -n "$previous_image" ]; then start_office "$previous_image"; fi
install -m 644 "$previous_proxy" /etc/nginx/nginx.conf
if systemctl is-active --quiet nginx; then nginx -t && systemctl reload nginx; fi
exit 1
