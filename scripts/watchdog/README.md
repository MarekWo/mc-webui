# mc-webui Container Watchdog

The `watchdog` service is a utility designed to run on the host machine running the Docker containers for the `mc-webui` project. Its primary purpose is to continuously monitor the health of the application's containers, specifically the `mc-webui` container, which handles the physical connection to the LoRa device (like Heltec V3 or V4).

## Key Capabilities

- **Automated Restarts:** If a container becomes `unhealthy`, stops, or reports device connection issues in its logs, the watchdog automatically restarts it to restore service without human intervention.
- **Hardware USB Bus Reset:** If the `mc-webui` container fails to recover after three successive restarts (e.g., due to a hardware freeze on the LoRa device itself), the watchdog will intelligently simulate a physical disconnection and reconnection of the device via a low-level USB bus reset, completely resolving hardware lockups.

## Installation / Update

You can easily install or update the watchdog by running the provided installer script with root privileges:

```bash
cd ~/mc-webui/scripts/watchdog
sudo ./install.sh
```

## Detailed Documentation

For full details on configuration, logs, troubleshooting, and more advanced features, please refer to the main [Container Watchdog Documentation](../../docs/watchdog.md) located in the `docs` folder.
