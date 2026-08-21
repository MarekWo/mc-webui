"""
Demo mode — read-only guard for a publicly shared instance.

mc-webui has no authentication: whoever reaches the port can rename the radio,
rewrite its frequency, wipe the address book or type into the console. That is
fine on a home LAN and not fine once the instance is handed to strangers, which
is what MC_DEMO=true is for.

The rules, in the order they are applied:

1. MC_DEMO off  → nothing changes, every request passes. Existing installs are
   untouched by this module.
2. Caller unlocked → every request passes. A caller is unlocked by coming from
   a network in MC_DEMO_TRUSTED_NETS, or by holding the cookie handed out for
   MC_DEMO_UNLOCK_CODE.
3. Otherwise → writes are refused (default deny, see WRITE_ALLOWLIST for the
   handful of things a visitor may still do), a few reads that hand out secrets
   are refused too (READ_DENYLIST), and the console accepts only the commands
   in CONSOLE_READONLY.

Default deny is the point. New endpoints are locked the day they are written
rather than the day someone remembers to add them to a list.
"""

import hmac
import ipaddress
import logging
import re
from hashlib import sha256
from typing import List, Optional

from app.config import config

logger = logging.getLogger(__name__)

# Cookie carrying the unlock proof. HttpOnly — the UI learns whether it is
# unlocked from /api/status, never by reading this back.
UNLOCK_COOKIE = 'mc_demo_unlock'
UNLOCK_COOKIE_MAX_AGE = 30 * 24 * 3600  # 30 days

# Domain separation, so the token cannot be replayed as some other HMAC.
_UNLOCK_MESSAGE = b'mc-webui-demo-unlock-v1'

# Error payload for a refused call. The frontend greys these controls out, so
# seeing this means either a stale page or a direct API call.
DEMO_ERROR = 'demo_locked'


# ================================================================
# What stays reachable while locked
# ================================================================

# Writes a visitor may still perform. Anything not listed here is refused.
# Chatting is the whole point of the demo, so sending stays open; every form
# of configuration does not.
WRITE_ALLOWLIST = [
    re.compile(r'^/api/messages$'),
    re.compile(r'^/api/messages/\d+/resend$'),
    re.compile(r'^/api/dm/messages$'),
    re.compile(r'^/api/read_status/mark_read$'),
    re.compile(r'^/api/read_status/mark_all_read$'),
    # The unlock endpoints themselves, or there is no way back in.
    re.compile(r'^/api/demo/unlock$'),
    re.compile(r'^/api/demo/lock$'),
]

# Reads refused while locked. These are GETs, so the write guard never sees
# them, and each one hands out something a visitor has no business holding:
# stored repeater admin passwords, a copy of the whole database, captured
# message text, or the server log.
READ_DENYLIST = [
    re.compile(r'^/api/repeaters/[^/]+/password$'),
    re.compile(r'^/api/backup/list$'),
    re.compile(r'^/api/backup/download$'),
    re.compile(r'^/api/diagnostics/captures/[^/]+/download$'),
    re.compile(r'^/api/logs$'),
]

# Console commands that only read. Everything else — every `set`, every form of
# transmit, every delete — is refused. `get_channel` is absent on purpose: it
# prints a channel's shared key. `clock` is absent because the same branch also
# sets the device clock.
CONSOLE_READONLY = frozenset({
    'infos', 'status', 'stats', 'bat', 'ver', 'help',
    'contacts', 'contacts_all', 'contact_info', 'pending_contacts',
    'channels', 'path', 'get',
})


# ================================================================
# Trusted networks
# ================================================================

def _parse_nets(raw: str) -> List[ipaddress._BaseNetwork]:
    """Parse the comma-separated CIDR list, skipping (and logging) bad entries."""
    nets = []
    for chunk in raw.split(','):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            nets.append(ipaddress.ip_network(chunk, strict=False))
        except ValueError:
            logger.warning("MC_DEMO_TRUSTED_NETS: ignoring unparseable entry %r", chunk)
    return nets


# Parsed once per distinct value of the setting rather than once per import, so
# the parse stays off the request path without freezing the config at import
# time — which is what lets the tests drive it.
_nets_cache: tuple = (None, [])   # (raw value it was parsed from, parsed nets)


def trusted_nets() -> List[ipaddress._BaseNetwork]:
    """The configured trusted networks, parsed."""
    global _nets_cache
    raw = config.MC_DEMO_TRUSTED_NETS or ''
    if _nets_cache[0] != raw:
        _nets_cache = (raw, _parse_nets(raw))
    return _nets_cache[1]


def _came_through_a_proxy(req) -> bool:
    """
    True when the request carries a hop header, i.e. the peer address belongs to
    a proxy or tunnel rather than to the client.
    """
    return any(
        h in req.headers
        for h in ('X-Forwarded-For', 'X-Real-IP', 'Forwarded', 'CF-Connecting-IP')
    )


def ip_is_trusted(req) -> bool:
    """
    True when the caller's address falls inside MC_DEMO_TRUSTED_NETS.

    The subtlety worth keeping: when the instance is published through a tunnel
    (cloudflared, ngrok, a VPN box) every visitor arrives from that tunnel's
    address. If the tunnel runs on the LAN, that address sits inside the very
    network the operator listed as trusted — and matching on it would unlock the
    instance for the whole internet at once. So an address is only accepted when
    it is genuinely the client's: either no hop header is present, or
    MC_TRUST_PROXY is on and ProxyFix has already replaced remote_addr with the
    real client address.
    """
    nets = trusted_nets()
    if not nets:
        return False
    if not config.MC_TRUST_PROXY and _came_through_a_proxy(req):
        return False

    addr = req.remote_addr
    if not addr:
        return False
    try:
        ip = ipaddress.ip_address(addr.split('%')[0])  # strip any zone id
    except ValueError:
        return False
    return any(ip in net for net in nets)


# ================================================================
# Unlock code
# ================================================================

def unlock_token() -> str:
    """The cookie value proving knowledge of MC_DEMO_UNLOCK_CODE."""
    return hmac.new(
        config.MC_DEMO_UNLOCK_CODE.encode('utf-8'), _UNLOCK_MESSAGE, sha256
    ).hexdigest()


def code_is_valid(code: Optional[str]) -> bool:
    """Constant-time check of a code typed by the user."""
    if not config.MC_DEMO_UNLOCK_CODE or not code:
        return False
    return hmac.compare_digest(code, config.MC_DEMO_UNLOCK_CODE)


def cookie_is_valid(req) -> bool:
    """Constant-time check of the unlock cookie."""
    if not config.MC_DEMO_UNLOCK_CODE:
        return False
    presented = req.cookies.get(UNLOCK_COOKIE)
    if not presented:
        return False
    return hmac.compare_digest(presented, unlock_token())


# ================================================================
# The decision
# ================================================================

def is_demo() -> bool:
    """True when this instance runs in demo mode at all."""
    return bool(config.MC_DEMO)


def is_unlocked(req) -> bool:
    """
    True when the caller may do anything — because demo mode is off, or because
    they proved they are the operator.
    """
    if not config.MC_DEMO:
        return True
    return ip_is_trusted(req) or cookie_is_valid(req)


def _matches(path: str, patterns) -> bool:
    return any(p.match(path) for p in patterns)


def request_is_blocked(req) -> bool:
    """
    True when this request must be refused. Call it from a before_request hook.
    """
    if is_unlocked(req):
        return False

    path = req.path.rstrip('/') or '/'

    if req.method in ('GET', 'HEAD', 'OPTIONS'):
        return _matches(path, READ_DENYLIST)

    return not _matches(path, WRITE_ALLOWLIST)


def console_command_is_blocked(command: str) -> bool:
    """
    True when a console command must be refused. `command` is the raw line; only
    its first word decides, which is the same thing the router dispatches on.
    """
    if not config.MC_DEMO:
        return False
    head = (command or '').strip().split()
    if not head:
        return False
    return head[0].lower() not in CONSOLE_READONLY


# ================================================================
# Startup reporting
# ================================================================

def log_startup_state() -> None:
    """
    Say plainly what the guard will do, once, at boot. A demo instance that
    quietly failed to lock looks exactly like one that locked correctly, so the
    log is the only place the difference shows up before a tester finds it.
    """
    if not config.MC_DEMO:
        return

    logger.info("Demo mode ON — writes are refused unless the caller is unlocked")

    nets = trusted_nets()
    if nets:
        logger.info(
            "Demo mode: trusted networks %s",
            ', '.join(str(n) for n in nets),
        )
        if not config.MC_TRUST_PROXY:
            logger.warning(
                "Demo mode: MC_DEMO_TRUSTED_NETS is set but MC_TRUST_PROXY is off. "
                "Requests arriving with a proxy/tunnel header will NOT be trusted by "
                "address, because that address would be the proxy's and not the "
                "visitor's. Set MC_TRUST_PROXY=true only if the app is reached "
                "exclusively through your proxy."
            )
    else:
        logger.info("Demo mode: no trusted networks configured")

    if config.MC_DEMO_UNLOCK_CODE:
        if len(config.MC_DEMO_UNLOCK_CODE) < 8:
            logger.warning(
                "Demo mode: MC_DEMO_UNLOCK_CODE is shorter than 8 characters — "
                "it is the only thing standing between a visitor and the radio"
            )
        else:
            logger.info("Demo mode: unlock code is set")
    else:
        logger.info("Demo mode: no unlock code set")

    if not nets and not config.MC_DEMO_UNLOCK_CODE:
        logger.warning(
            "Demo mode: neither MC_DEMO_TRUSTED_NETS nor MC_DEMO_UNLOCK_CODE is "
            "set — this instance is locked for everyone, including you"
        )
