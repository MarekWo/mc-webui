"""
Configuration module - loads settings from environment variables
"""

import os
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class Config:
    """Application configuration from environment variables"""

    # MeshCore device configuration
    MC_SERIAL_PORT = os.getenv('MC_SERIAL_PORT', '/dev/ttyUSB0')
    MC_DEVICE_NAME = os.getenv('MC_DEVICE_NAME', 'MeshCore')
    MC_CONFIG_DIR = os.getenv('MC_CONFIG_DIR', '/root/.config/meshcore')

    # MC_BRIDGE_URL removed in v2 (direct device communication)

    # Archive configuration (v1 — archives move to SQLite in v2)
    MC_ARCHIVE_DIR = os.getenv('MC_ARCHIVE_DIR', '/root/.archive/meshcore')
    MC_ARCHIVE_ENABLED = os.getenv('MC_ARCHIVE_ENABLED', 'true').lower() == 'true'
    MC_ARCHIVE_RETENTION_DAYS = int(os.getenv('MC_ARCHIVE_RETENTION_DAYS', '7'))

    # v2: Database
    MC_DB_PATH = os.getenv('MC_DB_PATH', '')  # empty = auto: {MC_CONFIG_DIR}/mc_{pubkey_prefix}.db

    # v2: TCP connection (alternative to serial, e.g. meshcore-proxy)
    MC_TCP_HOST = os.getenv('MC_TCP_HOST', '')  # empty = use serial
    MC_TCP_PORT = int(os.getenv('MC_TCP_PORT', '5555'))

    # v2: BLE connection (alternative to serial/TCP, for BLE companion devices)
    # Device must be paired and trusted on host before starting (see docs/meshcore_bluetooth_pairing.md)
    MC_BLE_ADDRESS = os.getenv('MC_BLE_ADDRESS', '')  # BLE MAC address or device name filter

    # v2: Backup
    MC_BACKUP_ENABLED = os.getenv('MC_BACKUP_ENABLED', 'true').lower() == 'true'
    MC_BACKUP_HOUR = int(os.getenv('MC_BACKUP_HOUR', '2'))
    MC_BACKUP_RETENTION_DAYS = int(os.getenv('MC_BACKUP_RETENTION_DAYS', '7'))

    # v2: Connection
    MC_AUTO_RECONNECT = os.getenv('MC_AUTO_RECONNECT', 'true').lower() == 'true'
    MC_LOG_LEVEL = os.getenv('MC_LOG_LEVEL', 'INFO')

    # Flask server configuration
    FLASK_HOST = os.getenv('FLASK_HOST', '0.0.0.0')
    FLASK_PORT = int(os.getenv('FLASK_PORT', '5000'))
    FLASK_DEBUG = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'

    # Derived paths
    @property
    def msgs_file_path(self) -> Path:
        """Get the full path to the .msgs file"""
        return Path(self.MC_CONFIG_DIR) / f"{self.MC_DEVICE_NAME}.msgs"

    @property
    def archive_dir_path(self) -> Path:
        """Get the full path to archive directory"""
        return Path(self.MC_ARCHIVE_DIR)

    @property
    def db_path(self) -> Path:
        """Get SQLite database path"""
        if self.MC_DB_PATH:
            return Path(self.MC_DB_PATH)
        return Path(self.MC_CONFIG_DIR) / 'mc-webui.db'

    @property
    def use_ble(self) -> bool:
        """True if BLE transport should be used (highest priority)"""
        return bool(self.MC_BLE_ADDRESS)

    @property
    def use_tcp(self) -> bool:
        """True if TCP transport should be used instead of serial"""
        return bool(self.MC_TCP_HOST)

    @property
    def transport_type(self) -> str:
        """Return active transport type: 'ble', 'tcp', or 'serial'"""
        if self.use_ble:
            return 'ble'
        if self.use_tcp:
            return 'tcp'
        return 'serial'

    def __repr__(self):
        if self.use_ble:
            transport = f"ble={self.MC_BLE_ADDRESS}"
        elif self.use_tcp:
            transport = f"tcp={self.MC_TCP_HOST}:{self.MC_TCP_PORT}"
        else:
            transport = f"serial={self.MC_SERIAL_PORT}"
        return (
            f"Config(device={self.MC_DEVICE_NAME}, "
            f"{transport}, "
            f"config_dir={self.MC_CONFIG_DIR})"
        )


# Global config instance
config = Config()


class RuntimeConfig:
    """
    Runtime configuration that can be updated after startup.

    Used for values that are detected/fetched at runtime, like
    device name from bridge auto-detection.
    """
    _device_name: Optional[str] = None
    _device_name_source: str = "config"

    @classmethod
    def set_device_name(cls, name: str, source: str = "detected"):
        """Set the runtime device name"""
        cls._device_name = name
        cls._device_name_source = source
        logger.info(f"Runtime device name set: {name} (source: {source})")

    @classmethod
    def get_device_name(cls) -> str:
        """Get device name - prefers runtime value, falls back to config"""
        return cls._device_name or config.MC_DEVICE_NAME

    @classmethod
    def get_device_name_source(cls) -> str:
        """Get the source of the device name (detected/config/fallback)"""
        return cls._device_name_source

    @classmethod
    def get_msgs_file_path(cls) -> Path:
        """Get the full path to the .msgs file using runtime device name"""
        return Path(config.MC_CONFIG_DIR) / f"{cls.get_device_name()}.msgs"


# Global runtime config instance
runtime_config = RuntimeConfig()
