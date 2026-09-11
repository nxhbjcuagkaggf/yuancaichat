#!/usr/bin/env bash
# 一键启动：自动读取同目录 .env 里的凭据，然后启动后端代理。
set -a
if [ -f .env ]; then . ./.env; fi
set +a
exec python3 server.py