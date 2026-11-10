"use strict";
const { spawn } = require("child_process");

const DEFAULT_NETID = process.env.ADS_NETID || "169.254.82.187.1.1";
const DEFAULT_PORT = Number(process.env.ADS_PORT || 851);
const MAX_SAMPLES = 200;
const MIN_INTERVAL_MS = 200;
const PATH_RE = /^[A-Za-z0-9_.\[\]\-,* ]{1,200}$/;
const NETID_RE = /^\d{1,3}(\.\d{1,3}){5}$/;

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module TcXaeMgmt
$a = $env:ADS_ARGS | ConvertFrom-Json
if ($a.netId) { $s = New-TcSession -NetId $a.netId -Port ([int]$a.port) }
function ConvertTo-Plain($v, [int]$depth = 0) {
  if ($null -eq $v) { return $null }
  if ($v -is [enum]) { return [string]$v }
  if ($v -is [TimeSpan]) { return $v.TotalMilliseconds }
  if ($v -is [DateTime]) { return $v.ToString('o') }
  if ($v -is [string] -or $v -is [ValueType]) { return $v }
  if ($v.GetType().FullName -like 'TwinCAT.TypeSystem.EnumValue*') { return [string]$v }
  if ($depth -ge 4) { return [string]$v }
  if ($v.PSObject.Properties.Name -contains 'Elements' -and $v.PSObject.Properties.Name -contains 'Dimensions') {
    return @($v.Elements | ForEach-Object { ConvertTo-Plain $_ ($depth + 1) })
  }
  $o = [ordered]@{}
  foreach ($p in $v.PSObject.Properties) {
    if ($p.Name -eq 'PSValue') { continue }
    $o[$p.Name] = ConvertTo-Plain $p.Value ($depth + 1)
  }
  return $o
}
`;

const SCRIPTS = {
  ads_find_targets: `
$local = [ordered]@{ netId = (Get-AmsNetId).ToString() }
try {
  $ti = Get-TcTargetInfo
  $local.targetType = [string]$ti.TargetType
  $local.twincatVersion = [string]$ti.TargetVersion
  $local.userModeRuntime = [bool]$ti.UserModeRuntime
  $local.os = [string]$ti.OsImage
} catch { $local.targetInfoError = $_.Exception.Message }

function Test-Reach($netId) {
  try {
    $r = Test-AdsRoute -NetId $netId -Port ([int]$a.testPort) -Count 1 -ScanSeconds ([int]$a.timeoutS) | Select-Object -First 1
    if ([string]$r.CommandResult -eq 'Ok') { return @{ reachable = $true; latencyMs = [math]::Round($r.Latency.TotalMilliseconds, 1) } }
    $msg = [string]$r.Exception.Message
    if ($msg.Length -gt 120) { $msg = $msg.Substring(0, 120) }
    return @{ reachable = $false; error = $msg }
  } catch { return @{ reachable = $false; error = $_.Exception.Message } }
}

if ([bool]$a.testReachability) {
  $lt = Test-Reach $local.netId
  $local.reachable = $lt.reachable
  if ($lt.latencyMs -ne $null) { $local.latencyMs = $lt.latencyMs }
}

$routes = @()
foreach ($r in @(Get-AdsRoute | ForEach-Object { $_ })) {
  $row = [ordered]@{ name = [string]$r.Name; netId = [string]$r.NetId; address = [string]$r.Address }
  if ([bool]$a.testReachability) {
    $t = Test-Reach ([string]$r.NetId)
    $row.reachable = $t.reachable
    if ($t.latencyMs -ne $null) { $row.latencyMs = $t.latencyMs }
    if ($t.error) { $row.error = $t.error }
  }
  $routes += [pscustomobject]$row
}
[ordered]@{ local = $local; routes = $routes; testPort = [int]$a.testPort; reachabilityTested = [bool]$a.testReachability } | ConvertTo-Json -Depth 5 -Compress
`,
  ads_get_state: `
try {
  $st = $s | Get-AdsState
  [pscustomobject]@{ netId = $a.netId; port = $a.port; state = [string]$st.State } | ConvertTo-Json -Compress
} finally { $s | Close-TcSession }
`,
  ads_list_symbols: `
try {
  $params = @{ Recurse = [bool]$a.recurse }
  if ($a.path) { $params.Path = $a.path }
  $syms = @($s | Get-TcSymbol @params | ForEach-Object { $_ })
  $total = $syms.Count
  $out = $syms | Select-Object -First ([int]$a.limit) | ForEach-Object {
    [pscustomobject]@{ name = $_.InstanceName; path = $_.InstancePath; type = [string]$_.DataType.Name }
  }
  [pscustomobject]@{ total = $total; returned = @($out).Count; symbols = @($out) } | ConvertTo-Json -Depth 4 -Compress
} finally { $s | Close-TcSession }
`,
  ads_snapshot: `
try {
  $maxDepth = [int]$a.maxDepth
  $maxValues = [int]$a.maxValues
  $leaves = New-Object System.Collections.ArrayList
  $skipped = @{}
  $skipExamples = @{}
  $truncated = $false
  function Add-Skip($reason, $path) {
    if (-not $skipped.ContainsKey($reason)) { $skipped[$reason] = 0; $skipExamples[$reason] = @() }
    $skipped[$reason]++
    if ($skipExamples[$reason].Count -lt 3) { $skipExamples[$reason] += $path }
  }
  function Get-Kids($path) {
    try { return @($s | Get-TcSymbol -Path "$path.*" -IncludeArrays | ForEach-Object { $_ }) }
    catch { Add-Skip 'children-unreadable' $path; return @() }
  }
  function Test-Match($path) {
    if ($a.filter -and @($a.filter).Count -gt 0) {
      $hit = $false
      foreach ($f in @($a.filter)) { if ($path -like $f) { $hit = $true } }
      if (-not $hit) { return $false }
    }
    foreach ($x in @($a.exclude)) { if ($x -and $path -like $x) { return $false } }
    return $true
  }
  $types = @{}
  function Add-Leaf($path, $sym) {
    if (Test-Match $path) {
      [void]$script:leaves.Add($path)
      $script:types[$path] = [string]$sym.DataType.Name
    }
  }
  function Walk($sym, [int]$depth) {
    if ($script:leaves.Count -ge $maxValues) { $script:truncated = $true; return }
    $path = [string]$sym.InstancePath
    $cat = [string]$sym.DataType.Category
    switch -Regex ($cat) {
      '^(Primitive|Enum|Alias|String)$' { Add-Leaf $path $sym }
      '^Array$' {
        $ec = ''
        try { $ec = [string]$sym.DataType.ElementType.Category } catch {}
        if ($ec -match '^(Primitive|Enum|String)$') { Add-Leaf $path $sym }
        else { Add-Skip 'array-of-structs' $path }
      }
      '^(Struct|)$' {
        if ($depth -ge $maxDepth) { Add-Skip 'max-depth' $path; return }
        foreach ($k in (Get-Kids $path)) { Walk $k ($depth + 1) }
      }
      default { Add-Skip ("type-" + $cat) $path }
    }
  }
  $roots = @()
  if (@($a.scope).Count -eq 0) {
    foreach ($r in @($s | Get-TcSymbol | ForEach-Object { $_ })) {
      $n = [string]$r.InstancePath
      if (-not [bool]$a.includeSystem -and ($n -like 'TwinCAT_*' -or $n -eq 'Global_Version')) { continue }
      $roots += $r
    }
  } else {
    foreach ($sc in @($a.scope)) {
      try { $roots += @($s | Get-TcSymbol -Path $sc | ForEach-Object { $_ }) }
      catch { Add-Skip 'scope-not-found' $sc }
    }
  }
  foreach ($r in $roots) { Walk $r 0 }

  if ([bool]$a.discoverOnly) {
    $vars = @($leaves | ForEach-Object { [ordered]@{ path = $_; type = $types[$_] } })
    [ordered]@{
      netId = $a.netId; port = $a.port
      leafCount = $leaves.Count; truncated = $truncated
      skipped = $skipped; skippedExamples = $skipExamples
      variables = $vars
    } | ConvertTo-Json -Depth 6 -Compress
    return
  }

  function Same($x, $y) {
    if ($x -is [array] -or $y -is [array] -or $x -is [System.Collections.IDictionary]) {
      return ((ConvertTo-Json $x -Compress -Depth 4) -eq (ConvertTo-Json $y -Compress -Depth 4))
    }
    return ($x -eq $y)
  }
  $stats = @{}
  $t0 = Get-Date
  $nSamples = [int]$a.samples
  $last = [ordered]@{}
  for ($i = 0; $i -lt $nSamples; $i++) {
    $tick = Get-Date
    foreach ($p in $leaves) {
      $val = $null
      $err = $null
      try { $val = ConvertTo-Plain (Read-TcValue -Session $s -Path $p) }
      catch { $err = $_.Exception.Message; if ($err.Length -gt 90) { $err = $err.Substring(0, 90) } }
      if ($err) { $val = "ERR: $err" }
      if ($i -eq 0) {
        $stats[$p] = @{ first = $val; min = $null; max = $null; changes = 0 }
      } elseif (-not (Same $last[$p] $val)) {
        $stats[$p].changes++
      }
      if (($val -is [ValueType]) -and -not ($val -is [bool])) {
        $d = [double]$val
        if ($null -eq $stats[$p].min -or $d -lt $stats[$p].min) { $stats[$p].min = $d }
        if ($null -eq $stats[$p].max -or $d -gt $stats[$p].max) { $stats[$p].max = $d }
      }
      $last[$p] = $val
    }
    if ($i -lt $nSamples - 1) {
      $wait = [int]$a.intervalMs - [int]((Get-Date) - $tick).TotalMilliseconds
      if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    }
  }
  $changed = [ordered]@{}
  foreach ($p in $leaves) {
    if ($stats[$p].changes -gt 0) {
      $changed[$p] = [ordered]@{ first = $stats[$p].first; last = $last[$p]; min = $stats[$p].min; max = $stats[$p].max; changes = $stats[$p].changes }
    }
  }
  $res = [ordered]@{
    netId = $a.netId; port = $a.port
    leafCount = $leaves.Count; truncated = $truncated
    samples = $nSamples; durationMs = [int]((Get-Date) - $t0).TotalMilliseconds
    skipped = $skipped; skippedExamples = $skipExamples
  }
  if ($nSamples -gt 1) { $res.changed = $changed; $res.unchangedCount = $leaves.Count - $changed.Count }
  if ($nSamples -eq 1 -or [bool]$a.includeValues) { $res.values = $last }
  $res | ConvertTo-Json -Depth 8 -Compress
} finally { $s | Close-TcSession }
`,
  ads_poll_symbols: `
try {
  $samples = @()
  $t0 = Get-Date
  for ($i = 0; $i -lt [int]$a.samples; $i++) {
    $tick = Get-Date
    $vals = [ordered]@{}
    foreach ($p in $a.paths) {
      try { $vals[$p] = ConvertTo-Plain (Read-TcValue -Session $s -Path $p) }
      catch { $vals[$p] = @{ error = $_.Exception.Message } }
    }
    $samples += [pscustomobject]@{ tMs = [int](($tick - $t0).TotalMilliseconds); values = $vals }
    if ($i -lt [int]$a.samples - 1) {
      $wait = [int]$a.intervalMs - [int]((Get-Date) - $tick).TotalMilliseconds
      if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
    }
  }
  [pscustomobject]@{ netId = $a.netId; port = $a.port; samples = $samples } | ConvertTo-Json -Depth 8 -Compress
} finally { $s | Close-TcSession }
`,
};

function runPs(scriptName, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const script = PS_PRELUDE + SCRIPTS[scriptName];
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env: { ...process.env, ADS_ARGS: JSON.stringify(args) }, windowsHide: true }
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out).trim() || `PowerShell exited with ${code}`));
      resolve(out.trim());
    });
  });
}

function target(input) {
  const netId = input.netId || DEFAULT_NETID;
  const port = input.port === undefined ? DEFAULT_PORT : Number(input.port);
  if (!NETID_RE.test(netId)) throw new Error("netId must look like 1.2.3.4.5.6");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1-65535");
  return { netId, port };
}

function checkPath(p) {
  if (typeof p !== "string" || !PATH_RE.test(p)) throw new Error(`Invalid symbol path: ${JSON.stringify(p)}`);
  return p;
}

const targetProps = {
  netId: { type: "string", description: `AMS NetId, default ${DEFAULT_NETID}` },
  port: { type: "integer", description: `ADS port, default ${DEFAULT_PORT} (first PLC runtime)` },
};

const TOOLS = [
  {
    name: "ads_find_targets",
    description:
      "Call this FIRST in a new project, before any other ads_* tool. Returns the local AMS NetId (with TwinCAT version and runtime type) and every configured ADS route (route name, AMS NetId, address) with an optional reachability test. " +
      "Show the list to the user and ask which target is correct, then pass that NetId as netId to the other ads_* tools (they default to the NetId in the server's ADS_NETID setting). Read-only: it never changes routes.",
    inputSchema: {
      type: "object",
      properties: {
        test_reachability: { type: "boolean", description: "Ping each route with Test-AdsRoute, default true" },
        test_port: { type: "integer", description: "ADS port used for the reachability test, default 10000 (the system service)" },
        timeout_s: { type: "integer", description: "Per-route ping timeout in seconds, default 1, max 5" },
      },
    },
    run: async (i) => {
      const testPort = i.test_port === undefined ? 10000 : Number(i.test_port);
      if (!Number.isInteger(testPort) || testPort < 1 || testPort > 65535) throw new Error("test_port must be 1-65535");
      const timeoutS = Math.min(Math.max(Number(i.timeout_s) || 1, 1), 5);
      const testReachability = i.test_reachability !== false;
      return runPs("ads_find_targets", { testPort, timeoutS, testReachability }, 60000 + 20 * timeoutS * 1000);
    },
  },
  {
    name: "ads_get_state",
    description: "Read the ADS state (Run, Config, Stop, ...) of a TwinCAT target. Read-only.",
    inputSchema: { type: "object", properties: { ...targetProps } },
    run: async (i) => runPs("ads_get_state", target(i), 30000),
  },
  {
    name: "ads_list_symbols",
    description: "List PLC symbols on a port. Optional wildcard path filter such as 'MAIN.*'. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetProps,
        path: { type: "string", description: "Wildcard path filter, e.g. MAIN.*" },
        recurse: { type: "boolean", description: "Recurse into structs, default false" },
        limit: { type: "integer", description: "Max symbols returned, default 200" },
      },
    },
    run: async (i) => {
      const args = { ...target(i), recurse: !!i.recurse, limit: Math.min(Math.max(Number(i.limit) || 200, 1), 2000) };
      if (i.path) args.path = checkPath(i.path);
      return runPs("ads_list_symbols", args, 60000);
    },
  },
  {
    name: "ads_read_symbol",
    description: "Read the current value of one or more PLC symbols once (e.g. MAIN.nCounter). Structs and arrays are returned as JSON. Read-only.",
    inputSchema: {
      type: "object",
      properties: { ...targetProps, paths: { type: "array", items: { type: "string" }, description: "Symbol paths" } },
      required: ["paths"],
    },
    run: async (i) => {
      if (!Array.isArray(i.paths) || !i.paths.length || i.paths.length > 50) throw new Error("paths must be 1-50 symbol paths");
      return runPs("ads_poll_symbols", { ...target(i), paths: i.paths.map(checkPath), samples: 1, intervalMs: 0 }, 60000);
    },
  },
  {
    name: "ads_discover",
    description:
      "List the names and types of all readable variables under one or more scopes WITHOUT reading their values (only symbol-table queries). " +
      "Use it first to see what exists in a GVL or POU instance, then pick one or a few paths for ads_poll_symbols. " +
      "scope entries are root symbol paths such as 'GVL_PlanarDemo', 'MAIN', 'MAIN.fbDemo1'; omit scope for the whole PLC. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetProps,
        scope: { type: "array", items: { type: "string" }, description: "Root paths to list; omit for the whole PLC" },
        filter: { type: "array", items: { type: "string" }, description: "Only keep variables matching any wildcard, e.g. *.eState" },
        exclude: { type: "array", items: { type: "string" }, description: "Drop variables matching any wildcard" },
        max_depth: { type: "integer", description: "Struct nesting depth to expand, default 4" },
        max_values: { type: "integer", description: "Cap on number of variables listed, default 300, max 2000" },
        include_system: { type: "boolean", description: "Include TwinCAT_* and Global_Version roots when scope is omitted" },
      },
    },
    run: async (i) => {
      const strList = (v, name) => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > 50) throw new Error(`${name} must be an array of up to 50 strings`);
        return v.map(checkPath);
      };
      const args = {
        ...target(i),
        scope: strList(i.scope, "scope"),
        filter: strList(i.filter, "filter"),
        exclude: strList(i.exclude, "exclude"),
        maxDepth: Math.min(Math.max(Number(i.max_depth) || 4, 0), 8),
        maxValues: Math.min(Math.max(Number(i.max_values) || 300, 1), 2000),
        includeSystem: !!i.include_system,
        discoverOnly: true,
      };
      return runPs("ads_snapshot", args, 120000);
    },
  },
  {
    name: "ads_snapshot",
    description:
      "Discover and read every readable value under one or more scopes, so the scope can match where a code change was made. " +
      "scope entries are root symbol paths such as 'GVL_PlanarDemo', 'MAIN', 'MAIN.fbDemo1'; omit scope to read the whole PLC (system lists excluded unless include_system). " +
      "Structs are expanded to leaf values up to max_depth; references, pointers and arrays of structs are skipped and counted. " +
      "With samples > 1 it re-reads the same leaves over time and reports only the values that changed (first, last, min, max, change count). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ...targetProps,
        scope: { type: "array", items: { type: "string" }, description: "Root paths to read; omit for the whole PLC" },
        filter: { type: "array", items: { type: "string" }, description: "Only keep leaves matching any wildcard, e.g. *.eState" },
        exclude: { type: "array", items: { type: "string" }, description: "Drop leaves matching any wildcard, e.g. *.MCTOPLC.*" },
        max_depth: { type: "integer", description: "Struct nesting depth to expand, default 4" },
        max_values: { type: "integer", description: "Cap on number of leaves read, default 300, max 2000" },
        samples: { type: "integer", description: "Number of full reads, default 1, max 100" },
        interval_ms: { type: "integer", description: "Time between samples, default 500" },
        include_values: { type: "boolean", description: "With samples > 1, also return the final value of every leaf" },
        include_system: { type: "boolean", description: "Include TwinCAT_* and Global_Version roots when scope is omitted" },
      },
    },
    run: async (i) => {
      const strList = (v, name) => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > 50) throw new Error(`${name} must be an array of up to 50 strings`);
        return v.map(checkPath);
      };
      const maxValues = Math.min(Math.max(Number(i.max_values) || 300, 1), 2000);
      const samples = Math.min(Math.max(Number(i.samples) || 1, 1), 100);
      const intervalMs = Math.max(Number(i.interval_ms) || 500, MIN_INTERVAL_MS);
      const args = {
        ...target(i),
        scope: strList(i.scope, "scope"),
        filter: strList(i.filter, "filter"),
        exclude: strList(i.exclude, "exclude"),
        maxDepth: Math.min(Math.max(Number(i.max_depth) || 4, 0), 8),
        maxValues,
        samples,
        intervalMs,
        includeValues: !!i.include_values,
        includeSystem: !!i.include_system,
      };
      const timeout = 60000 + maxValues * 20 + samples * (intervalMs + maxValues * 60);
      return runPs("ads_snapshot", args, timeout);
    },
  },
  {
    name: "ads_poll_symbols",
    description: `Sample one or more PLC symbols repeatedly to observe behaviour over time. Pick the paths from ads_discover first so only the few variables that matter are polled. Max ${MAX_SAMPLES} samples, min interval ${MIN_INTERVAL_MS} ms. Each sample carries its offset in ms. Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        ...targetProps,
        paths: { type: "array", items: { type: "string" }, description: "Symbol paths" },
        samples: { type: "integer", description: "Number of samples, default 20" },
        interval_ms: { type: "integer", description: "Time between samples in ms, default 500" },
      },
      required: ["paths"],
    },
    run: async (i) => {
      if (!Array.isArray(i.paths) || !i.paths.length || i.paths.length > 50) throw new Error("paths must be 1-50 symbol paths");
      const samples = Math.min(Math.max(Number(i.samples) || 20, 1), MAX_SAMPLES);
      const intervalMs = Math.max(Number(i.interval_ms) || 500, MIN_INTERVAL_MS);
      const timeout = 30000 + samples * (intervalMs + 500);
      return runPs("ads_poll_symbols", { ...target(i), paths: i.paths.map(checkPath), samples, intervalMs }, timeout);
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && send({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ads-read-mcp", version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool ${params.name}`);
      try {
        const text = await tool.run(params.arguments || {});
        return reply({ content: [{ type: "text", text }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });
      }
    }
    default:
      if (id !== undefined) return fail(-32601, `Method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(e.message || e) } });
    }
  }
});
