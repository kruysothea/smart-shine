const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const execp = promisify(exec);

const UNIT = { B: 1, K: 1024, M: 1024**2, G: 1024**3, T: 1024**4 };
function toBytes(num, unit) {
  return Number(num) * (UNIT[unit] || 1);
}

function parseHeader(text) {
  const o = {};
  const cpu = text.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/);
  if (cpu) {
    o.cpuUser = Number(cpu[1]);
    o.cpuSys  = Number(cpu[2]);
    o.cpuIdle = Number(cpu[3]);
    o.cpuUsed = o.cpuUser + o.cpuSys;
  }
  const phys = text.match(/PhysMem:\s*([\d.]+)([BKMGT])\s*used\s*\(([\d.]+)([BKMGT])\s*wired,\s*([\d.]+)([BKMGT])\s*compressor\),\s*([\d.]+)([BKMGT])\s*unused/);
  if (phys) {
    o.memUsed       = toBytes(phys[1], phys[2]);
    o.memWired      = toBytes(phys[3], phys[4]);
    o.memCompressor = toBytes(phys[5], phys[6]);
    o.memUnused     = toBytes(phys[7], phys[8]);
  }
  const net = text.match(/Networks:\s*packets:\s*\d+\/([\d.]+)([BKMGT])\s*in,\s*\d+\/([\d.]+)([BKMGT])\s*out/);
  if (net) {
    o.netInBytes  = toBytes(net[1], net[2]);
    o.netOutBytes = toBytes(net[3], net[4]);
  }
  const disk = text.match(/Disks:\s*\d+\/([\d.]+)([BKMGT])\s*read,\s*\d+\/([\d.]+)([BKMGT])\s*written/);
  if (disk) {
    o.diskReadBytes  = toBytes(disk[1], disk[2]);
    o.diskWriteBytes = toBytes(disk[3], disk[4]);
  }
  const la = text.match(/Load Avg:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (la) o.loadAvg = [Number(la[1]), Number(la[2]), Number(la[3])];
  const procs = text.match(/Processes:\s*(\d+)\s*total/);
  if (procs) o.processCount = Number(procs[1]);
  return o;
}

function parseProcesses(text) {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l => /^\s*PID\s+%?CPU\s+MEM/i.test(l));
  if (headerIdx < 0) return [];
  const procs = [];
  // Process line: PID %CPU MEM[B/K/M/G][+-]? #TH(/optional) POWER USER COMMAND...
  const re = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)([BKMGT])[+\-]?\s+(\d+)(?:\/\d+)?\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      cpu: Number(m[2]),
      memBytes: toBytes(m[3], m[4]),
      threads: Number(m[5]),
      power: Number(m[6]),
      user: m[7],
      command: m[8],
      isApp: /\.app\/Contents\/MacOS\//.test(m[8]) || /^\/Applications\//.test(m[8]),
    });
  }
  return procs;
}

function appName(cmd) {
  const appMatch = cmd.match(/\/([^\/]+)\.app\/Contents\/MacOS\//);
  if (appMatch) return appMatch[1];
  return cmd.split('/').pop().split(' ')[0];
}

async function getFullCommands() {
  // top truncates COMMAND to a fixed width — pull full paths from ps so we can
  // detect .app bundles reliably.
  const map = new Map();
  try {
    const { stdout } = await execp('ps -axwwo pid=,command=', { maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (m) map.set(Number(m[1]), m[2]);
    }
  } catch (_) {}
  return map;
}

async function snapshot() {
  // Kick off ps in parallel with top — both take a moment, no need to wait sequentially
  const [topResult, fullCmds] = await Promise.all([
    execp(
      'top -l 2 -s 1 -n 150 -stats pid,cpu,mem,th,power,user,command -o cpu',
      { maxBuffer: 16 * 1024 * 1024, timeout: 6000 }
    ),
    getFullCommands(),
  ]);
  const { stdout } = topResult;

  const parts = stdout.split(/^(?=Processes:\s)/m).filter(Boolean);
  const snap1 = parts[0] || '';
  const snap2 = parts[parts.length - 1];

  const h1 = parseHeader(snap1);
  const h2 = parseHeader(snap2);

  // Per-second rates from the 1-second window
  const netIn   = Math.max(0, (h2.netInBytes   || 0) - (h1.netInBytes   || 0));
  const netOut  = Math.max(0, (h2.netOutBytes  || 0) - (h1.netOutBytes  || 0));
  const diskR   = Math.max(0, (h2.diskReadBytes  || 0) - (h1.diskReadBytes  || 0));
  const diskW   = Math.max(0, (h2.diskWriteBytes || 0) - (h1.diskWriteBytes || 0));

  const processes = parseProcesses(snap2).map(p => {
    const fullCmd = fullCmds.get(p.pid) || p.command;
    return {
      ...p,
      fullCommand: fullCmd,
      isApp: /\.app\/Contents\/MacOS\//.test(fullCmd) || /^\/Applications\//.test(fullCmd),
      appName: appName(fullCmd),
    };
  });
  const totalPower = processes.reduce((s, p) => s + (p.power || 0), 0);
  const memTotal = os.totalmem();
  const memUsed = h2.memUsed ?? (memTotal - os.freemem());

  return {
    timestamp: Date.now(),
    cpu: {
      used: h2.cpuUsed || 0,
      user: h2.cpuUser || 0,
      sys:  h2.cpuSys || 0,
      idle: h2.cpuIdle || 100,
      cores: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || '',
      loadAvg: h2.loadAvg || os.loadavg(),
      processCount: h2.processCount || processes.length,
    },
    memory: {
      total: memTotal,
      used: memUsed,
      wired: h2.memWired || 0,
      compressor: h2.memCompressor || 0,
      unused: h2.memUnused || os.freemem(),
      usedPct: (memUsed / memTotal) * 100,
    },
    energy: {
      totalImpact: totalPower,
    },
    network: {
      inRate: netIn,
      outRate: netOut,
      totalIn: h2.netInBytes || 0,
      totalOut: h2.netOutBytes || 0,
    },
    disk: {
      readRate: diskR,
      writeRate: diskW,
      totalRead: h2.diskReadBytes || 0,
      totalWrite: h2.diskWriteBytes || 0,
    },
    processes,
  };
}

async function killProcess(pid, force = false) {
  // pid<=1 could signal a process group (negative) or launchd (1) — reject it so
  // a single bad value can't take down many processes.
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'Invalid pid' };
  try {
    if (force) {
      process.kill(pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGTERM');
      // Escalate if process is still alive after 1.5s
      setTimeout(() => {
        try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (_) {}
      }, 1500);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { snapshot, killProcess };
