#!/bin/bash
set -e
source /root/games-vault/.env
docker stop gv-web-gv-web-1 2>/dev/null || true
docker rm gv-web-gv-web-1 2>/dev/null || true
docker run -d --name gv-web-gv-web-1 --network host --restart unless-stopped \
  -e HOSTNAME=127.0.0.1 \
  -e AUTH_SECRET="${AUTH_SECRET}" \
  -e AUTH_URL="https://lngnckr.tech" \
  -e DATABASE_URL="postgresql://games_vault@127.0.0.1:5432/games_vault" \
  -e GV_ICE_STUN_URLS="stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302" \
  -e GV_ICE_TURN_URLS="turn:lngnckr.tech:3478?transport=udp" \
  -e GV_ICE_TURN_USERNAME=gv \
  -e GV_ICE_TURN_CREDENTIAL="${GV_ICE_TURN_CREDENTIAL}" \
  -e GV_ICE_TRANSPORT_POLICY=all \
  -e GV_API_KEY="${GV_API_KEY}" \
  gv-web-prod:latest
