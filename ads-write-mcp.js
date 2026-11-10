"use strict";
const { spawn } = require("child_process");

const DEFAULT_PORT = Number(process.env.ADS_PORT || 851);
const MAX_WRITES = 20;
const PATH_RE = /^[A-Za-z0-9_.\[\]\-]{1,200}$/;
const NETID_RE = /^\d{1,3}(\.\d{1,3}){5}$/;
const ALLOW = (process.env.ADS_WRITE_ALLOW || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module TcXaeMgmt
$a = $env:ADS_ARGS | ConvertFrom-Json
$s = New-TcSession -NetId $a.netId -Port ([int]$a.port)
function ConvertTo-Plain($v, [int]$depth = 0) {
  if ($null -eq $v) { return $null }
  if ($v -is [enum]) { return [string]$v }
  if ($v -is [TimeSpan]) { return $v.TotalMilliseconds }
  if ($v -is [DateTime]) { return $v.ToString('o') }
  if ($v -is [string] -or $v -is [ValueType]) { return $v }
  if ($depth -ge 4) { return [string]$v }
  return [string]$v
}
`;

const SCRIPTS = {
  ads_write_symbol: `
try {
  $st = [string]($s | Get-AdsState).State
  if ($st -ne 'Run') { throw "ADS state on port $($a.port) is '$st', not Run - not writing" }
  $intTypes = @{
    SINT = [sbyte]; USINT = [byte]; BYTE = [byte]; INT = [int16]; UINT = [uint16]; WORD = [uint16]
    DINT = [int32]; UDINT = [uint32]; DWORD = [uint32]; LINT = [int64]; ULINT = [uint64]; LWORD = [uint64]
  }
  $results = @()
  foreach ($w in @($a.writes)) {
    $r = [ordered]@{ path = [string]$w.path; ok = $false }
    try {
      $found = @($s | Get-TcSymbol -Path $w.path | ForEach-Object { $_ })
      if ($found.Count -ne 1) { throw "path matched $($found.Count) symbols, expected exactly 1" }
      $sym = $found[0]
      $cat = [string]$sym.DataType.Category
      $tn = ([string]$sym.DataType.Name).ToUpper()
      $r.type = [string]$sym.DataType.Name
      if ($cat -notmatch '^(Primitive|String)$') { throw "unsupported type category '$cat' - write the primitive leaf members instead" }
      $r.old = ConvertTo-Plain (Read-TcValue -Session $s -Path $w.path)
      $v = $w.value
      $x = $null
      if ($tn -eq 'BOOL') {
        if ($v -is [bool]) { $x = $v }
        elseif (($v -is [ValueType]) -and ($v -eq 0 -or $v -eq 1)) { $x = [bool][int]$v }
        else { throw 'BOOL needs true or false' }
      }
      elseif ($intTypes.ContainsKey($tn)) {
        if (($v -isnot [ValueType]) -or ($v -is [bool])) { throw "$tn needs a whole number" }
        if ([double]$v -ne [math]::Floor([double]$v)) { throw "$tn needs a whole number, got $v" }
        $x = [Convert]::ChangeType($v, $intTypes[$tn])
      }
      elseif ($tn -eq 'REAL') {
        if (($v -isnot [ValueType]) -or ($v -is [bool])) { throw 'REAL needs a number' }
        $x = [Convert]::ChangeType($v, [single])
      }
      elseif ($tn -eq 'LREAL') {
        if (($v -isnot [ValueType]) -or ($v -is [bool])) { throw 'LREAL needs a number' }
        $x = [Convert]::ChangeType($v, [double])
      }
      elseif ($tn -like 'STRING*') {
        $max = 80
        if ($tn -match 'STRING\\((\\d+)\\)') { $max = [int]$Matches[1] }
        $x = [string]$v
        if ($x.Length -gt $max) { throw "string length $($x.Length) exceeds STRING($max)" }
      }
      else { throw "unsupported primitive type $tn" }

      Write-TcValue -Session $s -Path $w.path -Value $x -Confirm:$false | Out-Null
      $new = ConvertTo-Plain (Read-TcValue -Session $s -Path $w.path)
      $r.requested = $x
      $r.new = $new
      $same = $false
      if (($new -is [ValueType]) -and ($new -isnot [bool]) -and ($x -is [ValueType])) {
        $same = ([math]::Abs([double]$new - [double]$x) -le (1e-6 * [math]::Max(1.0, [math]::Abs([double]$x))))
      } else { $same = ($new -eq $x) }
      $r.ok = $true
      $r.readbackMatches = $same
      if (-not $same) { $r.note = 'readback differs from requested value - the PLC program may be overwriting this variable every cycle' }
    } catch {
      $m = $_.Exception.Message
      if ($m.Length -gt 200) { $m = $m.Substring(0, 200) }
      $r.error = $m
    }
    $results += [pscustomobject]$r
  }
  [pscustomobject]@{ netId = $a.netId; port = $a.port; adsState = $st; results = @($results) } | ConvertTo-Json -Depth 6 -Compress
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
  if (!input.netId) throw new Error("netId is required: the write server has no default target, pass the NetId the user chose");
  const netId = String(input.netId);
  const port = input.port === undefined ? DEFAULT_PORT : Number(input.port);
  if (!NETID_RE.test(netId)) throw new Error("netId must look like 1.2.3.4.5.6");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be 1-65535");
  return { netId, port };
}

function checkPath(p) {
  if (typeof p !== "string" || !PATH_RE.test(p)) throw new Error(`Invalid symbol path (no wildcards allowed): ${JSON.stringify(p)}`);
  if (/^(TwinCAT_|Global_Version)/i.test(p)) throw new Error(`Refusing to write system symbol ${p}`);
  if (ALLOW.length && !ALLOW.some((pre) => p.toLowerCase().startsWith(pre))) {
    throw new Error(`Path ${p} is outside ADS_WRITE_ALLOW (${ALLOW.join(", ")})`);
  }
  return p;
}

const TOOLS = [
  {
    name: "ads_write_symbol",
    description:
      "WRITES values to PLC variables on a LIVE TwinCAT runtime (ADS, via the TcXaeMgmt PowerShell module). " +
      "Use it to start or steer a process (e.g. set MAIN.bRun to true) after a build and deploy, then observe with ads_poll_symbols / ads_snapshot. " +
      "netId is REQUIRED (no default): pass the target the user chose. Only primitive and STRING leaf variables can be written; use full paths such as MAIN.bRun or GVL_X.rSpeed (no wildcards, no structs/arrays/enums). " +
      "Each write is type-checked against the symbol, performed, then read back; the result gives old, requested and new values and whether the readback matches. " +
      "Refuses if the ADS state is not Run. Max 20 writes per call. This changes machine behaviour: only write what the user asked for.",
    inputSchema: {
      type: "object",
      properties: {
        netId: { type: "string", description: "AMS NetId of the target (required), e.g. 10.1.176.115.1.1" },
        port: { type: "integer", description: `ADS port, default ${DEFAULT_PORT} (first PLC runtime)` },
        writes: {
          type: "array",
          description: `List of {path, value} to write, in order (max ${MAX_WRITES}). value is a JSON boolean, number or string matching the variable type.`,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Full symbol path, e.g. MAIN.bRun" },
              value: { description: "boolean, number or string" },
            },
            required: ["path", "value"],
          },
        },
      },
      required: ["netId", "writes"],
    },
    run: async (i) => {
      if (!Array.isArray(i.writes) || !i.writes.length || i.writes.length > MAX_WRITES) {
        throw new Error(`writes must be an array of 1-${MAX_WRITES} {path, value} items`);
      }
      const writes = i.writes.map((w) => {
        if (!w || typeof w !== "object") throw new Error("each write must be {path, value}");
        checkPath(w.path);
        const t = typeof w.value;
        if (t !== "boolean" && t !== "number" && t !== "string") {
          throw new Error(`value for ${w.path} must be a boolean, number or string`);
        }
        if (t === "number" && !Number.isFinite(w.value)) throw new Error(`value for ${w.path} must be finite`);
        return { path: w.path, value: w.value };
      });
      return runPs("ads_write_symbol", { ...target(i), writes }, 30000 + writes.length * 3000);
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
        serverInfo: { name: "ads-write-mcp", version: "1.0.0" },
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
