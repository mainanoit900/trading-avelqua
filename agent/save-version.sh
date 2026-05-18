#!/bin/bash
SRC="/root/trading-avelqua/agent/agent.py"
DST="/root/trading-avelqua/agent/versions/agent-$(date +%Y%m%d-%H%M%S).py"
cp "$SRC" "$DST"
echo "saved: $DST"
