#!/bin/sh
set -eu
mkdir -p "$HOME/Projects/backend" "$HOME/Projects/frontend" "$HOME/Projects/mobile"
exec "$@"
