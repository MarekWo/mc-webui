"""
DeviceManager — manages MeshCore device connection for mc-webui v2.

Runs the meshcore async event loop in a dedicated background thread.
Flask routes call execute() to bridge sync→async.
"""

import asyncio
import logging
import threading
from typing import Optional, Any

logger = logging.getLogger(__name__)


class DeviceManager:
    """
    Manages MeshCore device connection.

    Usage:
        dm = DeviceManager(config, db, socketio)
        dm.start()  # spawns background thread, connects to device
        ...
        dm.stop()   # disconnect and stop background thread
    """

    def __init__(self, config, db, socketio=None):
        self.config = config
        self.db = db
        self.socketio = socketio
        self.mc = None              # meshcore.MeshCore instance
        self._loop = None           # asyncio event loop (in background thread)
        self._thread = None         # background thread
        self._connected = False
        self._device_name = None
        self._self_info = None

    @property
    def is_connected(self) -> bool:
        return self._connected and self.mc is not None

    @property
    def device_name(self) -> str:
        return self._device_name or self.config.MC_DEVICE_NAME

    @property
    def self_info(self) -> Optional[dict]:
        return self._self_info

    def start(self):
        """Start the device manager background thread and connect."""
        if self._thread and self._thread.is_alive():
            logger.warning("DeviceManager already running")
            return

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, daemon=True, name="device-manager"
        )
        self._thread.start()
        logger.info("DeviceManager background thread started")

    def _run_loop(self):
        """Run the async event loop in the background thread."""
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._connect())
        self._loop.run_forever()

    async def _connect(self):
        """Connect to device via serial or TCP."""
        from meshcore import MeshCore

        try:
            if self.config.use_tcp:
                logger.info(f"Connecting via TCP: {self.config.MC_TCP_HOST}:{self.config.MC_TCP_PORT}")
                self.mc = await MeshCore.create_tcp(
                    host=self.config.MC_TCP_HOST,
                    port=self.config.MC_TCP_PORT,
                    auto_reconnect=self.config.MC_AUTO_RECONNECT,
                )
            else:
                logger.info(f"Connecting via serial: {self.config.MC_SERIAL_PORT}")
                self.mc = await MeshCore.create_serial(
                    port=self.config.MC_SERIAL_PORT,
                    auto_reconnect=self.config.MC_AUTO_RECONNECT,
                )

            # Read device info
            self._self_info = self.mc.self_info
            self._device_name = self._self_info.get('name', self.config.MC_DEVICE_NAME)
            self._connected = True

            # Store device info in database
            self.db.set_device_info(
                public_key=self._self_info.get('public_key', ''),
                name=self._device_name,
                self_info=str(self._self_info)
            )

            logger.info(f"Connected to device: {self._device_name} "
                        f"(key: {self._self_info.get('public_key', '?')[:8]}...)")

            # TODO Phase 1: subscribe to events here
            # self.mc.subscribe(EventType.CHANNEL_MSG_RECV, self._on_channel_message)
            # self.mc.subscribe(EventType.CONTACT_MSG_RECV, self._on_dm_received)
            # self.mc.subscribe(EventType.ADVERTISEMENT, self._on_advertisement)
            # etc.

        except Exception as e:
            logger.error(f"Device connection failed: {e}")
            self._connected = False
            # TODO: implement reconnect with backoff

    def execute(self, coro) -> Any:
        """
        Execute an async coroutine from sync Flask context.
        Blocks until the coroutine completes and returns the result.

        Usage from Flask route:
            contacts = device_manager.execute(device_manager.mc.ensure_contacts())
        """
        if not self._loop or not self._loop.is_running():
            raise RuntimeError("DeviceManager event loop not running")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=30)

    def stop(self):
        """Disconnect from device and stop the background thread."""
        logger.info("Stopping DeviceManager...")

        if self.mc and self._loop and self._loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(
                    self.mc.disconnect(), self._loop
                )
                future.result(timeout=5)
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")

        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)

        if self._thread:
            self._thread.join(timeout=5)

        self._connected = False
        self.mc = None
        logger.info("DeviceManager stopped")
