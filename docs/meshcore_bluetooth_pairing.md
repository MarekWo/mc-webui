# How to Pair MeshCore/Heltec Devices via Bluetooth on Linux

Pairing Bluetooth Low Energy (BLE) devices like Heltec (running MeshCore or Meshtastic) with a headless Linux server can sometimes be tricky due to security negotiations. Follow this guide to ensure a stable and successful connection for the `mc-webui` application.

## Prerequisites: Device Preparation

Before touching the Linux terminal, you must configure your MeshCore device to use a fixed PIN. This prevents authentication timeouts and makes headless pairing much easier.

1. Connect to your MeshCore device via the mobile app or web interface.
2. Go to the **Bluetooth Settings**.
3. Set the pairing mode to use a **Fixed PIN** (Passkey).
4. Enter a memorable 6-digit PIN (e.g., `123456`).
5. Save the configuration and let the device reboot.

---

## Step 1: Linux Server Preparation

Linux's default Bluetooth stack (BlueZ) needs to be optimized for Bluetooth Low Energy (BLE).

1. Edit the main Bluetooth configuration file:
   ```bash
   sudo nano /etc/bluetooth/main.conf
   ```
2. Find the `[General]` section and add or modify the following lines to force LE mode and speed up connections:
   ```ini
   ControllerMode = le
   FastConnectable = true
   ```
3. Save the file and restart the Bluetooth service:
   ```bash
   sudo systemctl restart bluetooth
   ```

*Note for Proxmox/VM Users:* If you are passing a physical USB Bluetooth dongle to a Virtual Machine, **do not use USB 3.0 passthrough**. It causes packet drops and timeouts (`Opcode failed` errors). Always force USB 2.0. Example Proxmox command:
`qm set <VMID> -usb0 host=<VENDOR_ID>:<PRODUCT_ID>,usb3=0`

---

## Step 2: The Pairing Process

Use the built-in `bluetoothctl` tool to discover, pair, and trust your device.

1. Open the Bluetooth control utility:
   ```bash
   bluetoothctl
   ```
2. Enable the keyboard display agent (this tells Linux to ask you for the PIN):
   ```text
   [bluetooth]# agent KeyboardDisplay
   [bluetooth]# default-agent
   ```
3. Turn on the Bluetooth scan to find your device:
   ```text
   [bluetooth]# scan le
   ```
4. Wait until your device appears in the list and note its MAC address (e.g., `AC:A7:04:08:66:A1 MeshCore-demo mc-webui`).
5. Initiate the pairing process using the MAC address:
   ```text
   [bluetooth]# pair AC:A7:04:08:66:A1
   ```
6. The terminal will prompt you for the passkey:
   `[agent] Enter passkey (number in 0-999999):`
   Enter the **Fixed PIN** you configured earlier (e.g., `123456`) and press Enter.
7. You should see `Pairing successful`.

---

## Step 3: Trusting the Device

This is the most crucial step. You must "trust" the device so that `mc-webui` can automatically connect to it in the future without requiring the PIN again.

1. In the `bluetoothctl` prompt, type:
   ```text
   [bluetooth]# trust AC:A7:04:08:66:A1
   ```
2. You should see `trust succeeded`.
3. You can now safely exit the utility:
   ```text
   [bluetooth]# exit
   ```

Your MeshCore device is now permanently paired, trusted, and ready to communicate with the `mc-webui` server!
