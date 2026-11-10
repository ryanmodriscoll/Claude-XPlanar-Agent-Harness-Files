# TwinCAT PLC Development via sysman-mcp

This project uses the `sysman-mcp` MCP server (`mcp-workbench.js`) to read and edit a live TwinCAT 3 project open in TwinCAT XAE Shell. Tools appear as `mcp\\\_\\\_sysman-mcp\\\_\\\_<tool>`.

## Prerequisites

* TwinCAT XAE Shell must be running with the solution open. The server auto-discovers the System Manager WebSocket (default `ws://localhost:8088`). To pin it, set `SYSMAN\\\_WS\\\_URL`.
* If a tool fails with a connection error, tell the user to check that XAE is open. Do not retry in a loop.
* Edits are applied in memory. The API has no save command, so remind the user to save the solution in XAE (Ctrl+S) when work is done.

## Start of every session

1. Call `list\\\_projects` to get the `pid`. Every other tool needs it.
2. Call `get\\\_project\\\_info` for an overview, or `get\\\_treeitems` (tid=0 for root, `TIPC` is the PLC node).
3. Call `plc\\\_structure` on the PLC project node to get the tids of all POUs.
4. Call 'ads\\\_find\\\_targets' from the ads-read-mcp server on the start of a session then prompt the user for which target they would like to read PLC variables from. 

## Main workflow

When the user describes a behaviour they want to see on the machine, use the `plc-engineering-loop` skill. It is the MAIN workflow: write code, build, deploy, start the process with `ads_write_symbol` (ads-write-mcp), observe with the ads-read-mcp tools, compare with what the user asked, and iterate. The other skills (`xplanar-tile-layout`, `xplanar-mover-axis-map`, `xplanar-track-areas`, `track-group-to-plc-linking`, `plc-mover-instance-and-linking`, `build-and-deploy-to-runtime`) are complementary helpers that the loop calls. In a new session, ask the user for permission before running the loop unsupervised.

## Which TID to use

* PLC wrapper node: itemtype 56, direct child of the PLC root. Required by `plc\\\_online`.
* PLC project node: itemtype 600 (for example "MyPlc Project"). Use for `plc\\\_structure`, `plc\\\_search`, `get\\\_plc\\\_variables`, and as `parent\\\_tid` for new top-level POUs.
* `plc\\\_build`, `plc\\\_errorlist`, `plc\\\_add\\\_library`, `plc\\\_remove\\\_library` auto-resolve either node.
* Always take tids from `plc\\\_structure` or `get\\\_treeitems`. Never guess them.

## Tools for PLC work

|Task|Tool|
|-|-|
|Create PLC project|`create\\\_plc\\\_project` (ask the user for the name first)|
|See POU tree|`plc\\\_structure`|
|Create POU|`plc\\\_create\\\_pou` (program, function\_block, function, method, property, action, transition, gvl, interface, struct, enum, union, folder)|
|Read code|`plc\\\_read\\\_code` (pass `pid`, `tid`, `name`)|
|Write code|`plc\\\_write\\\_code`|
|Search code|`plc\\\_search` (ST POUs only)|
|Libraries|`plc\\\_add\\\_library`, `plc\\\_remove\\\_library`|
|Build|`plc\\\_build`|
|Compiler messages|`plc\\\_errorlist`|
|Delete POU|`plc\\\_delete\\\_pou` (ask first)|

## Creating and writing code

* Create a POU with `plc\\\_create\\\_pou`, then fill it with `plc\\\_write\\\_code`. Creation gives an empty POU.
* Methods, properties, actions and transitions must have a function block or program as `parent\\\_tid`.
* Properties are created with Get and Set accessors automatically. Write each one separately with `child\\\_name` plus `accessor: "get"` or `"set"`.
* Interface methods and properties cannot be created through `plc\\\_create\\\_pou`. Tell the user instead of working around it.
* To write a method, action, property or transition, pass the parent POU's `tid` plus `child\\\_name`. Never pass the child's own tid. Do not call `plc\\\_read\\\_code` on a child. Children are returned with the parent.
* `plc\\\_write\\\_code` accepts `declaration` and `implementation`. Without `old\\\_declaration` or `old\\\_implementation` it replaces the whole section. With them it patches by exact text match. Prefer patch mode for small edits so unrelated code is not overwritten.
* Before writing to an existing POU, read it with `plc\\\_read\\\_code` first and match its format and style.
* Only Structured Text is supported for read, write and search.
* For a brand new POU, read a neighbouring POU first to see how declaration and implementation are split, and follow that.

## Build loop

After any code change:

1. `plc\\\_build`.
2. If it fails, read the errors (`plc\\\_errorlist` if needed), fix them, rebuild.
3. Repeat until `success` is true. Warnings do not fail the build.
4. The errorlist covers the whole solution. Do not assume every entry was caused by your change, and do not fix unrelated errors unless asked.

Build only after writing code or when the user asks. Process data (PLC variables for I/O mapping) only exists after a successful build.

## Structured Text conventions

* Use CASE for state machines.
* Close every block: `END\\\_IF`, `END\\\_FOR`, `END\\\_WHILE`, `END\\\_CASE`, `END\\\_VAR`, `END\\\_PROGRAM`, `END\\\_FUNCTION\\\_BLOCK`, `END\\\_FUNCTION`, `END\\\_TYPE`.
* Use ASCII only. No umlauts.
* Identifiers: start with a letter or single underscore, then letters, digits, underscores only. No double or trailing underscores, no reserved keywords. Example: `FB\\\_ConveyorBelt`, `nAxisCount`.
* Use a restrained OOP style: function blocks with methods, interfaces only where useful.
* Do not reimplement library blocks. Add the library (`plc\\\_add\\\_library`, for example `Tc2\\\_Standard` for TON/TOF/R\_TRIG/CTU) and call the existing block.
* GVL I/O variables need exactly one space before `AT`: `bInput AT%I\\\* : BOOL;`. Without the space the compiler errors (C0006).
* Match the naming and structure of existing POUs in the project.
* Do not add code comments unless the user asks.

## I/O mapping

Only when the user asks:

1. `plc\\\_build` first.
2. `get\\\_plc\\\_variables` with `filter\\\_mapped: "unmapped"`.
3. `get\\\_io\\\_structure` with `max\\\_depth` 4 or higher (channels appear at depth 4). Scope with `root\\\_tid` for large trees.
4. Pair by direction: PLC input variables map to input channels, outputs to output channels.
5. `map\\\_variables` with `{plc\\\_tid, io\\\_tid}` pairs. Report which succeeded and failed.
6. Verify with `get\\\_mappings`.

## Running on the target

Only on explicit request, in this order:

1. `get\\\_target\\\_state`. Expect CONFIG for activation.
2. `activate`.
3. `restart\\\_target` with `"run"`.
4. `plc\\\_online` with `"start"` (needs the wrapper tid, itemtype 56).

`deploy\\\_to\\\_target` does the full sequence in one call. `plc\\\_online` `reset` is a cold reset.

## Safety rules

* Ask before: `plc\\\_delete\\\_pou`, `delete\\\_plc\\\_project`, `delete\\\_treeitem`, `plc\\\_remove\\\_library`, `activate`, `restart\\\_target`, `deploy\\\_to\\\_target`, `plc\\\_online`.
* Never use `context\\\_menu` or `execute\\\_context\\\_menu\\\_item` on PLC nodes. It can crash TwinCAT.
* Read before write: use `plc\\\_read\\\_code` before changing a POU, and `get\\\_treeiteminfo` before `set\\\_treeiteminfo`.
* Stay in scope. Edit only the POUs the user named. Do not refactor or reformat other code.
* Honour the verb the user uses. "Add" or "create" means a new POU. Do not overwrite an existing one. If the name already exists, stop and tell the user.
* Edits are live in the open project. Say what you changed, and mention that the user should save in XAE.

## Reporting

Keep summaries short: what you created or changed, which POUs, build result (pass or fail plus any remaining errors), and anything you could not do.



# Beckhoff documentation assistant

For ANY question about a Beckhoff product, part number, TwinCAT function, error code or
configuration, delegate to the `beckhoff-docs` subagent and relay its answer together with its
"Sources:" list. Do not answer Beckhoff-specific facts from memory.

The subagent searches the offline InfoSys corpora (twincat, ipc\_io, drives) through the
`infosys-search` MCP server. If it reports that the documentation does not contain the answer, tell the user that and
what was searched.



This documentation server has very little sample code.  If you need more sample code to build a response then you can use a web search agent to search the following GitHub pages: https://github.com/beckhoff and https://github.com/Beckhoff-USA-Community

