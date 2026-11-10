---
name: xplanar-mover-axis-map
description: Count the XPlanar movers set up in the open TwinCAT project and record which mover (TcCOM object) is assigned to which NC motion axis (and PLC mover FB). Use when asked how many movers there are, which mover is which axis, or to refresh/recall the mover-to-axis assignment. Helper skill: complementary to the main workflow skill plc-engineering-loop.
---

# XPlanar mover -> motion axis map

The assignment is static configuration in the XAE project tree. ADS on the target does not expose it.
Results are remembered in `mover-axis-map.md` in this skill folder: read it first for a quick answer, then re-verify (steps below) if the project may have changed, and rewrite the file with the new result.

## Workflow

1. `list_projects` -> `pid`.
2. Count movers: `get_treeitems(pid, tid=1)` -> `TcCOM Objects` (itemtype 49) -> `XPlanar` (itemtype 48) -> its children. Children named `Mover*` are the movers; `Part*` are tile groups (ignore here). Note each mover `tid`. Number of movers = count of `Mover*` children.
3. Find the NC axes: `get_treeitems(pid, tid=8)` (MOTION) -> NC task (itemtype 19 child) -> `Axes` (itemtype 71) -> children are the axes (itemtype 78, here also named `Mover4220_n`). Note each axis `tid`.
4. Get the real link (do NOT assume from matching names):
   - For each mover, `get_treeitems` on the mover tid -> child `InputsFromNC3` -> its child `NC3ToHW` (itemtype 7).
   - `get_treeiteminfo` on `NC3ToHW` (small output). `info.VarDef.LinkedWith["#text"]` is the NC axis path, e.g. `TINC^XPlanar MC Project^Axes^Mover4220_1^McToIo^STD`. The axis name in that path is the assigned axis.
   - Do NOT call `get_treeiteminfo` on the mover or axis nodes themselves: 100-280k chars, and the hardware mover OTCID is not in their ParameterValues.
5. Get the PLC side: `get_mappings(pid)`. Each `io_channel.path` like `TINC > XPlanar MC Project > Axes > Mover4220_1 > McToPlc > ...` pairs with `plc_variable.path` like `...MAIN.fbMover1.MCTOPLC...`, giving mover/axis -> PLC FB instance.
6. Optional extra identifiers: `ObjectId` of axis and mover TcCOM objects and the mover `BTN` come from `get_treeiteminfo` on the mover/axis (saved to a file, Grep it for `"ObjectId"` and `"BTN"` with -A1; never read it whole).
7. Update `mover-axis-map.md` with the table and the date.

## Report format

State the mover count, then a table: TcCOM mover | NC axis | PLC FB instance. Flag mismatches (e.g. mover with no link, axis not linked to any mover, name does not match link).
