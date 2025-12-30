# API Diagnostic Commands - Quick Reference

**Server**: `192.168.1.2`
**SSH**: `ssh mcwebui@192.168.1.2`

**NOTE:** Replace the above example with your own server and credentials.

This cheatsheet contains useful commands for diagnosing mc-webui and meshcore-bridge using API endpoints.

---

## Table of Contents

1. [Health Checks](#health-checks)
2. [Contact Management](#contact-management)
3. [Device Information](#device-information)
4. [Channel Management](#channel-management)
5. [Messages](#messages)
6. [Direct Messages (DM)](#direct-messages-dm)
7. [Settings](#settings)
8. [Archives](#archives)

---

## Health Checks

### Check meshcore-bridge health
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://meshcore-bridge:5001/health | jq"
```
**Response**:
```json
{
  "status": "healthy",
  "serial_port": "/dev/serial/by-id/usb-Espressif_Systems_heltec_wifi_lora_32_v4__16_MB_FLASH__2_MB_PSRAM__90706984A000-if00",
  "advert_log": "/root/.config/meshcore/MarWoj.adverts.jsonl"
}
```

### Check mc-webui connection status
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/status | jq"
```
**Response**:
```json
{
  "success": true,
  "connected": true
}
```

---

## Contact Management

### Get all contacts (CLI type only, names only)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/contacts | jq"
```
**Response**:
```json
{
  "success": true,
  "count": 19,
  "contacts": [
    "SP7UNR_tdeck",
    "Kosu 🦜",
    "Arek",
    "daniel5120 🔫",
    "Szczwany-lis🦊"
  ]
}
```

### Get detailed contacts (all types with metadata + last_seen)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/contacts/detailed | jq"
```
**Response**:
```json
{
  "success": true,
  "count": 263,
  "limit": 350,
  "contacts": [
    {
      "name": "TK Zalesie Test 🦜",
      "public_key_prefix": "df2027d3f2ef",
      "type_label": "REP",
      "path_or_mode": "Flood",
      "last_seen": 1735429453,
      "raw_line": "TK Zalesie Test 🦜              REP   df2027d3f2ef  Flood"
    },
    {
      "name": "KRA C",
      "public_key_prefix": "d103df18e0ff",
      "type_label": "REP",
      "path_or_mode": "Flood",
      "last_seen": 1716206073
    }
  ]
}
```

### Get pending contacts (awaiting manual approval)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://meshcore-bridge:5001/pending_contacts | jq"
```
**Response**:
```json
{
  "success": true,
  "pending": [
    {
      "name": "C3396B62",
      "public_key": "c3396b628ba34b96138d962fda81e5e5450be14fa212793d55c71fba967a6262"
    }
  ],
  "raw_stdout": "MarWoj|* pending_contacts\nMarWoj|* \n           C3396B62: c3396b628ba34b96138d962fda81e5e5450be14fa212793d55c71fba967a6262"
}
```

Or via mc-webui API:
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/contacts/pending | jq"
```

### Delete a contact (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/contacts/delete \
  -H 'Content-Type: application/json' \
  -d '{\"selector\": \"df2027d3f2ef\"}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Contact removed successfully"
}
```

### Approve pending contact (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/contacts/pending/approve \
  -H 'Content-Type: application/json' \
  -d '{\"public_key\": \"c3396b628ba34b96138d962fda81e5e5450be14fa212793d55c71fba967a6262\"}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Contact approved successfully"
}
```

---

## Device Information

### Get device info
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/device/info | jq"
```
**Response**:
```json
{
  "success": true,
  "info": {
    "device_name": "MarWoj",
    "public_key": "11009cebbd2744d33c94b980b8f2475241fd2ca6165bd623e5ef00ec6982be6a...",
    "battery": "100%",
    "voltage": "4.20V"
  }
}
```

### Get device settings (persistent)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/device/settings | jq"
```
**Response**:
```json
{
  "success": true,
  "settings": {
    "manual_add_contacts": false
  }
}
```

### Update device settings (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/device/settings \
  -H 'Content-Type: application/json' \
  -d '{\"manual_add_contacts\": true}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "manual_add_contacts set to on",
  "settings": {
    "manual_add_contacts": true
  }
}
```

---

## Channel Management

### List all channels
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/channels | jq"
```
**Response**:
```json
{
  "success": true,
  "channels": [
    {
      "index": 0,
      "name": "Public",
      "key": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    },
    {
      "index": 1,
      "name": "Malopolska",
      "key": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
    }
  ]
}
```

### Get channel QR code (JSON format)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s 'http://192.168.1.2:5000/api/channels/1/qr?format=json' | jq"
```
**Response**:
```json
{
  "success": true,
  "qr_base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "channel": {
    "index": 1,
    "name": "Malopolska",
    "key": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
  }
}
```

### Create new channel (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/channels \
  -H 'Content-Type: application/json' \
  -d '{\"name\": \"TestChannel\"}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Channel created successfully",
  "channel": {
    "index": 2,
    "name": "TestChannel",
    "key": "auto-generated-key-here"
  }
}
```

### Delete channel (DELETE request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X DELETE \
  http://192.168.1.2:5000/api/channels/2 | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Channel removed successfully"
}
```

---

## Messages

### Get messages for current channel
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/messages | jq"
```
**Response**:
```json
{
  "success": true,
  "messages": [
    {
      "timestamp": 1735430000,
      "sender": "Kosu 🦜",
      "text": "Hello from mesh!",
      "type": "CHAN",
      "channel_idx": 1
    }
  ],
  "count": 1
}
```

### Get messages for specific channel
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s 'http://192.168.1.2:5000/api/messages?channel_idx=1' | jq"
```

### Get archived messages for specific date
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s 'http://192.168.1.2:5000/api/messages?archive_date=2025-12-28&channel_idx=1' | jq"
```

### Send message (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{\"text\": \"Test message\", \"channel_idx\": 1}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Message sent successfully"
}
```

### Check for new messages (smart refresh)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s 'http://192.168.1.2:5000/api/messages/updates?last_seen={\"0\":1735430000,\"1\":1735429000}' | jq"
```
**Response**:
```json
{
  "success": true,
  "updates": {
    "0": {
      "has_new": false,
      "unread_count": 0
    },
    "1": {
      "has_new": true,
      "unread_count": 3
    }
  },
  "total_unread": 3
}
```

---

## Direct Messages (DM)

### List DM conversations
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/dm/conversations | jq"
```
**Response**:
```json
{
  "success": true,
  "conversations": [
    {
      "conversation_id": "kosu_🦜",
      "display_name": "Kosu 🦜",
      "last_message_time": 1735430000,
      "unread_count": 2
    }
  ]
}
```

### Get DM messages for specific conversation
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s 'http://192.168.1.2:5000/api/dm/messages?conversation_id=kosu_🦜&limit=50' | jq"
```
**Response**:
```json
{
  "success": true,
  "messages": [
    {
      "timestamp": 1735430000,
      "sender": "Kosu 🦜",
      "recipient": "MarWoj",
      "text": "Private message text",
      "type": "PRIV",
      "pubkey_prefix": "df2027"
    }
  ]
}
```

### Send DM (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/dm/messages \
  -H 'Content-Type: application/json' \
  -d '{\"recipient\": \"Kosu 🦜\", \"text\": \"Test DM\"}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "DM sent successfully"
}
```

---

## Settings

### Trigger sync (force message refresh)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST http://192.168.1.2:5000/api/sync | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Sync triggered successfully"
}
```

### Send advert (normal)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/device/command \
  -H 'Content-Type: application/json' \
  -d '{\"command\": \"advert\"}' | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Command executed successfully"
}
```

### Send flood advert (use sparingly!)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST \
  http://192.168.1.2:5000/api/device/command \
  -H 'Content-Type: application/json' \
  -d '{\"command\": \"floodadv\"}' | jq"
```

---

## Archives

### List available archives
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/archives | jq"
```
**Response**:
```json
{
  "success": true,
  "archives": [
    {
      "date": "2025-12-28",
      "display_date": "28 December 2025",
      "file_path": "/mnt/archive/meshcore/2025-12-28.msgs"
    },
    {
      "date": "2025-12-27",
      "display_date": "27 December 2025",
      "file_path": "/mnt/archive/meshcore/2025-12-27.msgs"
    }
  ]
}
```

### Trigger manual archiving (POST request)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -X POST http://192.168.1.2:5000/api/archive/trigger | jq"
```
**Response**:
```json
{
  "success": true,
  "message": "Archive created successfully"
}
```

---

## Useful One-Liners

### Count contacts by type
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/contacts/detailed | jq '.contacts | group_by(.type_label) | map({type: .[0].type_label, count: length})'"
```
**Response**:
```json
[
  {"type": "CLI", "count": 17},
  {"type": "REP", "count": 226},
  {"type": "ROOM", "count": 20}
]
```

### Get only active contacts (last_seen < 1 hour)
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://192.168.1.2:5000/api/contacts/detailed | jq --arg now \"\$(date +%s)\" '.contacts | map(select(.last_seen and (\$now | tonumber) - .last_seen < 3600))'"
```

### Check total unread messages across all channels
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s 'http://192.168.1.2:5000/api/messages/updates?last_seen={}' | jq '.total_unread'"
```

### List pending contacts with full keys
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s http://meshcore-bridge:5001/pending_contacts | jq '.pending[] | {name, key: .public_key}'"
```

---

## Quick Troubleshooting

### Check if bridge is responding
```bash
ssh mcwebui@192.168.1.2 "docker exec mc-webui curl -s -w '\nHTTP Status: %{http_code}\n' http://meshcore-bridge:5001/health"
```

### Check if mc-webui is responding
```bash
ssh mcwebui@192.168.1.2 "curl -s -w '\nHTTP Status: %{http_code}\n' http://192.168.1.2:5000/api/status"
```

### View recent bridge logs
```bash
ssh mcwebui@192.168.1.2 "docker logs --tail 50 meshcore-bridge"
```

### View recent mc-webui logs
```bash
ssh mcwebui@192.168.1.2 "docker logs --tail 50 mc-webui"
```

### Follow logs in real-time
```bash
ssh mcwebui@192.168.1.2 "docker logs -f mc-webui"
```

### Check .msgs file size
```bash
ssh mcwebui@192.168.1.2 "ls -lh ~/.config/meshcore/MarWoj.msgs"
```

### Check .adverts.jsonl file size
```bash
ssh mcwebui@192.168.1.2 "ls -lh ~/.config/meshcore/MarWoj.adverts.jsonl"
```

---

## Notes

- **Port 5001** (meshcore-bridge): Internal only, accessible via `docker exec mc-webui`
- **Port 5000** (mc-webui): Publicly accessible on server
- All POST/DELETE requests require `Content-Type: application/json` header
- Use `jq` for pretty JSON formatting
- For debugging, add `-v` flag to curl for verbose output
- Response times should be < 500ms for most endpoints
- Bridge health endpoint includes serial port and advert log paths

---

**Last updated**: 2025-12-29
**mc-webui version**: Contact Management MVP v2 with "Last Seen" feature
