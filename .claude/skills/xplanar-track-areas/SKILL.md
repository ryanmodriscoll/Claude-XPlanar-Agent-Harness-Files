---
name: xplanar-track-areas
description: List the XPlanar tracks (Planar Track group objects) set up in the open TwinCAT project and the area each one covers on the tile layout. Use when asked what tracks exist, where the tracks run, or what area/footprint a track covers. Helper skill: complementary to the main workflow skill plc-engineering-loop.
---

# XPlanar tracks and the area they cover

Tracks are NOT under TcCOM Objects > XPlanar. They are NC "Planar Track" group objects under the XPlanar MC Project. Their static config (ParameterValues) has NO geometry: "Geometric information" is empty and "Track length"/"Geometric online information" are online-only parameters. Geometry is created at runtime by PLC code, so the covered area comes from the PLC track builder (or from the live target if it is running).

## Workflow

1. `list_projects` -> `pid`.
2. Find the NC groups: `get_treeitems(pid, tid=8)` (MOTION) -> NC task (itemtype 19) -> `Groups` (itemtype 72 children, tid 27 here). Children named `Track*` (itemsubtype 72) are the tracks. Ignore `XPlanar` and `Environment` groups (not tracks).
3. For each track:
   - `get_treeiteminfo(pid, track_tid)` returns ~30k chars inline (Planar Track, OTCID e.g. #x05120030). Only `ParameterValues` matters: `PartOID` (16842784 = Part1), `Closed loop`, `Maximal mover width/height`, collision range.
   - Find the PLC link: `get_treeitems(track_tid)` -> `McToPlc` -> `STD`, then `get_treeiteminfo` on `STD` (small). `VarDef.LinkedWith` is the PLC variable (e.g. `MAIN.fbTrack.MCTOPLC_STD`). No `LinkedWith` = no PLC drives that track.
4. Find the geometry in the PLC: `plc_structure` on the PLC project node, then `plc_read_code` on the track builder FB (`FB_PlanarTrackBuilder`), `MAIN`, and `GVL_PlanarDemo` for the constants (`rTileSize`, `rCornerRadius`, `rTrackGap`, `rSqrtHalf`). Match the FB instance linked in step 3 (e.g. `fbTrack`) to the builder that calls `AppendLine/AppendCircle` on it, and compute the segment coordinates from the code.
   - Tracks with no PLC link and no builder have NO defined geometry yet: report that, do not invent an area.
5. Optional live check: if the PLC is running, `ads_list_symbols`/`ads_read_symbol` (netId from the session, default BTN-000u9b75 `10.1.176.115.1.1`) on `MAIN.fbTrack` for `MCTOPLC_STD.State`. The online "Track length" and "Geometric online information" are TcCOM parameters, not PLC symbols.
6. Relate to the tile layout (see the `xplanar-tile-layout` skill): the track area is in the same part coordinates (mm) as `TilePositionOnPart`. State which tiles the track path crosses and which tiles it does not cover.
7. Update "Known result" below.

## Report format

Table: track | NC tid / OID | PartOID | closed loop | PLC FB | geometry source | area (bounding box mm) | length. Then an ASCII sketch against the tile grid and a note on tiles not covered. Flag tracks that exist but have no geometry or PLC link.

## Known result for this project (TwinCAT Project1, verified 2026-11-05)

Constants: rTileSize 240, rCornerRadius 60, rTrackGap 5, mover width/height 155.

| Track | tid | OID | PartOID | Closed loop (config) | PLC link | Area |
|-|-|-|-|-|-|-|
| Track1 | 2360 | #x05120030 | Part1 | FALSE (builder calls CloseLoop at runtime) | MAIN.fbTrack (built by MAIN.fbTrackBuilder) | rounded-square loop, centreline x 102.4..377.6, y 102.4..377.6 mm (about 275 mm square), around the centre of the 2x2 tiles P1_1..P1_4; mover envelope about 25..455 mm; path length about 958 mm |
| Track2 | 2362 | #x05120040 | Part1 | FALSE | none | no geometry defined (nothing builds it) |
| Track3 | 2364 | #x05120050 | Part1 | FALSE | none | no geometry defined (nothing builds it) |

Track1 segments (8, from FB_PlanarTrackBuilder): 4 lines (5 mm gap each end) joined by four 90 degree arcs, R60, centres (317.6,162.4), (317.6,317.6), (162.4,317.6), (162.4,162.4). Tiles P1_5 and P1_6 (y 480..720) are not covered by any track.

Re-verify with the workflow if the project may have changed (Track2/Track3 were newly added and may get geometry or a PLC builder later).
