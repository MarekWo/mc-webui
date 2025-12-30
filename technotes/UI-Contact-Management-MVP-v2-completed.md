# Contact Management MVP v2 - Implementation Complete

**Date**: 2025-12-29
**Status**: ✅ Completed (Pending Testing)
**Branch**: `dev-2`
**Related**: Builds on [UI-Contact-Management-MVP-v1-completed.md](UI-Contact-Management-MVP-v1-completed.md)

## Overview

Successfully implemented Contact Management MVP v2, which adds comprehensive management of existing contacts to the mc-webui interface. Users can now view, search, filter, and delete all contact types (CLI, REP, ROOM, SENS) with a mobile-first responsive UI.

## Requirements

Based on specification in `docs/UI-Contact-Management-MVP-v2.md`:

### Functional Requirements
1. **Existing Contacts Panel**
   - Display all contacts (CLI, REP, ROOM, SENS)
   - Show contact name, type, public key prefix, and path
   - Capacity counter (X / 350) with color-coded warnings
   - Delete functionality with confirmation modal

2. **Search and Filter**
   - Client-side search by name or public key prefix
   - Filter by contact type (All / CLI / REP / ROOM / SENS)
   - Real-time filtering as user types

3. **UX Requirements**
   - Mobile-first design (touch-friendly buttons)
   - Loading states (spinner/placeholder)
   - Delete confirmation modal (prevent accidental deletions)
   - Color-coded type badges for visual distinction

### Technical Requirements
- Use existing `/api/contacts/detailed` endpoint pattern
- Proxy to meshcore-bridge via HTTP (no direct meshcli access)
- Vanilla JavaScript (no frameworks)
- Bootstrap 5 for UI components
- All code comments in English

## Architecture

### New Components

```
Contact Management v2
├── Backend (mc-webui)
│   ├── app/meshcore/cli.py
│   │   ├── get_all_contacts_detailed()  → Parse meshcli contacts output
│   │   └── delete_contact(selector)      → Execute remove_contact command
│   └── app/routes/api.py
│       ├── GET /api/contacts/detailed    → Fetch all contacts with details
│       └── POST /api/contacts/delete     → Delete contact by selector
│
└── Frontend
    ├── app/templates/contacts.html
    │   ├── Existing Contacts section (search, filter, list, counter)
    │   └── Delete Confirmation Modal
    └── app/static/js/contacts.js
        ├── loadExistingContacts()
        ├── applyFilters()              → Search + type filter
        ├── renderExistingList()
        ├── createExistingContactCard()
        ├── showDeleteModal()
        └── confirmDelete()
```

## Implementation Details

### 1. Backend - Parser (`cli.py::get_all_contacts_detailed()`)

**Challenge**: Parse variable-width text table output from `meshcli contacts`

**Input format**:
```
MarWoj|* contacts
KRA C                          REP   d103df18e0ff  Flood
TK Zalesie Test 🦜              REP   df2027d3f2ef  Flood
daniel5120 🔫                   CLI   4563b1621b58  1e93d90faa7c2e49df8f
Szczwany-lis🦊                  CLI   02332896a4a6  Flood
> 263 contacts in device
```

**Parsing strategy**:
1. **Work backwards from end** - Rightmost columns have predictable format
2. **Use public_key_prefix as anchor** - 12 hex chars are unique and reliable
3. **Extract name carefully** - Handle spaces, Unicode, special chars
4. **Validate extracted data** - Check type and hex format

**Key code snippet**:
```python
def get_all_contacts_detailed() -> Tuple[bool, List[Dict], int, str]:
    """Parse meshcli contacts output into structured data"""

    # Split by whitespace
    parts = stripped.split()
    if len(parts) < 4:
        continue  # Malformed line

    # Extract from right to left
    path_or_mode = parts[-1]
    public_key_prefix = parts[-2]
    type_label = parts[-3]

    # Use public key as anchor to find name
    pubkey_pos = stripped.rfind(public_key_prefix)
    before_pubkey = stripped[:pubkey_pos].rstrip()

    # Type is last word before pubkey
    type_pos = before_pubkey.rfind(type_label)
    if type_pos != -1:
        name = before_pubkey[:type_pos].strip()

    # Validate
    if type_label not in ['CLI', 'REP', 'ROOM', 'SENS']:
        type_label = 'UNKNOWN'

    if not re.match(r'^[a-fA-F0-9]{12}$', public_key_prefix):
        continue  # Skip invalid

    contact = {
        'name': name,
        'public_key_prefix': public_key_prefix.lower(),
        'type_label': type_label,
        'path_or_mode': path_or_mode,
        'raw_line': line  # Preserve for debugging
    }
```

**Edge cases handled**:
- ✅ Unicode emoji in names (🦜, 🦊, 🔫, etc.)
- ✅ Polish characters (Łasin, Gdańsk)
- ✅ Spaces in names ("TK Zalesie Test 🦜")
- ✅ Type keyword in name ("CLI Test Node")
- ✅ Variable spacing between columns
- ✅ Hex path vs "Flood" mode
- ✅ Final count line extraction

**Testing**: Parsed 263 real contacts successfully (mix of CLI, REP, ROOM types with Unicode)

### 2. Backend - Delete Function (`cli.py::delete_contact()`)

**meshcli command**: `remove_contact <selector>`

**Implementation**:
```python
def delete_contact(selector: str) -> Tuple[bool, str]:
    """
    Delete a contact using meshcli remove_contact command.

    Args:
        selector: Contact selector (name, public_key_prefix, or full public key)
                 Using public_key_prefix is recommended for reliability.
    """
    success, stdout, stderr = _run_command(['remove_contact', selector.strip()])

    if success:
        message = stdout.strip() or f"Contact {selector} removed successfully"
        return True, message
    else:
        error = stderr.strip() or "Failed to remove contact"
        return False, error
```

**Selector options**:
- Name (works for most contacts)
- Public key prefix (12 hex chars - **recommended**)
- Full public key

**Recommendation**: Always use `public_key_prefix` for reliability across all contact types.

### 3. API Endpoints (`api.py`)

#### GET /api/contacts/detailed

Returns detailed list of ALL contacts (CLI, REP, ROOM, SENS).

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
      "raw_line": "..."
    }
  ]
}
```

**Notes**:
- Different from `/api/contacts` which returns only CLI contact names
- Provides complete metadata needed for UI rendering
- Includes device capacity info (count / limit)

#### POST /api/contacts/delete

Deletes a contact by selector.

**Request**:
```json
{
  "selector": "df2027d3f2ef"  // public_key_prefix recommended
}
```

**Response** (success):
```json
{
  "success": true,
  "message": "Contact removed successfully"
}
```

**Response** (error):
```json
{
  "success": false,
  "error": "Contact not found"
}
```

### 4. Frontend - HTML Template (`contacts.html`)

**Added sections**:

1. **Existing Contacts Section**
   - Header with counter badge and refresh button
   - Search input (filter by name or public_key_prefix)
   - Type filter dropdown (All / CLI / REP / ROOM / SENS)
   - Contact cards list (dynamically populated)
   - Loading/empty/error states

2. **Delete Confirmation Modal**
   - Bootstrap modal with danger theme
   - Shows contact name and public_key_prefix
   - Warns "This action cannot be undone"
   - Cancel / Delete Contact buttons

**CSS highlights**:
```css
/* Existing contact cards */
.existing-contact-card {
    background-color: white;
    border: 1px solid #dee2e6;
    border-radius: 0.5rem;
    padding: 1rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    transition: box-shadow 0.2s;
}

.existing-contact-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

/* Counter badge colors */
.counter-ok { background-color: #28a745; }      /* Green: < 300 */
.counter-warning { background-color: #ffc107; }  /* Yellow: 300-339 */
.counter-alarm { background-color: #dc3545; }    /* Red: >= 340 */

/* Pulse animation for alarm state */
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
}

.counter-alarm {
    animation: pulse 1.5s infinite;
}
```

**Type badge colors**:
- CLI: Blue (`bg-primary`)
- REP: Green (`bg-success`)
- ROOM: Cyan (`bg-info`)
- SENS: Yellow (`bg-warning`)

### 5. Frontend - JavaScript Logic (`contacts.js`)

**New state variables**:
```javascript
let existingContacts = [];    // All contacts from API
let filteredContacts = [];     // After applying search/filter
let contactToDelete = null;    // Contact pending deletion
```

**Key functions**:

#### loadExistingContacts()
```javascript
async function loadExistingContacts() {
    // Show loading state
    const response = await fetch('/api/contacts/detailed');
    const data = await response.json();

    existingContacts = data.contacts || [];
    filteredContacts = [...existingContacts];

    updateCounter(data.count, data.limit);
    applyFilters();  // Render with current filters
}
```

#### updateCounter()
```javascript
function updateCounter(count, limit) {
    counterEl.textContent = `${count} / ${limit}`;

    // Color logic
    if (count >= 340) {
        counterEl.classList.add('counter-alarm');  // Red pulsing
    } else if (count >= 300) {
        counterEl.classList.add('counter-warning'); // Yellow
    } else {
        counterEl.classList.add('counter-ok');       // Green
    }
}
```

#### applyFilters()
```javascript
function applyFilters() {
    const searchTerm = searchInput.value.toLowerCase();
    const selectedType = typeFilter.value;  // ALL, CLI, REP, ROOM, SENS

    filteredContacts = existingContacts.filter(contact => {
        // Type filter
        if (selectedType !== 'ALL' && contact.type_label !== selectedType) {
            return false;
        }

        // Search filter (name or public_key_prefix)
        if (searchTerm) {
            const nameMatch = contact.name.toLowerCase().includes(searchTerm);
            const keyMatch = contact.public_key_prefix.toLowerCase().includes(searchTerm);
            return nameMatch || keyMatch;
        }

        return true;
    });

    renderExistingList(filteredContacts);
}
```

#### createExistingContactCard()
```javascript
function createExistingContactCard(contact, index) {
    const card = document.createElement('div');
    card.className = 'existing-contact-card';

    // Name + Type badge
    const nameDiv = document.createElement('div');
    nameDiv.textContent = contact.name;

    const typeBadge = document.createElement('span');
    typeBadge.className = 'badge type-badge';
    typeBadge.textContent = contact.type_label;

    // Color-code by type
    switch (contact.type_label) {
        case 'CLI':  typeBadge.classList.add('bg-primary'); break;
        case 'REP':  typeBadge.classList.add('bg-success'); break;
        case 'ROOM': typeBadge.classList.add('bg-info'); break;
        case 'SENS': typeBadge.classList.add('bg-warning'); break;
    }

    // Public key
    const keyDiv = document.createElement('div');
    keyDiv.className = 'contact-key';
    keyDiv.textContent = contact.public_key_prefix;

    // Action buttons (Copy Key + Delete)
    const copyBtn = createButton('Copy Key', () => copyContactKey(...));
    const deleteBtn = createButton('Delete', () => showDeleteModal(contact));

    return card;
}
```

#### confirmDelete()
```javascript
async function confirmDelete() {
    const response = await fetch('/api/contacts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            selector: contactToDelete.public_key_prefix  // Use prefix for reliability
        })
    });

    if (data.success) {
        showToast(`Deleted: ${contactToDelete.name}`, 'success');
        modal.hide();

        // Reload contacts list
        setTimeout(() => loadExistingContacts(), 500);
    }
}
```

## User Workflows

### Workflow 1: View All Contacts

1. User navigates to Contact Management page
2. Page auto-loads existing contacts via `GET /api/contacts/detailed`
3. Parser extracts structured data from meshcli output
4. Frontend renders contact cards with:
   - Name (bold)
   - Type badge (color-coded)
   - Public key prefix (monospace)
   - Action buttons (Copy, Delete)
5. Counter badge shows "263 / 350" (green)

### Workflow 2: Search for a Contact

1. User types "Zalesie" in search box
2. `applyFilters()` triggered on input event
3. Filters `existingContacts` by:
   - Name contains "zalesie" (case-insensitive)
   - OR public_key_prefix contains "zalesie"
4. `renderExistingList()` re-renders with filtered results
5. Results update instantly as user types

### Workflow 3: Filter by Type

1. User selects "REP" from type dropdown
2. `applyFilters()` triggered on change event
3. Filters contacts where `type_label === 'REP'`
4. Only repeaters shown in list
5. Counter badge still shows total count (not filtered count)

### Workflow 4: Delete a Contact

1. User clicks red "Delete" button on contact card
2. `showDeleteModal(contact)` opens Bootstrap modal
3. Modal displays:
   - Contact name: "TK Zalesie Test 🦜"
   - Public key: "df2027d3f2ef"
   - Warning: "This action cannot be undone"
4. User clicks "Delete Contact" button
5. `confirmDelete()` sends `POST /api/contacts/delete`
6. Request body: `{"selector": "df2027d3f2ef"}`
7. Backend executes `meshcli remove_contact df2027d3f2ef`
8. On success:
   - Toast notification: "Deleted: TK Zalesie Test 🦜"
   - Modal closes
   - Contact list auto-refreshes after 500ms
9. Counter badge updates to "262 / 350"

### Workflow 5: Monitor Capacity

**Scenario A: Normal usage (< 300 contacts)**
- Counter badge: "150 / 350" (green background)
- No warnings

**Scenario B: Approaching limit (300-339 contacts)**
- Counter badge: "315 / 350" (yellow background)
- User notices warning color

**Scenario C: Critical (≥ 340 contacts)**
- Counter badge: "342 / 350" (red background, pulsing animation)
- User should delete some contacts soon

## Contacts Parser - Technical Deep Dive

### Problem

`meshcli contacts` outputs a text table with:
- Variable-width columns (not fixed positions)
- Names containing spaces, Unicode emoji, special chars
- No clear delimiters between columns

### Solution: Backward Parsing with Anchor

**Step 1**: Split by whitespace
```python
parts = stripped.split()
# ['TK', 'Zalesie', 'Test', '🦜', 'REP', 'df2027d3f2ef', 'Flood']
```

**Step 2**: Extract rightmost columns (predictable)
```python
path_or_mode = parts[-1]          # 'Flood'
public_key_prefix = parts[-2]     # 'df2027d3f2ef'
type_label = parts[-3]             # 'REP'
```

**Step 3**: Use public_key_prefix as anchor
```python
pubkey_pos = stripped.rfind('df2027d3f2ef')
# Find position in original string (preserves spacing)

before_pubkey = stripped[:pubkey_pos].rstrip()
# 'TK Zalesie Test 🦜              REP'
```

**Step 4**: Extract name (everything before type)
```python
type_pos = before_pubkey.rfind('REP')
name = before_pubkey[:type_pos].strip()
# 'TK Zalesie Test 🦜'
```

**Why this works**:
- Public key is unique 12-hex pattern (reliable anchor)
- Working from right to left avoids variable-length name issues
- Preserves Unicode by working with full strings
- Handles spaces in names naturally

### Validation

```python
# Type validation
if type_label not in ['CLI', 'REP', 'ROOM', 'SENS']:
    type_label = 'UNKNOWN'

# Public key format validation
if not re.match(r'^[a-fA-F0-9]{12}$', public_key_prefix):
    continue  # Skip malformed line
```

### Count Extraction

```python
# Extract total count from final line
# "> 263 contacts in device"
if line.strip().startswith('>') and 'contacts in device' in line:
    try:
        total_count = int(re.search(r'> (\d+) contacts', line).group(1))
    except:
        pass  # Fallback to len(contacts)
```

## Testing Plan

### Manual Testing Checklist

**Load contacts:**
- [ ] Open Contact Management page
- [ ] Verify contacts list loads
- [ ] Check counter badge shows correct count
- [ ] Verify counter color (green/yellow/red based on count)

**Search functionality:**
- [ ] Type contact name in search box
- [ ] Verify results filter in real-time
- [ ] Type public key prefix
- [ ] Verify filtering by key works
- [ ] Clear search box
- [ ] Verify all contacts reappear

**Type filter:**
- [ ] Select "CLI" from dropdown
- [ ] Verify only CLI contacts shown (blue badges)
- [ ] Select "REP"
- [ ] Verify only REP contacts shown (green badges)
- [ ] Select "ROOM"
- [ ] Verify only ROOM contacts shown (cyan badges)
- [ ] Select "All Types"
- [ ] Verify all contacts shown

**Delete contact:**
- [ ] Click "Delete" button on any contact
- [ ] Verify modal appears with correct contact info
- [ ] Click "Cancel"
- [ ] Verify modal closes, contact still in list
- [ ] Click "Delete" again
- [ ] Click "Delete Contact" button
- [ ] Verify success toast appears
- [ ] Verify contact removed from list
- [ ] Verify counter decrements

**Copy functionality:**
- [ ] Click "Copy Key" button
- [ ] Verify toast "Key copied to clipboard"
- [ ] Paste in text editor
- [ ] Verify correct public_key_prefix pasted

**Edge cases:**
- [ ] Test with 0 contacts (empty state)
- [ ] Test with 350 contacts (limit reached)
- [ ] Test with contacts containing Unicode
- [ ] Test network error (disconnect bridge)
- [ ] Test parser with malformed output

### Logging

Check logs for delete operations:

```bash
# mc-webui container
docker compose logs -f mc-webui | grep -i "delete"

# meshcore-bridge container (where remove_contact executes)
docker compose logs -f meshcore-bridge | grep -i "remove_contact"
```

**Expected log entries**:
```
mc-webui: POST /api/contacts/delete {"selector": "df2027d3f2ef"}
meshcore-bridge: Executing command: ['remove_contact', 'df2027d3f2ef']
meshcore-bridge: Command succeeded: Contact removed
```

## Documentation Updates

### README.md

Added new subsection "Existing Contacts" under Contact Management (lines 350-394):

**Documented**:
- Counter badge (green/yellow/red logic)
- Search functionality
- Type filter options
- Copy public key feature
- Delete workflow with warning
- Capacity monitoring guidelines

### Technotes

This file serves as comprehensive technical documentation for v2 implementation.

## Git Commit

**Branch**: dev-2
**Commit message** (to be created):
```
feat(ui): Contact Management v2 (existing contacts + delete + counter)

Implements existing contacts management as specified in
docs/UI-Contact-Management-MVP-v2.md:

Backend (mc-webui):
- Added contacts output parser in cli.py::get_all_contacts_detailed()
- Parses meshcli contacts table output (handles Unicode, spaces, variable width)
- Added cli.py::delete_contact(selector) wrapper for remove_contact command
- Added GET /api/contacts/detailed endpoint (all contact types with metadata)
- Added POST /api/contacts/delete endpoint (delete by selector)

Frontend:
- Extended contacts.html with Existing Contacts section
- Added search input (filter by name or public_key_prefix)
- Added type filter dropdown (All / CLI / REP / ROOM / SENS)
- Added contact cards with type badges (color-coded: CLI=blue, REP=green, ROOM=cyan, SENS=yellow)
- Added counter badge with capacity warnings (green < 300, yellow 300-339, red >= 340)
- Added delete confirmation modal (Bootstrap modal, danger theme)
- Implemented contacts.js logic (load, search, filter, delete)

Features:
- Mobile-first design (touch-friendly buttons, responsive cards)
- Real-time search and filtering (client-side)
- Capacity monitoring (X / 350 with color-coded warnings)
- Delete with confirmation (prevents accidental deletions)
- Copy public key to clipboard
- Loading/empty/error states

Parser:
- Best-effort parsing of variable-width text table
- Backward parsing strategy (work from right to left)
- Uses public_key_prefix as anchor for name extraction
- Handles Unicode emoji, Polish chars, spaces in names
- Validates type and hex format
- Tested with 263 real contacts (CLI, REP, ROOM mix)

Documentation:
- Updated README.md with Existing Contacts section
- Created technotes/UI-Contact-Management-MVP-v2-completed.md

Related: UI-Contact-Management-MVP-v1-completed.md
```

## "Last Seen" Feature Implementation

### Overview

After completing the basic Contact Management v2, an additional enhancement was requested to show when each contact was last active. This provides valuable information about which contacts are currently reachable on the mesh network.

### Requirements

**User Request**: "Czy na kafelku z kontaktem możemy dodać datę 'last seen'? Czy taka informacja jest łatwo dostępna?"

**Goal**: Display "last seen" timestamp on contact cards with:
- Relative time format ("5 minutes ago", "2 hours ago", etc.)
- Activity status indicators (🟢 active, 🟡 recent, 🔴 inactive)
- Data fetched from meshcli's `apply_to` command with `contact_info` filter

### Architecture

#### Data Source Discovery

Initial investigation found that `meshcli contacts` command only returns:
- NAME
- TYPE
- PUBKEY_PREFIX
- PATH_OR_MODE

**No timestamp information available.**

User discovered `apply_to t=TYPE contact_info` command which returns detailed JSON including:
- `last_advert` - Unix timestamp when contact was last seen
- `lastmod` - Unix timestamp when contact was last modified
- Full public_key, GPS coordinates, path info, etc.

**Decision**: Use `last_advert` as "last seen" timestamp (subject to future review).

#### Command Syntax

```bash
# Get detailed info for all CLI contacts
apply_to t=1 contact_info

# Get detailed info for all REP contacts
apply_to t=2 contact_info

# And so on for ROOM (t=3) and SENS (t=4)
```

**Important discoveries**:
1. **Comma-separated types DON'T WORK** through bridge: `apply_to t=1,t=2,t=3 contact_info` returns "0 matches"
2. **Output format is NDJSON** (newline-delimited JSON), not JSON array
3. **JSON is prettified** (multi-line), not strictly line-delimited
4. **Must call separately for each type**: t=1, t=2, t=3, t=4

#### Output Format (NDJSON)

```json
{
  "public_key": "df2027d3f2ef45a9...",
  "type": 2,
  "flags": 0,
  "out_path_len": 0,
  "out_path": "",
  "adv_name": "TK Zalesie Test 🦜",
  "last_advert": 1735429453,
  "adv_lat": 50.123456,
  "adv_lon": 19.654321,
  "lastmod": 1735428000
}
{
  "public_key": "d103df18e0ff12ab...",
  "type": 2,
  ...
}
```

### Implementation

#### Backend: NDJSON Parser (`cli.py::get_contacts_with_last_seen()`)

**Challenge**: Parse prettified NDJSON output where each JSON object spans multiple lines.

**Failed Approach #1**: Line-by-line parsing
```python
# Tried to parse each line as JSON - FAILED
# Prettified JSON breaks across multiple lines
for line in stdout.splitlines():
    try:
        contact = json.loads(line)  # JSONDecodeError!
```

**Failed Approach #2**: Skip non-JSON lines
```python
# Tried to detect JSON lines and skip prompts - FAILED
# Still doesn't handle multi-line JSON objects
if line.strip().startswith('{'):
    contact = json.loads(line)  # Still fails on prettified JSON
```

**Successful Approach #3**: Brace-matching algorithm
```python
def get_contacts_with_last_seen() -> Tuple[bool, Dict[str, Dict], str]:
    """
    Get detailed contact information including last_advert timestamps.
    Uses 'apply_to t=TYPE contact_info' command to fetch metadata
    for all contact types (CLI, REP, ROOM, SENS).
    """
    contacts_dict = {}

    # Call separately for each type (comma-separated doesn't work)
    for contact_type in ['t=1', 't=2', 't=3', 't=4']:
        success, stdout, stderr = _run_command(['apply_to', contact_type, 'contact_info'])

        if not success:
            logger.warning(f"apply_to {contact_type} contact_info failed: {stderr}")
            continue

        # Parse prettified JSON using brace-matching
        json_objects = []
        depth = 0
        start_idx = None

        # Walk character-by-character through output
        for i, char in enumerate(stdout):
            if char == '{':
                if depth == 0:
                    start_idx = i  # Mark start of JSON object
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0 and start_idx is not None:
                    # Found complete JSON object
                    json_str = stdout[start_idx:i+1]
                    try:
                        contact = json.loads(json_str)
                        if 'public_key' in contact:
                            json_objects.append(contact)
                    except json.JSONDecodeError:
                        pass  # Skip malformed JSON
                    start_idx = None

        # Add to contacts dict
        for contact in json_objects:
            contacts_dict[contact['public_key']] = contact

        logger.info(f"Parsed {len(json_objects)} contacts from {contact_type}")

    return True, contacts_dict, ""
```

**Why this works**:
- Depth counter tracks brace nesting level
- When depth reaches 0, we have a complete `{...}` object
- Handles both single-line and multi-line JSON
- Skips any prompt echoes or non-JSON text
- Works regardless of JSON formatting

**Test results**:
- ✅ 17 CLI contacts parsed (t=1)
- ✅ 226 REP contacts parsed (t=2)
- ✅ 20 ROOM contacts parsed (t=3)
- ✅ 0 SENS contacts parsed (t=4, none present)
- **Total: 263 contacts successfully parsed**

#### API Endpoint Enhancement (`api.py`)

Modified `GET /api/contacts/detailed` to merge `last_seen` data:

```python
@api_bp.route('/contacts/detailed', methods=['GET'])
def get_contacts_detailed_api():
    # Get basic contacts list
    success, contacts, total_count, error = cli.get_all_contacts_detailed()

    # Get detailed contact info with last_advert timestamps
    success_detailed, contacts_detailed, error_detailed = cli.get_contacts_with_last_seen()

    if success_detailed:
        # Merge last_advert data with contacts
        # Match by public_key_prefix (first 12 chars of full public_key)
        for contact in contacts:
            prefix = contact.get('public_key_prefix', '').lower()

            # Find matching contact in detailed data
            for full_key, details in contacts_detailed.items():
                if full_key.lower().startswith(prefix):
                    # Add last_seen timestamp
                    contact['last_seen'] = details.get('last_advert', None)
                    break
    else:
        # If detailed fetch failed, log warning but still return contacts without last_seen
        logger.warning(f"Failed to get last_seen data: {error_detailed}")

    return jsonify({
        'success': True,
        'contacts': contacts,
        'count': total_count,
        'limit': 350
    }), 200
```

**Matching strategy**:
- Use `public_key_prefix` (12 hex chars) from basic contacts list
- Match against full `public_key` from detailed data using `startswith()`
- Fallback gracefully if detailed fetch fails (contacts still shown without timestamps)

#### Frontend: Relative Time Display (`contacts.js`)

**Utility function #1**: Format Unix timestamp as relative time
```javascript
function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Never';

    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = now - timestamp;

    if (diffSeconds < 0) return 'Just now';  // Clock skew
    if (diffSeconds < 60) return 'Just now';
    if (diffSeconds < 3600) {
        const minutes = Math.floor(diffSeconds / 60);
        return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    }
    if (diffSeconds < 86400) {
        const hours = Math.floor(diffSeconds / 3600);
        return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    }
    if (diffSeconds < 2592000) {
        const days = Math.floor(diffSeconds / 86400);
        return `${days} day${days !== 1 ? 's' : ''} ago`;
    }
    if (diffSeconds < 31536000) {
        const months = Math.floor(diffSeconds / 2592000);
        return `${months} month${months !== 1 ? 's' : ''} ago`;
    }
    const years = Math.floor(diffSeconds / 31536000);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
}
```

**Utility function #2**: Get activity status indicator
```javascript
function getActivityStatus(timestamp) {
    if (!timestamp) {
        return {
            icon: '⚫',
            color: '#6c757d',
            title: 'Never seen'
        };
    }

    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = now - timestamp;

    // Active (< 5 minutes)
    if (diffSeconds < 300) {
        return {
            icon: '🟢',
            color: '#28a745',
            title: 'Active (seen recently)'
        };
    }

    // Recent (< 1 hour)
    if (diffSeconds < 3600) {
        return {
            icon: '🟡',
            color: '#ffc107',
            title: 'Recent activity'
        };
    }

    // Inactive (> 1 hour)
    return {
        icon: '🔴',
        color: '#dc3545',
        title: 'Inactive'
    };
}
```

**Contact card rendering**:
```javascript
// Last seen row (with activity status indicator)
const lastSeenDiv = document.createElement('div');
lastSeenDiv.className = 'text-muted small d-flex align-items-center gap-1';

if (contact.last_seen) {
    const status = getActivityStatus(contact.last_seen);
    const relativeTime = formatRelativeTime(contact.last_seen);

    const statusIcon = document.createElement('span');
    statusIcon.textContent = status.icon;
    statusIcon.style.fontSize = '0.9rem';
    statusIcon.title = status.title;  // Tooltip on hover

    const timeText = document.createElement('span');
    timeText.textContent = `Last seen: ${relativeTime}`;

    lastSeenDiv.appendChild(statusIcon);
    lastSeenDiv.appendChild(timeText);
} else {
    // No last_seen data available
    const statusIcon = document.createElement('span');
    statusIcon.textContent = '⚫';

    const timeText = document.createElement('span');
    timeText.textContent = 'Last seen: Unknown';

    lastSeenDiv.appendChild(statusIcon);
    lastSeenDiv.appendChild(timeText);
}

card.appendChild(lastSeenDiv);
```

### Debugging Journey

#### Problem #1: All contacts showing "Unknown"

**Symptom**: After initial implementation, all contacts showed "Last seen: Unknown"

**Logs**:
```
Executing command: ['apply_to', 't=1,t=2,t=3,t=4', 'contact_info']
Response: 0 matches in contacts
```

**Root cause**: Comma-separated types don't work through bridge

**Fix**: Separate calls for each type
```python
for contact_type in ['t=1', 't=2', 't=3', 't=4']:
    success, stdout, stderr = _run_command(['apply_to', contact_type, 'contact_info'])
```

#### Problem #2: NDJSON format not recognized

**Symptom**: Line-based parser returned 0 contacts despite receiving data

**User testing** (interactive session):
```bash
MarWoj|* apply_to t=1 contact_info
{
  "public_key": "4563b1621b58...",
  "type": 1,
  "adv_name": "daniel5120 🔫",
  "last_advert": 1734645823,
  ...
}
```

**Discovery**:
1. Output is prettified JSON (multi-line), not line-delimited
2. Command works interactively but comma syntax fails through bridge
3. Each contact is a separate JSON object (not array)

**Failed fix**: Line-by-line NDJSON parsing
```python
# Tried skipping non-JSON lines
for line in stdout.splitlines():
    if line.strip().startswith('{'):
        contact = json.loads(line)  # Still fails!
```

**Successful fix**: Brace-matching algorithm (see implementation above)

#### Problem #3: Timestamp accuracy question

**User observation**: "KRA C" (repeater connected at 0 hops) shows "Last seen: 1 year ago"

**Question**: Is `last_advert` the right field to use, or should we use `lastmod`?

**Status**: User will investigate at Meshcore source level and report back

**Current implementation**: Using `last_advert` field (can be changed to `lastmod` if needed)

### Test Results

**Production testing on http://192.168.131.80:5000:**

✅ **Data fetched successfully**:
- 17 CLI contacts parsed from t=1
- 226 REP contacts parsed from t=2
- 20 ROOM contacts parsed from t=3
- 0 SENS contacts parsed from t=4 (none exist)
- **Total: 263 contacts with timestamps**

✅ **UI displays correctly**:
- "TK Zalesie Test 🦜" shows 🟡 "Last seen: 52 minutes ago"
- "KRA C" shows 🔴 "Last seen: 1 year ago"
- Relative time formatting works (minutes, hours, days, months, years)
- Activity indicators show correct colors

✅ **Edge cases handled**:
- Contacts without timestamp show ⚫ "Unknown"
- Future timestamps (clock skew) show "Just now"
- Parser handles Unicode in names (emoji preserved)

### Commits

**Commit 1**: Initial "Last Seen" implementation
```
feat(contacts): Add 'Last Seen' timestamp display with activity indicators

- Added get_contacts_with_last_seen() in cli.py to fetch detailed contact info
- Uses 'apply_to t=TYPE contact_info' command for each contact type
- Merges last_advert timestamps with existing contacts list in API endpoint
- Added formatRelativeTime() and getActivityStatus() frontend functions
- Display relative time ("5 minutes ago") with color-coded indicators (🟢🟡🔴)
- Activity thresholds: < 5min active, < 1hr recent, > 1hr inactive
```

**Commit 2**: Debug logging added
```
debug(contacts): Add detailed logging to diagnose last_seen matching issue

- Added logging for command execution and response data
- Log contact counts parsed per type
- Preview first 500 chars of command output
```

**Commit 3**: Fix NDJSON parsing with separate calls
```
fix(contacts): Fix NDJSON parsing and use separate calls per contact type

- Changed from comma-separated t=1,t=2,t=3,t=4 to separate calls
- Implemented line-by-line NDJSON parsing
- Skip prompt echoes and summary lines
```

**Commit 4**: Brace-matching parser
```
debug(contacts): Change to brace-matching JSON parser with output preview

- Walk character-by-character looking for complete JSON objects
- Match opening/closing braces with depth counter
- Works for both single-line and prettified JSON
- Added output preview logging (first 500 chars)
```

**Commit 5**: Cleanup
```
cleanup(contacts): Remove debug logging from last_seen feature

- Removed excessive debug logging after successful implementation
- Kept essential info logging for monitoring
```

### Pending Items

1. **Timestamp field verification**: User to check at Meshcore source whether `last_advert` or `lastmod` is more appropriate for "last seen" display
2. **Performance monitoring**: Monitor API response time with 263 contacts (currently instant)
3. **Potential optimization**: Cache `contact_info` data for 30-60 seconds to reduce redundant calls

## Conclusion

Successfully implemented Contact Management v2, adding comprehensive existing contacts management to mc-webui:

✅ **Backend**:
- Robust parser for meshcli contacts output
- Handles Unicode, spaces, variable widths
- DELETE endpoint for contact removal
- NDJSON parser for `apply_to contact_info` output (brace-matching algorithm)
- Fetches detailed contact metadata including last_advert timestamps

✅ **Frontend**:
- Mobile-first responsive design
- Real-time search and filtering
- Color-coded counter badge (green/yellow/red)
- Delete confirmation modal
- Type badges for visual distinction
- "Last Seen" timestamps with relative time formatting
- Activity status indicators (🟢 active, 🟡 recent, 🔴 inactive, ⚫ unknown)

✅ **UX**:
- Touch-friendly buttons (min-height: 44px)
- Loading/empty/error states
- Toast notifications for feedback
- Clipboard copy functionality
- Relative time display ("5 minutes ago", "2 hours ago", etc.)
- Hover tooltips for activity status

✅ **Testing**:
- Parsed 263 real contacts successfully
- Handles all contact types (CLI, REP, ROOM, SENS)
- Unicode-safe (emoji, Polish chars)
- Fetched and displayed 263 timestamps (17 CLI + 226 REP + 20 ROOM)
- Brace-matching parser handles prettified multi-line JSON

✅ **Documentation**:
- README.md updated (added "Last Seen" feature description)
- .claude/instructions.md updated (added apply_to contact_info documentation)
- Complete technical notes (this file)

✅ **Commits**:
- 5 commits for "Last Seen" feature (initial impl, debug, fixes, cleanup)
- Complete git history documenting the debugging journey

**Status**: ✅ Implementation complete with "Last Seen" enhancement

**Pending**: User to verify timestamp field choice (last_advert vs lastmod) at Meshcore source level

**Next Steps**: User should merge dev-2 branch to dev after reviewing changes
