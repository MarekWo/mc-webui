# mc-webui v2 — Development Status

## Current Status: Planning Phase 0

**Last updated:** 2026-02-28

## Completed

### PRD (Product Requirements Document)
- Created comprehensive PRD with architecture decisions
- Resolved all 5 open questions:
  1. **Console:** meshcli-compatible syntax with structured output (tables/cards)
  2. **TCP transport:** YES — dual transport via `MeshCore.create_tcp()` (PR #22)
  3. **Multi-device:** YES — `DeviceRegistry` pattern, Phase 4
  4. **WebSocket push:** YES — Flask-SocketIO `/chat` namespace replaces polling
  5. **Backup:** YES — built-in SQLite backup with API endpoint
- Confirmed Raspberry Pi 3+ compatibility (lower resource usage than v1)
- Documents:
  - `docs/PRD-mc-webui-2.md` (source, 713 lines)
  - `docs/PRD-mc-webui-2-en.html` (shareable English)
  - `docs/PRD-mc-webui-2-pl.html` (shareable Polish)

### Key Architecture Decisions
- **Branch strategy:** In-place evolution on `v2` branch (not a new repo)
- **Database:** SQLite with WAL mode (replacing JSONL files)
- **Container:** Single container (replacing two-container bridge)
- **Framework:** Flask kept (with Flask-SocketIO added)
- **Device communication:** `meshcore` Python library (>=2.2.0) — direct async API

## Development Phases

| Phase | Name | Status |
|-------|------|--------|
| 0 | Infrastructure & Foundation | **Planning** |
| 1 | Direct Device Communication | Pending |
| 2 | Feature Parity + Enhancements | Pending |
| 3 | Advanced Features | Pending |
| 4 | Multi-device & Scaling | Pending |

## Next Steps
- Create detailed implementation plan for Phase 0
- Phase 0 scope: v2 branch, SQLite schema, Database class, project structure, env config
