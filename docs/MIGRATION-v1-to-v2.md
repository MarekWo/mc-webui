# Migration Guide: v1 to v2

## Overview

v2 replaces the `meshcore-cli` bridge with direct `meshcore` library communication. This changes how contacts and DMs work at a fundamental level.

## Breaking Changes

### 1. DM contacts must be re-added to the device

**Symptom**: Sending a DM to an existing contact fails with "Contact not on device".

**Why**: In v1, `meshcore-cli` acted as a bridge and managed contacts independently. In v2, `meshcore` communicates directly with the device firmware, which **requires** the contact to exist in its internal contact table (max 350 entries) to send a DM. After migration, the database has contacts from v1 advert history, but most of them were never added to the device's firmware contact table.

**Fix**: For each contact you want to DM:
1. Delete the contact from the Contacts page
2. Wait for their next advertisement
3. Approve the contact when it appears in the pending list

This adds the contact to the device's firmware table, enabling DM sending.

**Note**: Incoming DMs from any contact still work regardless — this only affects *sending* DMs.

### 2. Contact soft-delete preserves DM history

In v2, deleting a contact is a soft-delete (marked as `source='deleted'` in the database). This preserves DM conversation history. When the contact is re-added, it automatically "undeletes" and all previous DMs are visible again.

In v1, deleting a contact would orphan DM records (set `contact_pubkey = NULL`), causing "Unknown" entries in the DM list.

### 3. Database schema

v2 uses SQLite with WAL mode instead of flat JSON files. The migration from v1 data happens automatically on first startup (see `app/migrate_v1.py`). The v1 data files are preserved and not modified.

## Post-Migration Checklist

- [ ] Verify device connection (green "Connected" indicator)
- [ ] Check that channel messages are flowing normally
- [ ] For each DM contact you need: delete, wait for advert, re-approve
- [ ] Verify DM sending works with a test message
