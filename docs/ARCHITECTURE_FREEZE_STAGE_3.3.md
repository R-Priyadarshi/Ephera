# ARCHITECTURE FREEZE: STAGE 3.3

Stage 3.3 is declared frozen.

Immutable Files and Components:
- receiver.js — protocol decoder; single lifecycle; abort/END terminal
- SessionManager.js — routing only; owns session creation/deletion
- TransferSession.js — per-transfer lifecycle; abort isolation
- app.js — wiring only; teardown order fixed
- client/test/* — authoritative regression and safety tests
