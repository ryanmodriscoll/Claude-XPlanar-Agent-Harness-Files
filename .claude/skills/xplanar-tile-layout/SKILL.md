---
name: xplanar-tile-layout
description: Read the real-space layout (X/Y position in mm) of XPlanar tiles from the TcCOM Objects section of the open TwinCAT project via sysman-mcp. Use when asked where the XPlanar tiles are, what the planar track/layout looks like, or for tile coordinates. Helper skill: complementary to the main workflow skill plc-engineering-loop.
---

# Read XPlanar tile layout

Tile positions are static configuration, not PLC variables. They live as parameters on each tile TcCOM object in the XAE project tree. ADS (`ads_discover`, `ads_list_symbols`) does NOT expose them - do not look there.

## Workflow

1. `list_projects` -> `pid`.
2. `get_treeitems(pid, tid=1)` (SYSTEM) -> find the child named `TcCOM Objects` (itemtype 49).
3. `get_treeitems` on `TcCOM Objects` -> the `XPlanar` object (itemtype 48).
4. `get_treeitems` on `XPlanar` -> children are `Part*` (tile groups/parts) and `Mover*` objects.
5. `get_treeitems` on each `Part*` -> its children are the tile objects (e.g. `APS4322_P1_1`). Note each tile `tid`.
6. For EACH tile call `get_treeiteminfo(pid, tid)`. The result is ~97k chars, always exceeds the token limit and is auto-saved to a file under `...\tool-results\mcp-sysman-mcp-get_treeiteminfo-<id>.txt`. Do NOT read the whole file. Call all tiles in parallel, then Grep the saved files:
   - pattern: `"(ItemName|TilePositionOnPart\.[xy])"` with `-A 1`, glob `mcp-sysman-mcp-get_treeiteminfo-*.txt`
   - `ItemName` identifies which tile the file is; the `Value` line after each `TilePositionOnPart.x` / `.y` is the position.
   - They sit in `ParameterValues` (around line 1965-1970 of the file).
7. Optionally read the `Part*` object's info the same way: its `ParameterValues` has no position offset (`IsFixed` TRUE), so tile positions are relative to the part origin, which is the layout origin.

## Interpreting values

- `TilePositionOnPart.x/.y` are in mm (XPlanar tiles are 240 x 240 mm, so values step by 240).
- Position is the tile's origin corner on the part; x runs along X, y along Y.
- A tile whose position is missing from `ParameterValues` is at its default (0).

## Report format

Give a table (tile name, tid, x, y) and an ASCII grid sketch of the layout, and state the overall footprint (e.g. 2 x 2 tiles = 480 x 480 mm). Mention movers (`Mover*` objects) exist but their live position is runtime data, not covered here.

## Known result for this project (TwinCAT Project1, Part1)

| Tile | tid | x | y |
|-|-|-|-|
| APS4322_P1_1 | 1390 | 0 | 0 |
| APS4322_P1_2 | 1391 | 240 | 0 |
| APS4322_P1_3 | 1392 | 240 | 240 |
| APS4322_P1_4 | 1393 | 0 | 240 |
| APS4322_P1_5 | 2342 | 0 | 480 |
| APS4322_P1_6 | 2343 | 240 | 480 |

2 tiles wide x 3 tall, 480 x 720 mm (verified 2026-11-05, second pass; the project changed since the first pass: P1_5 and P1_6 were added and P1_2/P1_4 positions changed). Always re-read rather than trusting this table if the project may have changed. Enumerate ALL children of Part1 each time; do not rely on the tids listed here.
