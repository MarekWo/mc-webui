#!/bin/bash
# Docker entrypoint for mc-webui
#
# Disconnects stale BLE connections before starting the app.
# BlueZ on the host auto-reconnects trusted devices, leaving stale GATT
# notification handles that block bleak from establishing a new session.
# A clean disconnect here ensures the app starts with a fresh BLE state.

set -e

# If MC_BLE_ADDRESS is set, clean up stale BLE connections
if [ -n "$MC_BLE_ADDRESS" ]; then
    DBUS_PATH="/org/bluez/hci0/dev_${MC_BLE_ADDRESS//:/_}"

    # Check if device is connected via BlueZ
    CONNECTED=$(dbus-send --system --print-reply --dest=org.bluez \
        "$DBUS_PATH" org.freedesktop.DBus.Properties.Get \
        string:org.bluez.Device1 string:Connected 2>/dev/null \
        | grep -c "boolean true" || true)

    if [ "$CONNECTED" = "1" ]; then
        echo "[entrypoint] BLE device $MC_BLE_ADDRESS is connected, disconnecting stale session..."
        dbus-send --system --print-reply --dest=org.bluez \
            "$DBUS_PATH" org.bluez.Device1.Disconnect 2>/dev/null || true
        sleep 2
        echo "[entrypoint] Stale BLE connection cleared"
    fi
fi

# Run the main application
exec "$@"
