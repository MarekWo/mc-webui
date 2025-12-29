# Pending Contacts API - Technical Notes

## Overview

This document describes the implementation of pending contacts management API in `meshcore-bridge`. This feature enables manual approval of new contacts when `manual_add_contacts` mode is enabled in meshcli.

**Branch**: `dev-2`
**Status**: Implemented ✅ (API only, no UI yet)
**Date**: 2025-12-29

## Problem Statement

When meshcli runs with `manual_add_contacts on`, new contacts attempting to connect are placed in a "pending" state instead of being automatically added to the contacts list. This provides security benefits:

- **Control over network access** - Only approved contacts can communicate with the node
- **Prevention of spam/unwanted contacts** - Filter out random nodes attempting connection
- **Explicit trust model** - User decides who to trust on the mesh network

However, managing pending contacts required manual meshcli commands, which was inconvenient for web interface users.

## Solution

Added two new HTTP endpoints to `meshcore-bridge` for programmatic pending contact management:

1. **`GET /pending_contacts`** - List all contacts awaiting approval
2. **`POST /add_pending`** - Approve and add a specific pending contact

Both endpoints use the existing persistent meshcli session architecture (no new processes spawned).

## Implementation Details

### 1. Session Initialization

Modified `_init_session_settings()` in [meshcore-bridge/bridge.py:122-136](meshcore-bridge/bridge.py#L122-L136) to enable manual contact approval:

```python
def _init_session_settings(self):
    """Configure meshcli session for advert logging, message subscription, and manual contact approval"""
    if self.process and self.process.stdin:
        self.process.stdin.write('set json_log_rx on\n')
        self.process.stdin.write('set print_adverts on\n')
        self.process.stdin.write('set manual_add_contacts on\n')  # NEW
        self.process.stdin.write('msgs_subscribe\n')
        self.process.stdin.flush()
```

**Why in init?**
- Persistent setting - applies to entire session lifetime
- No need to re-enable after watchdog restart
- Consistent behavior across all API calls

### 2. GET /pending_contacts Endpoint

**Location**: [meshcore-bridge/bridge.py:499-565](meshcore-bridge/bridge.py#L499-L565)

**Purpose**: Retrieve list of contacts awaiting manual approval

**Request**:
```http
GET /pending_contacts HTTP/1.1
Host: meshcore-bridge:5001
```

**Response** (success):
```json
{
  "success": true,
  "pending": [
    {
      "name": "Skyllancer",
      "public_key": "f9ef123abc456..."
    },
    {
      "name": "KRA Reksio mob2🐕",
      "public_key": "41d5789def012..."
    }
  ],
  "raw_stdout": "Skyllancer: f9ef123abc456...\nKRA Reksio mob2🐕: 41d5789def012..."
}
```

**Response** (no pending contacts):
```json
{
  "success": true,
  "pending": [],
  "raw_stdout": ""
}
```

**Response** (error):
```json
{
  "success": false,
  "error": "meshcli session not initialized",
  "pending": []
}
```

**Implementation Notes**:

- Executes `pending_contacts` command via `MeshCLISession.execute_command()`
- Parses meshcli output format: `"ContactName: <hex_public_key>"`
- Removes spaces from public key hex (meshcli may insert spaces for readability)
- Only parses lines containing colon `:`
- Trims whitespace from contact names
- Returns empty array if no pending contacts exist
- Includes `raw_stdout` for debugging/troubleshooting

**Parsing Logic**:
```python
for line in stdout.split('\n'):
    line = line.strip()
    if ':' in line:
        parts = line.split(':', 1)
        if len(parts) == 2:
            name = parts[0].strip()
            public_key = parts[1].strip().replace(' ', '')
            if name and public_key:
                pending.append({'name': name, 'public_key': public_key})
```

### 3. POST /add_pending Endpoint

**Location**: [meshcore-bridge/bridge.py:568-629](meshcore-bridge/bridge.py#L568-L629)

**Purpose**: Approve and add a pending contact to the contacts list

**Request**:
```http
POST /add_pending HTTP/1.1
Host: meshcore-bridge:5001
Content-Type: application/json

{
  "selector": "Skyllancer"
}
```

**Selector formats supported** (by meshcli):
- Full contact name: `"Skyllancer"`
- Public key prefix: `"f9ef123"`
- Full public key: `"f9ef123abc456..."`

**Response** (success):
```json
{
  "success": true,
  "stdout": "Contact added successfully",
  "stderr": "",
  "returncode": 0
}
```

**Response** (validation error):
```json
{
  "success": false,
  "stdout": "",
  "stderr": "selector must be a non-empty string",
  "returncode": -1
}
```

**Implementation Notes**:

- Validates `selector` is non-empty string
- Trims whitespace from selector before execution
- Executes `add_pending <selector>` command via persistent session
- Returns full command result (stdout, stderr, returncode)
- Uses default timeout (10 seconds)

**Validation**:
```python
if not isinstance(selector, str) or not selector.strip():
    return jsonify({
        'success': False,
        'stderr': 'selector must be a non-empty string',
        'returncode': -1
    }), 400
```

## Testing

### Prerequisites

The bridge container must have:
1. `manual_add_contacts on` enabled (automatic in session init)
2. Pending contacts available (requires other nodes trying to connect)

### Test Commands

**From host or inside mc-webui container**:

```bash
# List pending contacts
curl -s http://meshcore-bridge:5001/pending_contacts | jq

# Add a pending contact by name
curl -s -X POST http://meshcore-bridge:5001/add_pending \
  -H 'Content-Type: application/json' \
  -d '{"selector":"Skyllancer"}' | jq

# Add by public key prefix
curl -s -X POST http://meshcore-bridge:5001/add_pending \
  -H 'Content-Type: application/json' \
  -d '{"selector":"f9ef123"}' | jq
```

**Expected workflow**:
1. New node attempts connection
2. `GET /pending_contacts` shows the node in pending list
3. `POST /add_pending` with node name/key approves the contact
4. `GET /pending_contacts` no longer shows the approved contact (moved to regular contacts)

## Architecture Benefits

### Reuses Persistent Session
- No new subprocess spawning
- Uses existing command queue (FIFO serialization)
- Same event-based synchronization mechanism
- Consistent error handling with other endpoints

### Thread-safe
- Commands queued through `queue.Queue()`
- Protected by `pending_lock` during response handling
- No race conditions with other CLI commands

### Consistent with /cli Endpoint
- Same request/response format
- Same timeout handling
- Same error reporting structure

## Future Work

### UI Integration (Next Phase)

**Planned features**:
1. **Pending Contacts Badge** - Notification icon showing count of pending contacts
2. **Pending Contacts Modal** - List view with approve/reject buttons
3. **Auto-refresh** - Poll `/pending_contacts` every 30-60 seconds
4. **Notifications** - Toast when new pending contacts appear

**UI Mockup**:
```
┌─────────────────────────────────────┐
│ Pending Contact Requests        [X] │
├─────────────────────────────────────┤
│ Skyllancer                          │
│ f9ef123abc...                       │
│          [Approve] [Reject]         │
├─────────────────────────────────────┤
│ KRA Reksio mob2🐕                   │
│ 41d5789def...                       │
│          [Approve] [Reject]         │
└─────────────────────────────────────┘
```

### Additional API Endpoints (Consideration)

**`POST /reject_pending`** - Reject a pending contact
```json
{
  "selector": "Skyllancer"
}
```

**`DELETE /pending_contacts`** - Flush all pending contacts
- Executes `flush_pending` meshcli command
- Useful for mass-reject after scanning for unwanted connections

### Settings Integration

Add UI toggle in Settings modal:
```
☑ Manual Contact Approval
  Require explicit approval for new contacts
```

This would execute:
```bash
# Enable
curl -X POST /cli -d '{"args":["set","manual_add_contacts","on"]}'

# Disable
curl -X POST /cli -d '{"args":["set","manual_add_contacts","off"]}'
```

## Security Considerations

### Why Manual Contact Approval?

1. **DoS Prevention** - Prevents flooding with fake contact requests
2. **Network Privacy** - Control who can see your node
3. **Trust Model** - Explicit approval creates stronger trust relationships
4. **Spam Filtering** - Reject unwanted contact attempts

### Trade-offs

**Pros**:
- Enhanced security and privacy
- User controls network access
- Prevents automatic addition of random nodes

**Cons**:
- Requires user interaction for every new contact
- May miss legitimate contacts if user doesn't check pending list regularly
- Additional management overhead

### Recommendation

**Use manual approval when**:
- Running on public/shared networks
- Privacy is a concern
- Network has history of spam/unwanted contacts
- Small, controlled mesh network

**Use auto-approval (default) when**:
- Private/trusted network environment
- Ease of use is priority
- Large mesh network where manual approval is impractical

## Meshcli Command Reference

### pending_contacts
```bash
meshcli> pending_contacts
Skyllancer: f9ef123abc456def789012345678901234567890abcdef
KRA Reksio mob2🐕: 41d5789def012345678901234567890abcdefabcdef012
```

### add_pending
```bash
# By name
meshcli> add_pending Skyllancer
Contact added successfully

# By public key prefix (first few chars)
meshcli> add_pending f9ef123
Contact added successfully

# By full public key
meshcli> add_pending f9ef123abc456def789012345678901234567890abcdef
Contact added successfully
```

### flush_pending
```bash
meshcli> flush_pending
All pending contacts removed
```

### Manual mode toggle
```bash
# Enable manual approval
meshcli> set manual_add_contacts on
manual_add_contacts set to on

# Disable (auto-approve)
meshcli> set manual_add_contacts off
manual_add_contacts set to off

# Check current setting
meshcli> get manual_add_contacts
manual_add_contacts: on
```

## Deployment

### Files Modified

1. **meshcore-bridge/bridge.py**
   - Added `manual_add_contacts on` to session init ([line 131](meshcore-bridge/bridge.py#L131))
   - Added `GET /pending_contacts` endpoint ([lines 499-565](meshcore-bridge/bridge.py#L499-L565))
   - Added `POST /add_pending` endpoint ([lines 568-629](meshcore-bridge/bridge.py#L568-L629))

2. **Dockerfile**
   - Added `curl` package for testing ([line 7](Dockerfile#L7))

3. **README.md**
   - Added "Testing Bridge API" section ([lines 362-406](README.md#L362-L406))
   - Documented endpoints with examples

### Commit

**Branch**: `dev-2`
**Commit**: `815adb5` - "feat(bridge): Add pending contacts management API endpoints"

### Deployment Steps

```bash
# On server
cd ~/mc-webui
git fetch
git checkout dev-2
git pull origin dev-2
docker compose up -d --build
```

### Verification

```bash
# Check logs for successful init
docker compose logs meshcore-bridge | grep manual_add_contacts
# Should see: "Session settings applied: ... manual_add_contacts=on ..."

# Test endpoint
docker exec mc-webui curl -s http://meshcore-bridge:5001/pending_contacts | jq
```

## References

- **meshcore-cli documentation**: [technotes/meshcore-cli.md](technotes/meshcore-cli.md)
- **Persistent session architecture**: [technotes/persistent-meshcli-session.md](technotes/persistent-meshcli-session.md)
- **Meshcli command reference**: `meshcli -h | grep pending` or `meshcli> ? pending_contacts`

---

**Author**: Claude Code (Anthropic)
**Date**: 2025-12-29
**Status**: API Implemented ✅ | UI Pending ⏳
