/**
 * Stop only the PISKIE development processes owned by this checkout.
 *
 * Match processes by this checkout's paths instead of killing generic process
 * names such as "electron" and "vite" globally.
 * Use --dry-run to inspect the selected processes without stopping them.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const isWin = process.platform === 'win32';
const dryRun = process.argv.includes('--dry-run');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

function normalize(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

function readUnixProcesses() {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => {
      const pid = Number(match[1]);
      let cwd = '';

      if (process.platform === 'linux') {
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          // The process may have exited or may not expose its cwd.
        }
      }

      return {
        pid,
        ppid: Number(match[2]),
        command: match[3],
        cwd,
      };
    });
}

function readWindowsProcesses() {
  const script = [
    'Get-CimInstance Win32_Process',
    'Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }).trim();
  const rows = output ? JSON.parse(output) : [];

  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    command: [row.ExecutablePath, row.CommandLine].filter(Boolean).join(' '),
    cwd: '',
  }));
}

function readProcesses() {
  try {
    return isWin ? readWindowsProcesses() : readUnixProcesses();
  } catch (error) {
    console.error(`Unable to inspect processes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return [];
  }
}

const normalizedProjectRoot = normalize(projectRoot);
const runtimeDependencyMarkers = [
  '/node_modules/.bin/concurrently',
  '/node_modules/.bin/cross-env',
  '/node_modules/.bin/electron',
  '/node_modules/.bin/vite',
  '/node_modules/.bin/wait-on',
  '/node_modules/@esbuild/',
  '/node_modules/concurrently/',
  '/node_modules/cross-env/',
  '/node_modules/electron/',
  '/node_modules/esbuild/',
  '/node_modules/vite/',
  '/node_modules/wait-on/',
];

function isOwnedRuntime(entry) {
  const command = normalize(entry.command);
  const cwd = normalize(entry.cwd);
  // A shared userData path is not proof that a process belongs to this checkout.
  const usesProjectDependency =
    command.includes(`${normalizedProjectRoot}/node_modules/`) &&
    runtimeDependencyMarkers.some((marker) => command.includes(marker));
  const usesProjectApp =
    command.includes(`--app-path=${normalizedProjectRoot}`) ||
    command.includes(`--app-path="${normalizedProjectRoot}`);
  const isProjectLauncher =
    cwd === normalizedProjectRoot &&
    (/(?:^|\s)npm(?:\.cmd)?\s+run\s+dev(?::(?:vite|electron))?(?:\s|$)/.test(command) ||
      /(?:^|\s)(?:sh|bash)\s+-c\s+["']?(?:vite|wait-on\b.*electron\b)/.test(command) ||
      /node(?:\.exe)?\s+\.?[\\/]node_modules[\\/](?:\.bin[\\/])?(?:concurrently|cross-env|electron|vite|wait-on)/.test(command));

  return usesProjectDependency || usesProjectApp || isProjectLauncher;
}

function getAncestors(entries) {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const ancestors = new Set([process.pid]);
  let current = byPid.get(process.pid);

  while (current && current.ppid > 0 && !ancestors.has(current.ppid)) {
    ancestors.add(current.ppid);
    current = byPid.get(current.ppid);
  }

  return ancestors;
}

function includeDescendants(entries, seedPids) {
  const selected = new Set(seedPids);
  let changed = true;

  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (selected.has(entry.ppid) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        changed = true;
      }
    }
  }

  return selected;
}

function processDepth(entry, byPid) {
  let depth = 0;
  let current = entry;
  const seen = new Set();

  while (current && current.ppid > 0 && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    current = byPid.get(current.ppid);
    depth += 1;
  }

  return depth;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcesses(entries) {
  const ancestors = getAncestors(entries);
  const seedPids = entries
    .filter((entry) => !ancestors.has(entry.pid) && isOwnedRuntime(entry))
    .map((entry) => entry.pid);
  const selectedPids = includeDescendants(entries, seedPids);
  for (const pid of ancestors) selectedPids.delete(pid);

  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const selected = [...selectedPids]
    .map((pid) => byPid.get(pid))
    .filter(Boolean)
    .sort((a, b) => processDepth(b, byPid) - processDepth(a, byPid));

  if (selected.length === 0) {
    console.log(`No ${path.basename(projectRoot)} development processes found.`);
    return;
  }

  console.log(`${dryRun ? 'Would stop' : 'Stopping'} ${selected.length} process(es) for ${projectRoot}:`);
  for (const entry of selected) {
    console.log(`  ${entry.pid} ${entry.command}`);
  }

  if (dryRun) return;

  for (const entry of selected) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {
      // A process can exit while the list is being traversed.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const entry of selected) {
    if (!isAlive(entry.pid)) continue;
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {
      // A process can exit between the liveness check and the signal.
    }
  }
}

console.log(`Project-scoped cleanup: ${projectRoot}`);
await stopProcesses(readProcesses());
