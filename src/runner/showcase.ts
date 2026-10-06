import { access, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { serveStatic, type StaticServer } from '../checks/serve.js';
import { findTask } from '../catalog/load.js';
import { userCatalogPath } from '../catalog/idea.js';
import { loadRun } from '../report/data.js';
import { buildReport } from '../report/build.js';
import { reportToPdf } from '../report/pdf.js';
import { bold, dim, green, modelColor } from '../ui/colors.js';
import { table } from '../format.js';
import { modeLabel } from '../ui/labels.js';
import { tr } from '../i18n.js';

export interface Showcase {
  reportUrl: string;
  /** Slides laid out by a model, when one passed the checks. */
  reportFile: string;
  pdfFile: string | null;
  entries: Array<{ id: string; task: string; model: string; mode: string; url: string | null; note?: string }>;
  close(): Promise<void>;
}

/** Tries `port`, then the next ones, until one is free. */
async function serveOnFreePort(root: string, port: number): Promise<StaticServer> {
  for (let p = port; p < port + 200; p++) {
    try {
      return await serveStatic(root, p);
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE') throw err;
    }
  }
  return serveStatic(root, 0);
}

/**
 * Serves every delivered product of a run at once, each on its own port, plus the report, so the
 * results can be opened side by side. Report links point to these URLs.
 */
export async function startShowcase(runDir: string, o: { basePort?: number; pdf?: boolean } = {}): Promise<Showcase> {
  const base = o.basePort ?? 4300;
  const run = await loadRun(runDir);
  const servers: StaticServer[] = [];
  const entries: Showcase['entries'] = [];
  const demoUrls: Record<string, string> = {};
  let next = base + 1;

  const beforeServed = new Set<string>();
  for (const j of [...run.jobs].sort((a, b) => a.task.id.localeCompare(b.task.id) || a.model.localeCompare(b.model) || a.mode.localeCompare(b.mode))) {
    const entry = { id: j.id, task: j.task.id, model: j.model, mode: j.mode, url: null as string | null } as Showcase['entries'][number];
    try {
      const task = await findTask(j.task.id, [userCatalogPath()]);
      // Repair tasks: the buggy original, served once per project, next to each agent's fix.
      const beforeDir = task.deliverable && path.join(path.dirname(j.workDir), 'before', task.deliverable.static_dir);
      if (task.beforeAfter && beforeDir && !beforeServed.has(task.id)) {
        try {
          await access(path.join(beforeDir, task.deliverable!.entry));
          const b = await serveOnFreePort(beforeDir, next);
          servers.push(b);
          next = Number(new URL(b.url).port) + 1;
          beforeServed.add(task.id);
          entries.push({ id: `${task.id}__before`, task: task.id, model: tr("version d'origine", 'original version'), mode: tr('avant (buggée)', 'before (buggy)'), url: b.url });
        } catch {
          // Starter not built (job without QA).
        }
      }
      if (!task.deliverable) entry.note = tr('pas de rendu visuel (tâche de code)', 'no visual output (code task)');
      else {
        const dir = path.join(j.workDir, task.deliverable.static_dir);
        await access(path.join(dir, task.deliverable.entry));
        const s = await serveOnFreePort(dir, next);
        servers.push(s);
        next = Number(new URL(s.url).port) + 1;
        entry.url = s.url;
        demoUrls[j.id] = s.url;
      }
    } catch {
      entry.note ??= tr('pas de build à servir', 'no build to serve');
    }
    entries.push(entry);
  }

  const reportFile = await buildReport(runDir, { demoUrls });
  // Read by the report page itself: a report rebuilt while the showcase runs still opens the
  // served projects, not files the report server cannot reach.
  await writeFile(path.join(path.dirname(reportFile), 'demos.json'), JSON.stringify(demoUrls, null, 2) + '\n');
  const pdfFile = o.pdf === false ? null : await reportToPdf(reportFile);
  const reportServer = await serveOnFreePort(path.dirname(reportFile), base);
  servers.push(reportServer);

  return {
    reportUrl: reportServer.url,
    reportFile,
    pdfFile,
    entries,
    close: async () => {
      await Promise.all(servers.map((s) => s.close()));
    },
  };
}

export function printShowcase(s: Showcase): void {
  console.log(`\n${bold(tr('Rapport', 'Report'))}  ${green(s.reportUrl)}${s.pdfFile ? `  ${dim(`· PDF : ${s.pdfFile}`)}` : ''}`);
  console.log('');
  console.log(
    table(
      [tr('Projet', 'Project'), tr('Modèle', 'Model'), 'Mode', tr('Rendu', 'Output')],
      s.entries.map((e) => [e.task, e.id.endsWith('__before') ? dim(e.model) : modelColor(e.model)(e.model), e.id.endsWith('__before') ? e.mode : modeLabel(e.mode), e.url ? green(e.url) : dim(e.note ?? '—')]),
    ),
  );
  console.log(`\n${dim(tr('Tous les rendus restent en ligne. Ctrl+C pour tout arrêter.', 'Every output stays online. Ctrl+C to stop everything.'))}`);
}

/** Resolves on Ctrl+C (SIGINT) or SIGTERM. */
export function waitForStop(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/** Opens a URL in the default browser (macOS, Linux, Windows); silent if it cannot. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // No browser available (CI, SSH): the URL is printed anyway.
  }
}

/** End of a bench: serve everything, open the report, print the URLs, wait for Ctrl+C, then shut down. */
export async function presentRun(runDir: string, o: { open?: boolean } = {}): Promise<void> {
  const s = await startShowcase(runDir);
  printShowcase(s);
  if (o.open !== false && !process.env.AILOVEBENCH_NO_OPEN) openInBrowser(s.reportUrl);
  await waitForStop();
  await s.close();
  console.log(`\n${tr('Arrêté.', 'Stopped.')}`);
}
