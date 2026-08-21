"""
Unit tests for demo mode (MC_DEMO) — the read-only guard for a public instance.

What is worth pinning down here is not that the guard says no, but *when* it
says yes: the whole feature is one boolean away from either locking the owner
out of their own radio or leaving it open to everyone. So the tests cover the
three ways in (off, trusted network, unlock code), the default-deny behaviour
that makes a forgotten endpoint safe, and the tunnel case — where every visitor
shares the tunnel's address and matching on it would unlock the instance for
the entire internet at once.

Run: python -m pytest tests/test_demo_guard.py -v
"""

import pytest

from app import demo_guard
from app.config import config


class FakeRequest:
    """The four attributes demo_guard actually reads off a request."""

    def __init__(self, method='GET', path='/api/status', remote_addr='203.0.113.9',
                 headers=None, cookies=None):
        self.method = method
        self.path = path
        self.remote_addr = remote_addr
        self.headers = headers or {}
        self.cookies = cookies or {}


@pytest.fixture(autouse=True)
def demo_settings():
    """
    Every test starts from a locked demo with no way in, and restores the real
    config afterwards — these are class attributes on a singleton, so leaking
    them would corrupt every test that runs later.
    """
    saved = (
        config.MC_DEMO,
        config.MC_DEMO_TRUSTED_NETS,
        config.MC_DEMO_UNLOCK_CODE,
        config.MC_TRUST_PROXY,
    )
    config.MC_DEMO = True
    config.MC_DEMO_TRUSTED_NETS = ''
    config.MC_DEMO_UNLOCK_CODE = ''
    config.MC_TRUST_PROXY = False
    yield config
    (config.MC_DEMO, config.MC_DEMO_TRUSTED_NETS,
     config.MC_DEMO_UNLOCK_CODE, config.MC_TRUST_PROXY) = saved


# ================================================================
# Demo mode off — the guard must be completely inert
# ================================================================

class TestDisabled:

    def test_nothing_is_blocked_when_demo_is_off(self, demo_settings):
        demo_settings.MC_DEMO = False
        req = FakeRequest(method='POST', path='/api/device/config')
        assert demo_guard.request_is_blocked(req) is False
        assert demo_guard.is_unlocked(req) is True
        assert demo_guard.is_demo() is False

    def test_console_is_open_when_demo_is_off(self, demo_settings):
        demo_settings.MC_DEMO = False
        assert demo_guard.console_command_is_blocked('set name Whatever') is False


# ================================================================
# Default deny — the property that makes a forgotten endpoint safe
# ================================================================

class TestWriteGuard:

    @pytest.mark.parametrize('path', [
        '/api/device/config',        # the rename testers keep doing
        '/api/device/reboot',
        '/api/updater/trigger',      # rebuilds the containers
        '/api/channels',
        '/api/contacts/cleanup',
        '/api/db/vacuum',
        '/api/repeaters/abc123/action',
        '/api/observer/settings',
        '/api/diagnostics/start',
        '/api/retention-settings',   # no button in the UI, still reachable
        '/api/sync',
        '/api/an/endpoint/invented/tomorrow',
    ])
    def test_writes_are_refused(self, path):
        assert demo_guard.request_is_blocked(FakeRequest(method='POST', path=path)) is True

    @pytest.mark.parametrize('method', ['POST', 'PUT', 'DELETE', 'PATCH'])
    def test_every_write_verb_is_covered(self, method):
        req = FakeRequest(method=method, path='/api/channels/3')
        assert demo_guard.request_is_blocked(req) is True

    @pytest.mark.parametrize('path', [
        '/api/messages',
        '/api/messages/42/resend',
        '/api/dm/messages',
        '/api/read_status/mark_read',
        '/api/read_status/mark_all_read',
        '/api/demo/unlock',
        '/api/demo/lock',
    ])
    def test_chatting_and_unlocking_stay_open(self, path):
        """A demo nobody can send a message on is not a demo."""
        assert demo_guard.request_is_blocked(FakeRequest(method='POST', path=path)) is False

    def test_allowlist_is_anchored(self):
        """
        The patterns must match whole paths. Without the anchors,
        /api/messages/../device/config style prefixes would slip through.
        """
        req = FakeRequest(method='POST', path='/api/messages/bulk-delete')
        assert demo_guard.request_is_blocked(req) is True

    def test_trailing_slash_does_not_bypass(self):
        assert demo_guard.request_is_blocked(
            FakeRequest(method='POST', path='/api/device/config/')) is True


class TestReadGuard:

    @pytest.mark.parametrize('path', [
        '/api/status',
        '/api/messages',
        '/api/contacts',
        '/api/channels',
    ])
    def test_ordinary_reads_pass(self, path):
        assert demo_guard.request_is_blocked(FakeRequest(method='GET', path=path)) is False

    @pytest.mark.parametrize('path', [
        '/api/repeaters/abc123/password',            # hands out a stored password
        '/api/backup/list',
        '/api/backup/download',                      # the entire database
        '/api/diagnostics/captures/cap1/download',   # captured message text
        '/api/logs',
    ])
    def test_secret_bearing_reads_are_refused(self, path):
        assert demo_guard.request_is_blocked(FakeRequest(method='GET', path=path)) is True

    def test_head_is_treated_as_a_read(self):
        assert demo_guard.request_is_blocked(
            FakeRequest(method='HEAD', path='/api/backup/download')) is True


# ================================================================
# Trusted networks — including the tunnel trap
# ================================================================

class TestTrustedNetworks:

    def test_address_inside_a_trusted_net_is_unlocked(self, demo_settings):
        demo_settings.MC_DEMO_TRUSTED_NETS = '192.168.0.0/16'
        req = FakeRequest(method='POST', path='/api/device/config',
                          remote_addr='192.168.131.42')
        assert demo_guard.is_unlocked(req) is True
        assert demo_guard.request_is_blocked(req) is False

    def test_address_outside_is_still_locked(self, demo_settings):
        demo_settings.MC_DEMO_TRUSTED_NETS = '192.168.0.0/16'
        req = FakeRequest(method='POST', path='/api/device/config',
                          remote_addr='203.0.113.9')
        assert demo_guard.is_unlocked(req) is False

    def test_several_nets_and_junk_entries(self, demo_settings):
        """A typo in one entry must not throw away the others."""
        demo_settings.MC_DEMO_TRUSTED_NETS = '10.0.0.0/8, not-a-network, 172.16.0.0/12'
        assert demo_guard.ip_is_trusted(FakeRequest(remote_addr='10.1.2.3')) is True
        assert demo_guard.ip_is_trusted(FakeRequest(remote_addr='172.20.0.5')) is True
        assert demo_guard.ip_is_trusted(FakeRequest(remote_addr='8.8.8.8')) is False

    def test_ipv6(self, demo_settings):
        demo_settings.MC_DEMO_TRUSTED_NETS = 'fd00::/8'
        assert demo_guard.ip_is_trusted(FakeRequest(remote_addr='fd00::1')) is True

    def test_empty_list_trusts_nobody(self, demo_settings):
        demo_settings.MC_DEMO_TRUSTED_NETS = ''
        assert demo_guard.ip_is_trusted(FakeRequest(remote_addr='192.168.1.1')) is False

    # --- the trap ---

    def test_forwarded_request_is_not_trusted_by_address(self, demo_settings):
        """
        Published through a tunnel, every visitor arrives from the tunnel's own
        address. If the tunnel runs on the LAN, that address is inside the
        trusted net — and trusting it would unlock the instance for the whole
        internet. Without MC_TRUST_PROXY the address is therefore not the
        client's, and must not be matched.
        """
        demo_settings.MC_DEMO_TRUSTED_NETS = '192.168.0.0/16'
        demo_settings.MC_TRUST_PROXY = False
        req = FakeRequest(method='POST', path='/api/device/config',
                          remote_addr='192.168.131.5',           # the tunnel container
                          headers={'X-Forwarded-For': '203.0.113.9'})
        assert demo_guard.ip_is_trusted(req) is False
        assert demo_guard.request_is_blocked(req) is True

    @pytest.mark.parametrize('header', [
        'X-Forwarded-For', 'X-Real-IP', 'Forwarded', 'CF-Connecting-IP',
    ])
    def test_every_hop_header_disarms_address_matching(self, demo_settings, header):
        demo_settings.MC_DEMO_TRUSTED_NETS = '192.168.0.0/16'
        req = FakeRequest(remote_addr='192.168.1.5', headers={header: 'anything'})
        assert demo_guard.ip_is_trusted(req) is False

    def test_with_trust_proxy_on_the_resolved_address_counts(self, demo_settings):
        """
        With MC_TRUST_PROXY on, ProxyFix has already replaced remote_addr with the
        real client address, so matching it is correct again.
        """
        demo_settings.MC_DEMO_TRUSTED_NETS = '192.168.0.0/16'
        demo_settings.MC_TRUST_PROXY = True
        trusted = FakeRequest(remote_addr='192.168.131.42',
                              headers={'X-Forwarded-For': '192.168.131.42'})
        stranger = FakeRequest(remote_addr='203.0.113.9',
                               headers={'X-Forwarded-For': '203.0.113.9'})
        assert demo_guard.ip_is_trusted(trusted) is True
        assert demo_guard.ip_is_trusted(stranger) is False


# ================================================================
# Unlock code
# ================================================================

class TestUnlockCode:

    def test_correct_code_accepted_wrong_rejected(self, demo_settings):
        demo_settings.MC_DEMO_UNLOCK_CODE = 'correct horse battery'
        assert demo_guard.code_is_valid('correct horse battery') is True
        assert demo_guard.code_is_valid('correct horse batteryy') is False
        assert demo_guard.code_is_valid('') is False
        assert demo_guard.code_is_valid(None) is False

    def test_no_code_configured_means_no_code_works(self, demo_settings):
        """An empty MC_DEMO_UNLOCK_CODE must not be satisfiable by an empty guess."""
        demo_settings.MC_DEMO_UNLOCK_CODE = ''
        assert demo_guard.code_is_valid('') is False
        assert demo_guard.code_is_valid('anything') is False
        assert demo_guard.cookie_is_valid(
            FakeRequest(cookies={demo_guard.UNLOCK_COOKIE: ''})) is False

    def test_cookie_unlocks(self, demo_settings):
        demo_settings.MC_DEMO_UNLOCK_CODE = 'letmein-please'
        req = FakeRequest(method='POST', path='/api/device/config',
                          cookies={demo_guard.UNLOCK_COOKIE: demo_guard.unlock_token()})
        assert demo_guard.is_unlocked(req) is True
        assert demo_guard.request_is_blocked(req) is False

    def test_forged_cookie_does_not(self, demo_settings):
        demo_settings.MC_DEMO_UNLOCK_CODE = 'letmein-please'
        for value in ('', 'x' * 64, demo_guard.unlock_token()[:-1] + '0'):
            req = FakeRequest(cookies={demo_guard.UNLOCK_COOKIE: value})
            assert demo_guard.cookie_is_valid(req) is False

    def test_token_is_not_the_code(self, demo_settings):
        """The cookie must never carry the code itself — it is sent on every request."""
        demo_settings.MC_DEMO_UNLOCK_CODE = 'letmein-please'
        assert 'letmein-please' not in demo_guard.unlock_token()

    def test_changing_the_code_invalidates_old_cookies(self, demo_settings):
        demo_settings.MC_DEMO_UNLOCK_CODE = 'first-code'
        old = demo_guard.unlock_token()
        demo_settings.MC_DEMO_UNLOCK_CODE = 'second-code'
        assert demo_guard.cookie_is_valid(
            FakeRequest(cookies={demo_guard.UNLOCK_COOKIE: old})) is False


# ================================================================
# Console
# ================================================================

class TestConsole:

    @pytest.mark.parametrize('command', [
        'set name Tester',        # the rename, via the back door
        'set radio 869.525,250,11,5',
        'reboot',
        'remove_channel 2',
        'set_channel 1 name key',
        'remove_contact Someone',
        'floodadv',
        'advert',
        'msg Someone hello',
        'cmd Repeater reboot',
        'login Repeater hunter2',
        'time 1700000000',
        'get_channel 0',          # prints a channel's shared key
        'clock sync',
        'flush_pending',
        'reset_path Someone',
    ])
    def test_mutating_commands_are_refused(self, command):
        assert demo_guard.console_command_is_blocked(command) is True

    @pytest.mark.parametrize('command', [
        'infos', 'status', 'stats', 'bat', 'ver', 'help',
        'contacts', 'contacts_all', 'channels',
        'get name', 'get radio', 'path Someone', 'contact_info Someone',
    ])
    def test_readonly_commands_still_run(self, command):
        """The console stays worth showing off; it just cannot change anything."""
        assert demo_guard.console_command_is_blocked(command) is False

    def test_case_and_padding_do_not_bypass(self):
        for command in ('  SET name Tester', 'SeT name Tester', '\tREBOOT  '):
            assert demo_guard.console_command_is_blocked(command) is True

    def test_empty_command_is_not_blocked(self):
        """The handler answers 'Empty command' on its own; the guard stays out of it."""
        assert demo_guard.console_command_is_blocked('') is False
        assert demo_guard.console_command_is_blocked('   ') is False

    def test_readonly_set_is_a_subset_of_the_real_router(self):
        """
        Guard against a typo silently allowing nothing: every command named in
        CONSOLE_READONLY must be one the console router actually dispatches, or
        it is dead weight that reads as permissive and behaves as unknown.
        """
        import io
        import re

        source = io.open('app/main.py', encoding='utf-8').read()

        dispatched = set(re.findall(r"cmd == '([a-z_]+)'", source))
        for group in re.findall(r"cmd in \(([^)]*)\)", source):
            dispatched.update(re.findall(r"'([a-z_]+)'", group))

        missing = demo_guard.CONSOLE_READONLY - dispatched
        assert not missing, (
            f"CONSOLE_READONLY names commands the router has no branch for: {missing}"
        )
