"""
Archive manager - handles message archiving and scheduling
"""

import os
import shutil
import logging
from pathlib import Path
from datetime import datetime, time
from typing import List, Dict, Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.config import config, runtime_config

logger = logging.getLogger(__name__)

# Global scheduler instance
_scheduler: Optional[BackgroundScheduler] = None

# Job IDs
CLEANUP_JOB_ID = 'daily_cleanup'


def get_local_timezone_name() -> str:
    """
    Get the local timezone name for display purposes.
    Uses TZ environment variable if set, otherwise detects from system.

    Returns:
        Timezone name (e.g., 'Europe/Warsaw', 'UTC', 'CET')
    """
    import os
    from datetime import datetime

    # First check TZ environment variable
    tz_env = os.environ.get('TZ')
    if tz_env:
        return tz_env

    # Fall back to system timezone detection
    try:
        # Try to get timezone name from datetime
        local_tz = datetime.now().astimezone().tzinfo
        if local_tz:
            tz_name = str(local_tz)
            # Clean up timezone name if needed
            if tz_name and tz_name != 'None':
                return tz_name
    except Exception:
        pass

    return 'local'


def get_archive_path(archive_date: str) -> Path:
    """
    Get the path to an archive file for a specific date.

    Args:
        archive_date: Date in YYYY-MM-DD format

    Returns:
        Path to archive file
    """
    archive_dir = config.archive_dir_path
    filename = f"{runtime_config.get_device_name()}.{archive_date}.msgs"
    return archive_dir / filename


def archive_messages(archive_date: Optional[str] = None) -> Dict[str, any]:
    """
    Archive messages for a specific date by copying the .msgs file.

    Args:
        archive_date: Date to archive in YYYY-MM-DD format.
                     If None, uses yesterday's date.

    Returns:
        Dict with success status and details
    """
    try:
        # Determine date to archive
        if archive_date is None:
            from datetime import date, timedelta
            yesterday = date.today() - timedelta(days=1)
            archive_date = yesterday.strftime('%Y-%m-%d')

        # Validate date format
        try:
            datetime.strptime(archive_date, '%Y-%m-%d')
        except ValueError:
            return {
                'success': False,
                'error': f'Invalid date format: {archive_date}. Expected YYYY-MM-DD'
            }

        # Ensure archive directory exists
        archive_dir = config.archive_dir_path
        archive_dir.mkdir(parents=True, exist_ok=True)

        # Get source .msgs file
        source_file = runtime_config.get_msgs_file_path()
        if not source_file.exists():
            logger.warning(f"Source messages file not found: {source_file}")
            return {
                'success': False,
                'error': f'Messages file not found: {source_file}'
            }

        # Get destination archive file
        dest_file = get_archive_path(archive_date)

        # Check if archive already exists
        if dest_file.exists():
            logger.info(f"Archive already exists: {dest_file}")
            return {
                'success': True,
                'message': f'Archive already exists for {archive_date}',
                'archive_file': str(dest_file),
                'exists': True
            }

        # Copy the file
        shutil.copy2(source_file, dest_file)

        # Get file size
        file_size = dest_file.stat().st_size

        logger.info(f"Archived messages to {dest_file} ({file_size} bytes)")

        return {
            'success': True,
            'message': f'Successfully archived messages for {archive_date}',
            'archive_file': str(dest_file),
            'file_size': file_size,
            'archive_date': archive_date
        }

    except Exception as e:
        logger.error(f"Error archiving messages: {e}", exc_info=True)
        return {
            'success': False,
            'error': str(e)
        }


def list_archives() -> List[Dict]:
    """
    List all available archive files with metadata.

    Returns:
        List of archive info dicts, sorted by date (newest first)
    """
    archives = []

    try:
        archive_dir = config.archive_dir_path

        # Check if archive directory exists
        if not archive_dir.exists():
            logger.info(f"Archive directory does not exist: {archive_dir}")
            return []

        # Pattern: {device_name}.YYYY-MM-DD.msgs
        pattern = f"{runtime_config.get_device_name()}.*.msgs"

        for archive_file in archive_dir.glob(pattern):
            try:
                # Extract date from filename
                # Format: DeviceName.YYYY-MM-DD.msgs
                filename = archive_file.name
                date_part = filename.replace(f"{runtime_config.get_device_name()}.", "").replace(".msgs", "")

                # Validate date format
                try:
                    datetime.strptime(date_part, '%Y-%m-%d')
                except ValueError:
                    logger.warning(f"Invalid archive filename format: {filename}")
                    continue

                # Get file stats
                stats = archive_file.stat()
                file_size = stats.st_size

                # Count messages (read file)
                message_count = _count_messages_in_file(archive_file)

                archives.append({
                    'date': date_part,
                    'file_size': file_size,
                    'message_count': message_count,
                    'file_path': str(archive_file)
                })

            except Exception as e:
                logger.warning(f"Error processing archive file {archive_file}: {e}")
                continue

        # Sort by date, newest first
        archives.sort(key=lambda x: x['date'], reverse=True)

        logger.info(f"Found {len(archives)} archive files")

    except Exception as e:
        logger.error(f"Error listing archives: {e}", exc_info=True)

    return archives


def _count_messages_in_file(file_path: Path) -> int:
    """
    Count the number of valid message lines in a file.

    Args:
        file_path: Path to the .msgs file

    Returns:
        Number of messages
    """
    import json

    count = 0
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    # Only count Public channel messages
                    if data.get('channel_idx', 0) == 0 and data.get('type') in ['CHAN', 'SENT_CHAN']:
                        count += 1
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.warning(f"Error counting messages in {file_path}: {e}")

    return count


def _archive_job():
    """
    Background job that runs daily to archive messages.
    This is called by the scheduler at midnight.
    """
    logger.info("Running daily archive job...")

    if not config.MC_ARCHIVE_ENABLED:
        logger.info("Archiving is disabled, skipping")
        return

    result = archive_messages()

    if result['success']:
        logger.info(f"Archive job completed: {result.get('message', 'Success')}")
    else:
        logger.error(f"Archive job failed: {result.get('error', 'Unknown error')}")


def _cleanup_job():
    """
    Background job that runs daily at 01:00 UTC to clean up contacts.
    Uses saved cleanup settings to filter and delete contacts.
    """
    logger.info("Running daily cleanup job...")

    try:
        # Import here to avoid circular imports
        from app.routes.api import (
            get_cleanup_settings,
            get_protected_contacts,
            _filter_contacts_by_criteria
        )

        # Get cleanup settings
        settings = get_cleanup_settings()

        if not settings.get('enabled'):
            logger.info("Auto-cleanup is disabled, skipping")
            return

        # Get contacts from device
        import requests
        response = requests.get(
            f"{config.BRIDGE_URL}/cli",
            json={'args': ['contacts']},
            timeout=30
        )

        if response.status_code != 200:
            logger.error(f"Failed to get contacts: HTTP {response.status_code}")
            return

        data = response.json()
        if not data.get('success'):
            logger.error(f"Failed to get contacts: {data.get('error', 'Unknown error')}")
            return

        # Parse contacts from output
        contacts = []
        output = data.get('output', '')
        import json as json_module
        for line in output.strip().split('\n'):
            if line.strip():
                try:
                    contact = json_module.loads(line)
                    contacts.append(contact)
                except json_module.JSONDecodeError:
                    continue

        if not contacts:
            logger.info("No contacts found, nothing to clean up")
            return

        # Filter contacts using saved criteria
        criteria = {
            'types': settings.get('types', [1, 2, 3, 4]),
            'date_field': settings.get('date_field', 'last_advert'),
            'days': settings.get('days', 30),
            'name_filter': settings.get('name_filter', '')
        }

        # Get protected contacts
        protected = get_protected_contacts()

        # Filter contacts (this function excludes protected contacts)
        matching_contacts = _filter_contacts_by_criteria(contacts, criteria, protected)

        if not matching_contacts:
            logger.info("No contacts match cleanup criteria")
            return

        logger.info(f"Found {len(matching_contacts)} contacts to clean up")

        # Delete matching contacts
        deleted_count = 0
        for contact in matching_contacts:
            name = contact.get('name', '')
            if not name:
                continue

            try:
                delete_response = requests.post(
                    f"{config.BRIDGE_URL}/cli",
                    json={'args': ['contact', '-d', name]},
                    timeout=30
                )

                if delete_response.status_code == 200:
                    delete_data = delete_response.json()
                    if delete_data.get('success'):
                        deleted_count += 1
                        logger.debug(f"Deleted contact: {name}")
                    else:
                        logger.warning(f"Failed to delete contact {name}: {delete_data.get('error')}")
                else:
                    logger.warning(f"Failed to delete contact {name}: HTTP {delete_response.status_code}")
            except Exception as e:
                logger.warning(f"Error deleting contact {name}: {e}")

        logger.info(f"Cleanup job completed: deleted {deleted_count}/{len(matching_contacts)} contacts")

    except Exception as e:
        logger.error(f"Cleanup job failed: {e}", exc_info=True)


def schedule_cleanup(enabled: bool, hour: int = 1) -> bool:
    """
    Add or remove the cleanup job from the scheduler.

    Args:
        enabled: True to enable cleanup job, False to disable
        hour: Hour (0-23, local time) at which to run cleanup job

    Returns:
        True if successful, False otherwise
    """
    global _scheduler

    if _scheduler is None:
        logger.warning("Scheduler not initialized, cannot schedule cleanup")
        return False

    try:
        if enabled:
            # Validate hour
            if not isinstance(hour, int) or hour < 0 or hour > 23:
                hour = 1

            # Add cleanup job at specified hour (local time)
            trigger = CronTrigger(hour=hour, minute=0)

            _scheduler.add_job(
                func=_cleanup_job,
                trigger=trigger,
                id=CLEANUP_JOB_ID,
                name='Daily Contact Cleanup',
                replace_existing=True
            )

            tz_name = get_local_timezone_name()
            logger.info(f"Cleanup job scheduled - will run daily at {hour:02d}:00 ({tz_name})")
        else:
            # Remove cleanup job if it exists
            try:
                _scheduler.remove_job(CLEANUP_JOB_ID)
                logger.info("Cleanup job removed from scheduler")
            except Exception:
                # Job might not exist, that's OK
                pass

        return True

    except Exception as e:
        logger.error(f"Error scheduling cleanup: {e}", exc_info=True)
        return False


def init_cleanup_schedule():
    """
    Initialize cleanup schedule from saved settings.
    Called at startup after scheduler is started.
    """
    try:
        # Import here to avoid circular imports
        from app.routes.api import get_cleanup_settings

        settings = get_cleanup_settings()

        if settings.get('enabled'):
            hour = settings.get('hour', 1)
            schedule_cleanup(enabled=True, hour=hour)
            tz_name = get_local_timezone_name()
            logger.info(f"Auto-cleanup enabled from saved settings (hour={hour:02d}:00 {tz_name})")
        else:
            logger.info("Auto-cleanup is disabled in saved settings")

    except Exception as e:
        logger.error(f"Error initializing cleanup schedule: {e}", exc_info=True)


def schedule_daily_archiving():
    """
    Initialize and start the background scheduler for daily archiving.
    Runs at midnight (00:00) local time.
    """
    global _scheduler

    if not config.MC_ARCHIVE_ENABLED:
        logger.info("Archiving is disabled in configuration")
        return

    if _scheduler is not None:
        logger.warning("Scheduler already initialized")
        return

    try:
        # Use local timezone (from TZ env variable or system default)
        tz_name = get_local_timezone_name()

        _scheduler = BackgroundScheduler(
            daemon=True
            # No timezone specified = uses system local timezone
        )

        # Schedule job for midnight every day (local time)
        trigger = CronTrigger(hour=0, minute=0)

        _scheduler.add_job(
            func=_archive_job,
            trigger=trigger,
            id='daily_archive',
            name='Daily Message Archive',
            replace_existing=True
        )

        _scheduler.start()

        logger.info(f"Archive scheduler started - will run daily at 00:00 ({tz_name})")

        # Initialize cleanup schedule from saved settings
        init_cleanup_schedule()

    except Exception as e:
        logger.error(f"Failed to start archive scheduler: {e}", exc_info=True)


def stop_scheduler():
    """
    Stop the background scheduler.
    Called during application shutdown.
    """
    global _scheduler

    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
            logger.info("Archive scheduler stopped")
        except Exception as e:
            logger.error(f"Error stopping scheduler: {e}")
        finally:
            _scheduler = None
