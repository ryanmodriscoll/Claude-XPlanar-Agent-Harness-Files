---
name: track-group-to-plc-linking
description: Link a PLC MC_PlanarTrack instance (e.g. MAIN.fbTrack.MCTOPLC_STD) to an XPlanar track group (Planar Track under Groups) in the open TwinCAT project via sysman-mcp, and verify the link. Use when a track is unlinked, a new track group or PLC track was added, or asked to link/relink a track to the PLC. Helper skill: complementary to the main workflow skill plc-engineering-loop.
---

# Track group <-> PLC track linking

Background (Beckhoff TF5430 Planar Motion docs, example "Joining and moving a Planar mover on the track"): building the PLC creates a symbol for each `MC_PlanarTrack` ("track") and `MC_PlanarMover`. The symbol is then linked to the track/mover instance in the MC project. Movers have a "Link To PLC..." button; the track "must be linked separately" via its own dialog. In sysman-mcp this is one `map_variables` call at STRUCT level, not leaf level.

## Workflow

1. `list_projects` -> `pid`. PLC must be built so the symbols exist (`plc_build`; the PLC variable only exists after a successful build). If the PLC node list is empty, build first.
2. Find the PLC side. Use the PLC INSTANCE node, not the project node (`get_plc_variables` on the project node 600 returns 0 variables):
   - `get_treeitems(pid, tid=<PLC wrapper>)` -> children: project (itemtype 600) and Instance (itemtype 57, e.g. "Untitled1 Instance", tid 31).
   - `get_treeitems` on the Instance -> `PlcTask Inputs` (e.g. tid 1247). Its children are the struct-level nodes: `MAIN.fbTrack.MCTOPLC_STD` (track, tid 1266), `MAIN.fbMover1.MCTOPLC`, etc. The tid of the track struct node is what you need (NOT the leaf tids such as TrackOID/State, which `get_plc_variables(plc_tid=<instance>, include_internals=true)` also lists).
3. Find the track group side: `get_treeitems(pid, tid=8)` -> NC task -> `Groups` -> `Track*` -> `McToPlc` -> `STD` (itemtype 7, e.g. Track1 STD tid 2366, type `MC.CDT_MCTOPLC_PLANAR_TRACK`). Pick the track group to link (default: the one the PLC builder fills, normally the lowest unlinked `Track*`; one PLC `MC_PlanarTrack` links to exactly one group, so check other groups' STD `LinkedWith` first to avoid double use).
4. Check current state: `get_treeiteminfo(pid, <track STD tid>)`. `info.VarDef.LinkedWith` absent = unlinked; present = already linked to that PLC path (do not overwrite a different link without asking).
5. Link: `map_variables(pid, mappings=[{plc_tid: <track struct node tid>, io_tid: <track group STD tid>}])`. Expect `mapped: true`.
6. Verify: `get_treeiteminfo(pid, <track STD tid>)` must now show `LinkedWith` = `TIPC^<plc>^<Instance>^PlcTask Inputs^MAIN.fbTrack.MCTOPLC_STD`.
   - `get_mappings` does NOT list this struct-level track link (it still shows only the mover leaf mappings), so do not use it to verify tracks.
7. Remind the user to save in XAE (Ctrl+S). Do not activate or restart the target without asking.

## Notes

- The reverse (to unlink) was done by the user in XAE; only `map_variables` is used here.
- Track STD data is `CDT_MCTOPLC_PLANAR_TRACK` (TrackOID, GroupOID, State, OperationMode, MoverCountOnTrack, MovingMoverCount) - it is an input to the PLC (`PlcTask Inputs`).
- Linking only connects status data; track geometry is still created at runtime by the PLC (see `xplanar-track-areas`).
- Movers link separately (REFERENCE TO leaf variables per mover, see `xplanar-mover-axis-map`).

## Known result (TwinCAT Project1, 2026-11-05)

Track1 STD (tid 2366) was unlinked by the user; relinked with `map_variables({plc_tid: 1266, io_tid: 2366})` -> `MAIN.fbTrack.MCTOPLC_STD`. Verified via `LinkedWith`. Track2 (STD tid 2367) and Track3 (STD tid 2368) remain unlinked (no PLC track instance for them).
