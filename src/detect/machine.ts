import os from 'node:os';
import { run } from './exec.js';
import { findHerdr } from './herdr-install.js';

export interface Gpu {
  name: string;
  /** Dedicated VRAM in GB; null for unified memory or when unknown. */
  vramGb: number | null;
}

export interface Machine {
  os: string;
  arch: string;
  cpu: string;
  cores: number;
  ramGb: number;
  gpus: Gpu[];
  node: string;
  herdr: string | null;
}

export async function detectMachine(): Promise<Machine> {
  const cpus = os.cpus();
  return {
    os: await osLabel(),
    arch: os.arch(),
    cpu: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    gpus: await detectGpus(),
    node: process.versions.node,
    herdr: await findHerdr(),
  };
}

async function osLabel(): Promise<string> {
  if (process.platform === 'darwin') {
    const v = await run('sw_vers', ['-productVersion']);
    return v ? `macOS ${v}` : `macOS (Darwin ${os.release()})`;
  }
  return `${os.type()} ${os.release()}`;
}

async function detectGpus(): Promise<Gpu[]> {
  if (process.platform === 'darwin') {
    const out = await run('system_profiler', ['SPDisplaysDataType', '-json'], 15000);
    if (!out) return [];
    try {
      const items: any[] = JSON.parse(out).SPDisplaysDataType ?? [];
      return items.map((g) => ({
        name: g.sppci_model ?? g._name ?? 'unknown',
        vramGb: parseVram(g.spdisplays_vram ?? g.sppci_vram),
      }));
    } catch {
      return [];
    }
  }
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out.split('\n').map((l) => {
    const [name = 'unknown', mib] = l.split(',').map((s) => s.trim());
    return { name, vramGb: mib ? Math.round(Number(mib) / 1024) : null };
  });
}

function parseVram(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/(\d+)\s*(GB|MB)/i);
  if (!m) return null;
  return m[2]!.toUpperCase() === 'GB' ? Number(m[1]) : Math.round(Number(m[1]) / 1024);
}
