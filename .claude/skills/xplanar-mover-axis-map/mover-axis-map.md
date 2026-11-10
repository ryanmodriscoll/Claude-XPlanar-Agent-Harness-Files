# Mover -> axis map (TwinCAT Project1)

Last verified: 2026-11-05 (second pass; Mover4330_1 was added since the first pass). Re-verify with the workflow in SKILL.md if the project may have changed.

Movers set up: 3 (two APM4220, one APM4330)

| TcCOM mover (tid) | TcCOM OID | NC axis (tid) | NC axis OID | PLC FB instance | Link used |
|-|-|-|-|-|-|
| Mover4220_1 (1388) | #x01010070 | Mover4220_1 (1339) | #x05110010 | MAIN.fbMover1 | NC3ToHW linked with `TINC^XPlanar MC Project^Axes^Mover4220_1^McToIo^STD` |
| Mover4220_2 (1389) | #x01010080 | Mover4220_2 (1340) | #x05110020 | MAIN.fbMover2 | NC3ToHW linked with `TINC^XPlanar MC Project^Axes^Mover4220_2^McToIo^STD` |
| Mover4330_1 (2344) | #x010100b0 | Mover4330_1 (2355) | #x05110030 (oid 85000240) | MAIN.fbMover3 (added and linked 2026-11-05) | NC3ToHW (tid 2353) linked with `TINC^XPlanar MC Project^Axes^Mover4330_1^McToIo^STD` |

Notes:
- `get_mappings` shows only fbMover1 and fbMover2 (12 mappings); Mover4330_1 has no PLC variable mapping.
- TcCOM mover BTN for Mover4220_1 is `0000m001` (others not read).
- Movers sit on Part1 (movement area OID 16842784).
- Project info reports "8 Motion axes", but only 3 axes exist under NC Axes; trust the tree.
