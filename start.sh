#!/bin/sh
# Starts the bridge. It quits by itself when Patches is closed.
cd "$(dirname "$0")" && exec node bridge.js
