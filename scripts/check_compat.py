#!/usr/bin/env python3
"""
meshcore-cli compatibility checker for mc-webui

Tests all meshcli commands and response formats used by mc-webui
against the currently running meshcore-bridge instance.

Usage (from host, piped into mc-webui container):
    cd ~/mc-webui
    cat scripts/check_compat.py | docker compose exec -T mc-webui python -

    # Full mode (includes advert test):
    cat scripts/check_compat.py | docker compose exec -T mc-webui env FULL=1 python -
"""

import json
import os
import re
import sys
import time
import requests

DEFAULT_BRIDGE_URL = "http://meshcore-bridge:5001"

# Expected fields in .contacts JSON response (per contact entry)
EXPECTED_CONTACT_FIELDS = {
    "public_key", "type", "adv_name", "flags",
    "out_path_len", "out_path", "last_advert",
    "adv_lat", "adv_lon", "lastmod"
}

# Valid contact types in text format
VALID_CONTACT_TYPES = {"CLI", "REP", "ROOM", "SENS"}

# Expected fields in /health response
EXPECTED_HEALTH_FIELDS = {
    "status", "serial_port", "device_name", "device_name_source"
}

# Channel line format: "0: Public [8b3387e9c5cdea6ac9e5edbaa115cd72]"
CHANNEL_REGEX = re.compile(r'^(\d+):\s+(.+?)\s+\[([a-f0-9]{32})\]$')

# Contacts text format: columns separated by 2+ spaces
CONTACTS_SPLIT_REGEX = re.compile(r'\s{2,}')


class CompatChecker:
    """Checks meshcore-cli compatibility with mc-webui"""

    PASS = "PASS"
    WARN = "WARN"
    FAIL = "FAIL"
    SKIP = "SKIP"
    ERROR = "ERROR"

    def __init__(self, bridge_url, full_mode=False):
        self.bridge_url = bridge_url.rstrip('/')
        self.full_mode = full_mode
        self.results = []

    def run_command(self, args, timeout=10):
        """Send command to bridge /cli endpoint. Returns parsed JSON response."""
        resp = requests.post(
            f"{self.bridge_url}/cli",
            json={"args": args, "timeout": timeout},
            headers={"Connection": "close"},
            timeout=timeout + 5
        )
        resp.raise_for_status()
        return resp.json()

    def add(self, status, category, detail):
        """Record a test result."""
        self.results.append((status, category, detail))

    # ── Test methods ──────────────────────────────────────────────

    def test_health(self):
        """Test GET /health endpoint"""
        cat = "Bridge Health"
        try:
            resp = requests.get(f"{self.bridge_url}/health", timeout=5)
            resp.raise_for_status()
            data = resp.json()

            missing = EXPECTED_HEALTH_FIELDS - set(data.keys())
            if missing:
                self.add(self.FAIL, cat, f"missing fields: {', '.join(sorted(missing))}")
                return

            if data["status"] != "healthy":
                self.add(self.FAIL, cat, f"status={data['status']} (expected 'healthy')")
                return

            extra = set(data.keys()) - EXPECTED_HEALTH_FIELDS - {
                "serial_port_source", "advert_log", "echoes_log"
            }
            detail = f"status=healthy, device={data['device_name']}"
            if extra:
                self.add(self.WARN, cat, f"{detail} (new fields: {', '.join(sorted(extra))})")
            else:
                self.add(self.PASS, cat, detail)

        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_device_info(self):
        """Test infos and .infos commands"""
        for cmd in ["infos", ".infos"]:
            cat = f"Device Info ({cmd})"
            try:
                data = self.run_command([cmd], timeout=5)
                if not data.get("success"):
                    self.add(self.FAIL, cat, f"command failed: {data.get('stderr', '')}")
                    continue

                stdout = data.get("stdout", "").strip()
                if not stdout:
                    self.add(self.FAIL, cat, "empty response")
                    continue

                # Try to parse JSON from output
                json_obj = self._extract_json_object(stdout)
                if json_obj is None:
                    self.add(self.FAIL, cat, "no JSON object found in response")
                    continue

                if "name" not in json_obj:
                    self.add(self.FAIL, cat, f"'name' field missing from JSON (keys: {', '.join(json_obj.keys())})")
                else:
                    self.add(self.PASS, cat, f"JSON valid, name='{json_obj['name']}'")

            except Exception as e:
                self.add(self.ERROR, cat, str(e))

    def test_contacts_text(self):
        """Test contacts command (text format)"""
        cat = "Contacts (text)"
        try:
            data = self.run_command(["contacts"])
            if not data.get("success"):
                self.add(self.FAIL, cat, f"command failed: {data.get('stderr', '')}")
                return

            stdout = data.get("stdout", "").strip()
            if not stdout:
                self.add(self.WARN, cat, "empty response (no contacts on device)")
                return

            # Parse using same logic as cli.py parse_contacts()
            type_counts = {"CLI": 0, "REP": 0, "ROOM": 0, "SENS": 0}
            parsed = 0
            unparsed_lines = []

            for line in stdout.split('\n'):
                line_stripped = line.strip()
                if not line_stripped or line_stripped.startswith('---') or \
                   line.lower().startswith('contact') or line.startswith('INFO:'):
                    continue

                parts = CONTACTS_SPLIT_REGEX.split(line)
                if len(parts) >= 2:
                    contact_type = parts[1].strip()
                    if contact_type in VALID_CONTACT_TYPES:
                        type_counts[contact_type] += 1
                        parsed += 1
                        continue

                unparsed_lines.append(line_stripped[:60])

            if parsed == 0:
                self.add(self.FAIL, cat, "no contacts parsed - format may have changed")
                if unparsed_lines:
                    self.add(self.FAIL, cat, f"unparsed lines: {unparsed_lines[:3]}")
                return

            types_str = ", ".join(f"{k}={v}" for k, v in type_counts.items() if v > 0)
            detail = f"{parsed} contacts parsed, types: {types_str}"
            if unparsed_lines:
                self.add(self.WARN, cat, f"{detail} ({len(unparsed_lines)} unparsed lines: {unparsed_lines[:3]})")
            else:
                self.add(self.PASS, cat, detail)

        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_contacts_json(self):
        """Test .contacts command (JSON format)"""
        cat = "Contacts (JSON)"
        try:
            data = self.run_command([".contacts"])
            if not data.get("success"):
                self.add(self.FAIL, cat, f"command failed: {data.get('stderr', '')}")
                return

            stdout = data.get("stdout", "").strip()
            if not stdout:
                self.add(self.WARN, cat, "empty response (no contacts on device)")
                return

            # Parse JSON using brace-matching (same as cli.py)
            json_obj = self._extract_json_object(stdout)
            if json_obj is None:
                self.add(self.FAIL, cat, "no JSON object found in response")
                return

            if not isinstance(json_obj, dict):
                self.add(self.FAIL, cat, f"expected dict, got {type(json_obj).__name__}")
                return

            if len(json_obj) == 0:
                self.add(self.WARN, cat, "JSON valid but empty (no contacts)")
                return

            # Check fields in first contact entry
            first_key = next(iter(json_obj))
            first_contact = json_obj[first_key]

            if not isinstance(first_contact, dict):
                self.add(self.FAIL, cat, f"contact entry is {type(first_contact).__name__}, expected dict")
                return

            actual_fields = set(first_contact.keys())
            missing = EXPECTED_CONTACT_FIELDS - actual_fields
            extra = actual_fields - EXPECTED_CONTACT_FIELDS

            detail = f"{len(json_obj)} contacts, all expected fields present"
            if missing:
                self.add(self.FAIL, cat, f"missing fields: {', '.join(sorted(missing))}")
            elif extra:
                self.add(self.WARN, cat, f"{len(json_obj)} contacts OK (new fields: {', '.join(sorted(extra))})")
            else:
                self.add(self.PASS, cat, detail)

        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_contact_info(self):
        """Test apply_to t=1 contact_info command"""
        cat = "Contact Info (apply_to)"
        try:
            data = self.run_command(["apply_to", "t=1", "contact_info"])
            if not data.get("success"):
                self.add(self.FAIL, cat, f"command failed: {data.get('stderr', '')}")
                return

            stdout = data.get("stdout", "").strip()
            if not stdout:
                self.add(self.WARN, cat, "empty response (no CLI contacts)")
                return

            # contact_info returns multiple JSON objects (one per contact)
            json_count = 0
            for line in stdout.split('\n'):
                line = line.strip()
                if line.startswith('{'):
                    try:
                        json.loads(line)
                        json_count += 1
                    except json.JSONDecodeError:
                        pass

            if json_count > 0:
                self.add(self.PASS, cat, f"{json_count} contact info entries parsed")
            else:
                # Try brace-matching for multi-line JSON
                json_obj = self._extract_json_object(stdout)
                if json_obj is not None:
                    self.add(self.PASS, cat, "contact info JSON parsed (multi-line)")
                else:
                    self.add(self.WARN, cat, "command succeeded but no JSON found in output")

        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_channels(self):
        """Test get_channels command"""
        cat = "Channels"
        try:
            data = self.run_command(["get_channels"])
            if not data.get("success"):
                self.add(self.FAIL, cat, f"command failed: {data.get('stderr', '')}")
                return

            stdout = data.get("stdout", "").strip()
            if not stdout:
                self.add(self.FAIL, cat, "empty response (device should have at least Public channel)")
                return

            channels = []
            unparsed = []
            for line in stdout.split('\n'):
                line = line.strip()
                if not line:
                    continue
                match = CHANNEL_REGEX.match(line)
                if match:
                    channels.append({
                        'index': int(match.group(1)),
                        'name': match.group(2),
                        'key': match.group(3)
                    })
                else:
                    unparsed.append(line[:60])

            if not channels:
                self.add(self.FAIL, cat, "no channels parsed - format may have changed")
                if unparsed:
                    self.add(self.FAIL, cat, f"unparsed lines: {unparsed[:3]}")
                return

            names = ", ".join(f"{c['name']}(#{c['index']})" for c in channels)
            detail = f"{len(channels)} channels: {names}"
            if unparsed:
                self.add(self.WARN, cat, f"{detail} ({len(unparsed)} unparsed lines: {unparsed[:3]})")
            else:
                self.add(self.PASS, cat, detail)

        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_recv(self):
        """Test recv command (short timeout)"""
        cat = "Recv"
        try:
            # Use short timeout - we just want to verify the command is accepted
            data = self.run_command(["recv"], timeout=5)
            if not data.get("success"):
                stderr = data.get("stderr", "")
                # Timeout is acceptable for recv (no new messages)
                if "timeout" in stderr.lower():
                    self.add(self.PASS, cat, "command accepted (timed out - no new messages)")
                else:
                    self.add(self.FAIL, cat, f"command failed: {stderr}")
                return

            stdout = data.get("stdout", "").strip()
            if stdout:
                self.add(self.PASS, cat, f"command accepted ({len(stdout.split(chr(10)))} lines)")
            else:
                self.add(self.PASS, cat, "command accepted (no new messages)")

        except requests.exceptions.Timeout:
            # Timeout is acceptable for recv
            self.add(self.PASS, cat, "command accepted (HTTP timeout - normal for recv)")
        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_settings(self):
        """Test set commands used during bridge initialization"""
        settings = [
            (["set", "json_log_rx", "on"], "Settings (json_log_rx)"),
            (["set", "print_adverts", "on"], "Settings (print_adverts)"),
            (["msgs_subscribe"], "Settings (msgs_subscribe)"),
        ]

        for args, cat in settings:
            try:
                data = self.run_command(args, timeout=5)
                if data.get("success"):
                    self.add(self.PASS, cat, "accepted")
                else:
                    stderr = data.get("stderr", "")
                    stdout = data.get("stdout", "")
                    # Some settings return output but bridge marks as timeout
                    if "timeout" in stderr.lower() and not stdout:
                        self.add(self.WARN, cat, "possible timeout (no output)")
                    else:
                        self.add(self.FAIL, cat, f"failed: {stderr or stdout}")
            except Exception as e:
                self.add(self.ERROR, cat, str(e))

    def test_pending_contacts(self):
        """Test GET /pending_contacts bridge endpoint"""
        cat = "Pending Contacts"
        try:
            resp = requests.get(f"{self.bridge_url}/pending_contacts", timeout=10)
            resp.raise_for_status()
            data = resp.json()

            if "success" not in data:
                self.add(self.FAIL, cat, "response missing 'success' field")
                return

            if data.get("success"):
                contacts = data.get("contacts", data.get("pending", []))
                self.add(self.PASS, cat, f"endpoint OK ({len(contacts)} pending)")
            else:
                self.add(self.WARN, cat, f"endpoint returned success=false: {data.get('error', '')}")

        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    def test_advert(self):
        """Test advert command (has network side-effect)"""
        cat = "Advert"
        if not self.full_mode:
            self.add(self.SKIP, cat, "skipped (use --full to enable)")
            return

        try:
            data = self.run_command(["advert"], timeout=10)
            if data.get("success"):
                self.add(self.PASS, cat, "advertisement sent")
            else:
                self.add(self.FAIL, cat, f"failed: {data.get('stderr', '')}")
        except Exception as e:
            self.add(self.ERROR, cat, str(e))

    # ── Helpers ───────────────────────────────────────────────────

    def _extract_json_object(self, text):
        """Extract first complete JSON object from text using brace-matching."""
        depth = 0
        start_idx = None

        for i, char in enumerate(text):
            if char == '{':
                if depth == 0:
                    start_idx = i
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0 and start_idx is not None:
                    try:
                        return json.loads(text[start_idx:i + 1])
                    except json.JSONDecodeError:
                        start_idx = None
                        continue

        return None

    def _get_meshcli_version(self):
        """Try to get meshcore-cli version from bridge container."""
        try:
            data = self.run_command(["version"], timeout=5)
            if data.get("success") and data.get("stdout"):
                return data["stdout"].strip()
        except Exception:
            pass
        return "unknown"

    # ── Main runner ───────────────────────────────────────────────

    def run_all(self):
        """Run all tests and print report. Returns exit code."""
        print()
        print("meshcore-cli Compatibility Report")
        print("=" * 50)
        print(f"Bridge URL: {self.bridge_url}")
        print(f"Mode: {'full' if self.full_mode else 'safe (read-only)'}")
        print(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S')}")
        print()

        # Check bridge is reachable first
        try:
            requests.get(f"{self.bridge_url}/health", timeout=3)
        except Exception as e:
            print(f"[ERROR] Cannot reach bridge at {self.bridge_url}: {e}")
            print()
            print("Make sure meshcore-bridge is running:")
            print("  docker compose ps")
            print("  docker compose logs meshcore-bridge")
            return 1

        # Run all tests
        tests = [
            self.test_health,
            self.test_device_info,
            self.test_contacts_text,
            self.test_contacts_json,
            self.test_contact_info,
            self.test_channels,
            self.test_recv,
            self.test_settings,
            self.test_pending_contacts,
            self.test_advert,
        ]

        for test in tests:
            test()

        # Print results
        for status, category, detail in self.results:
            print(f"[{status:5s}] {category} - {detail}")

        # Summary
        counts = {s: 0 for s in [self.PASS, self.WARN, self.FAIL, self.SKIP, self.ERROR]}
        for status, _, _ in self.results:
            counts[status] += 1

        total_tests = counts[self.PASS] + counts[self.FAIL] + counts[self.ERROR]
        print()
        print(f"Result: {counts[self.PASS]}/{total_tests} PASS", end="")
        if counts[self.WARN]:
            print(f", {counts[self.WARN]} WARN", end="")
        if counts[self.FAIL]:
            print(f", {counts[self.FAIL]} FAIL", end="")
        if counts[self.ERROR]:
            print(f", {counts[self.ERROR]} ERROR", end="")
        if counts[self.SKIP]:
            print(f", {counts[self.SKIP]} SKIP", end="")
        print()

        has_failures = counts[self.FAIL] > 0 or counts[self.ERROR] > 0
        if has_failures:
            print()
            print("COMPATIBILITY ISSUES DETECTED - review FAIL/ERROR results above")

        return 1 if has_failures else 0


def main():
    bridge_url = os.environ.get("BRIDGE_URL", DEFAULT_BRIDGE_URL)
    full_mode = os.environ.get("FULL", "").lower() in ("1", "true", "yes")

    # Support --bridge-url and --full from command line too
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--bridge-url" and i + 1 < len(args):
            bridge_url = args[i + 1]
            i += 2
        elif args[i] == "--full":
            full_mode = True
            i += 1
        elif args[i] in ("-h", "--help"):
            print("Usage: check_compat.py [--bridge-url URL] [--full]")
            print(f"  --bridge-url  Bridge URL (default: {DEFAULT_BRIDGE_URL})")
            print(f"                Or set BRIDGE_URL env var")
            print(f"  --full        Include tests with network side-effects")
            print(f"                Or set FULL=1 env var")
            print()
            print("Run from host:")
            print("  cat scripts/check_compat.py | docker compose exec -T mc-webui python -")
            print("  cat scripts/check_compat.py | docker compose exec -T mc-webui env FULL=1 python -")
            sys.exit(0)
        else:
            i += 1

    checker = CompatChecker(bridge_url, full_mode)
    sys.exit(checker.run_all())


if __name__ == "__main__":
    main()
