---
name: plc-mover-instance-and-linking
description: Add a new MC_PlanarMover instance to the PLC (MAIN) and link it to an unlinked XPlanar mover (NC axis) in the open TwinCAT project via sysman-mcp, then verify. Use when an XPlanar mover/axis exists in the project but has no PLC mover FB, or when asked to create/link another mover instance. Helper skill: complementary to the main workflow skill plc-engineering-loop.
---

# New PLC mover instance + link to an unlinked mover

A PLC `MC_PlanarMover` only becomes linkable after the PLC is built (the build creates its process image symbols). Each mover links as 6 leaf pairs: 5 inputs (`MCTOPLC.STD/SET/ACT/COORDMODE/SETONTRACK`) and 1 output (`PLCTOMC.STD`). Track linking is separate: see `track-group-to-plc-linking`.

## Workflow

1. `list_projects` -> `pid`. Identify the unlinked mover: use the `xplanar-mover-axis-map` skill (a `Mover*` NC axis whose `McToPlc` children are not in `get_mappings`, or "PLC FB: none"). Note the axis tid under `MOTION > NC task > Axes`, then its children `PlcToMc` (-> `STD`) and `McToPlc` (-> `STD, SET, ACT, COORDMODE, SETONTRACK`). Get their tids with `get_treeitems`.
2. Read the PLC first: `plc_structure(pid, plc_tid=<PLC project node, itemtype 600>)`, then `plc_read_code` on `MAIN`. Match the style and the next free name (`fbMover3` if `fbMover1/2` exist). Honour "add/create": do not edit existing instances.
3. Declare the instance with a minimal patch (declaration only):
   `plc_write_code(pid, tid=<MAIN>, name="MAIN", old_declaration="\tfbMover2 : MC_PlanarMover;\n", declaration="\tfbMover2 : MC_PlanarMover;\n\tfbMover3 : MC_PlanarMover;\n")`.
   Do not add Update calls or demo FBs unless asked.
4. `plc_build(pid, plc_tid=<PLC project node>)` (param is `plc_tid`, not `tid`). Repeat until `success` true.
5. TIDS CHANGE AFTER A BUILD: the old PlcTask Inputs/Outputs tids become empty. Re-walk: `get_treeitems(<PLC wrapper tid, itemtype 14 child of PLC>)` -> Instance (itemtype 57) -> two children (Inputs, Outputs). Inputs has `MAIN.fbMoverN.MCTOPLC`; Outputs has `MAIN.fbMoverN.PLCTOMC`. Easier: `get_plc_variables(pid, plc_tid=<Instance tid>, filter_mapped="unmapped")` lists the new leaf tids and names (the summary counts after the filter; ignore "0 mapped").
6. Pair by NAME and direction (never by position guess): inputs `STD/SET/ACT/COORDMODE/SETONTRACK` -> axis `McToPlc` children of the same name; output `PLCTOMC.STD` -> axis `PlcToMc.STD`.
7. `map_variables(pid, mappings=[{plc_tid, io_tid} x6])`. Expect 6 successful.
8. Verify with `get_mappings(pid)`: the new 6 leaf paths (`...fbMover3.MCTOPLC.* / PLCTOMC.STD`) appear against `Axes > <axis> > McToPlc/PlcToMc`, the total grows by 6, and the older mover mappings are still present. Also confirm track links survived the rebuild with `get_treeiteminfo` on the track `McToPlc > STD` (`LinkedWith`).
9. Report, and remind the user to save in XAE (Ctrl+S). Do not activate/run without asking. The new FB is not yet called anywhere: it needs `Update()` and a demo/sequence before it moves.

## Known result (TwinCAT Project1, 2026-11-05)

`fbMover3 : MC_PlanarMover` added to MAIN (build 0 errors/0 warnings), linked to NC axis `Mover4330_1` (axis tid 2355, TcCOM mover 2344): inputs 2388..2392 -> 2378..2382, output 2398 -> 2376. `get_mappings` 12 -> 18, fbMover1/2 and Track1 links intact.
