import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import type { Task } from '../catalog/load.js';
import type { CheckResult } from './types.js';
import { runBuild, runCommand } from './build.js';
import { serveStatic, type StaticServer } from './serve.js';
import { inspectSite, withBrowser, type SiteInspection } from './browser.js';
import { runLighthouse } from './lighthouse.js';
import { inspectWebgl } from './webgl.js';
import { inspectVideo, videoChecks } from './video.js';
import { modifiedFiles, parseNodeTestOutput, runHiddenTests } from './hidden-tests.js';

/** A check as declared in task.yaml: a bare name, or `{ name: options }`. */
export type CheckSpec = string | Record<string, any>;

export interface ChecksRun {
  round: number;
  startedAt: string;
  endedAt: string;
  results: CheckResult[];
  passed: number;
  failed: number;
  /** Repair tasks, round 0: the same checks on the untouched starter, so the planted bugs are on record. */
  baseline?: ChecksRun;
}

/** What a task's scenario module receives (hidden/scenarios.mjs, default export). */
export interface ScenarioContext {
  page: Page;
  url: string;
  check(id: string, label: string, ok: boolean, detail?: string): void;
}

const specName = (s: CheckSpec) => (typeof s === 'string' ? s : Object.keys(s)[0]!);
const specOpts = (s: CheckSpec) => (typeof s === 'string' ? {} : (Object.values(s)[0] ?? {}));

/**
 * Runs the task's automatic checks on a job's work folder. Evidence goes to
 * `<job>/qa/round-<n>/`; paths in results are relative to the job folder.
 */
export async function runChecks(task: Task, jobRoot: string, work: string, round = 0, dirName = `round-${round}`): Promise<ChecksRun> {
  const startedAt = new Date().toISOString();
  const outDir = path.join(jobRoot, 'qa', dirName);
  await mkdir(outDir, { recursive: true });
  const rel = (p: string) => path.relative(jobRoot, p);
  const results: CheckResult[] = [];
  const specs: CheckSpec[] = task.checks;
  const names = specs.map(specName);

  let server: StaticServer | null = null;
  let site: SiteInspection | null = null;
  let built = true;
  let baseline: ChecksRun | undefined;

  try {
    if (round === 0 && task.beforeAfter) {
      await captureBefore(task, jobRoot).catch(() => {});
      baseline = await runChecks({ ...task, beforeAfter: false }, jobRoot, path.join(jobRoot, 'before'), 0, 'before-checks').catch(() => undefined);
    }
    if (names.includes('build') && task.deliverable) {
      const r = await runBuild(work, task.deliverable);
      results.push(r);
      built = r.status === 'pass';
      if (built) server = await serveStatic(path.join(work, task.deliverable.static_dir));
    }

    const needsSite = ['console', 'external_requests', 'responsive'].some((n) => names.includes(n));
    if (needsSite && server) {
      const widths: number[] = specOpts(specs.find((s) => specName(s) === 'responsive') ?? 'x').widths ?? [375, 1440];
      site = await inspectSite(server.url, { widths, screenshotsDir: outDir });
    }

    for (const spec of specs) {
      const name = specName(spec);
      const opts = specOpts(spec);
      if (name === 'build') continue;
      const needsServer = ['console', 'external_requests', 'responsive', 'lighthouse', 'webgl', 'scenario'].includes(name);
      if (needsServer && !server) {
        results.push({ id: name, label: name, status: 'skip', detail: built ? 'pas de site à servir' : 'build en échec', detailEn: built ? 'no site to serve' : 'build failed' });
        continue;
      }
      try {
        results.push(...(await runOne(name, opts, { task, work, outDir, rel, server, site })));
      } catch (err) {
        results.push({ id: name, label: name, status: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    await server?.close();
  }

  return {
    round,
    startedAt,
    endedAt: new Date().toISOString(),
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail' || r.status === 'error').length,
    ...(baseline ? { baseline } : {}),
  };
}

/**
 * Repair tasks: builds the untouched starter in `<job>/before/` and captures it, so the report and
 * the showcase can put the buggy version next to each agent's fix.
 */
export async function captureBefore(task: Task, jobRoot: string): Promise<string[]> {
  const dir = path.join(jobRoot, 'before');
  await cp(task.starter!, dir, { recursive: true });
  const built = await runBuild(dir, task.deliverable!);
  if (built.status !== 'pass') return [];
  const out = path.join(jobRoot, 'qa', 'before');
  await mkdir(out, { recursive: true });
  const server = await serveStatic(path.join(dir, task.deliverable!.static_dir));
  try {
    return (await inspectSite(server.url, { widths: [375, 1440], screenshotsDir: out, prefix: 'before' })).screenshots;
  } finally {
    await server.close();
  }
}

interface Ctx {
  task: Task;
  work: string;
  outDir: string;
  rel: (p: string) => string;
  server: StaticServer | null;
  site: SiteInspection | null;
}

async function runOne(name: string, opts: any, c: Ctx): Promise<CheckResult[]> {
  switch (name) {
    case 'console': {
      const errors = [...c.site!.consoleErrors, ...c.site!.pageErrors];
      return [{ id: 'console', label: 'Console sans erreur', labelEn: 'Console without errors', status: errors.length ? 'fail' : 'pass', value: errors.length, detail: errors.slice(0, 5).join('\n') || undefined }];
    }
    case 'external_requests': {
      const ext = c.site!.externalRequests;
      return [{ id: 'external_requests', label: 'Aucune ressource externe', labelEn: 'No external resource', status: ext.length ? 'fail' : 'pass', value: ext.length, detail: ext.slice(0, 5).join('\n') || undefined }];
    }
    case 'responsive': {
      const o = c.site!.overflow;
      return [{
        id: 'responsive',
        label: 'Pas de défilement horizontal',
        labelEn: 'No horizontal scrolling',
        status: o.length ? 'fail' : 'pass',
        detail: o.length ? o.map((x) => `${x.width} px → largeur ${x.scrollWidth} px`).join(', ') : undefined,
        ...(o.length ? { detailEn: o.map((x) => `${x.width} px → width ${x.scrollWidth} px`).join(', ') } : {}),
        artifacts: c.site!.screenshots.map(c.rel),
      }];
    }
    case 'lighthouse': {
      const s = await runLighthouse(c.server!.url, c.outDir, 'lighthouse', opts.preset === 'desktop' ? 'desktop' : 'mobile');
      const min: Record<string, number> = opts.min ?? {};
      const scores: Record<string, number | null> = {
        performance: s.performance, accessibility: s.accessibility, 'best-practices': s.bestPractices, seo: s.seo,
      };
      return Object.entries(scores).map(([k, v]) => {
        const threshold = min[k];
        const status = v === null ? 'error' : threshold !== undefined && v < threshold ? 'fail' : 'pass';
        return {
          id: `lighthouse.${k}`,
          label: `Lighthouse ${k}${threshold !== undefined ? ` (≥ ${threshold})` : ''}`,
          status,
          value: v ?? undefined,
          artifacts: [c.rel(s.report)],
        } satisfies CheckResult;
      });
    }
    case 'webgl': {
      const w = await inspectWebgl(c.server!.url, c.outDir);
      const minFps = opts.min_fps ?? 30;
      const art = w.screenshots.map(c.rel);
      return [
        { id: 'webgl.canvas', label: 'Canvas WebGL présent', labelEn: 'WebGL canvas present', status: w.hasCanvas && w.webgl ? 'pass' : 'fail', artifacts: art },
        { id: 'webgl.rendered', label: 'Scène rendue (canvas non vide)', labelEn: 'Scene rendered (non-empty canvas)', status: w.coverage > 0.02 ? 'pass' : 'fail', value: Math.round(w.coverage * 100), detail: '% de pixels hors couleur dominante', detailEn: '% of pixels outside the dominant color' },
        { id: 'webgl.animated', label: 'Scène animée', labelEn: 'Scene animated', status: w.motion > 0.002 ? 'pass' : 'fail', value: Math.round(w.motion * 1000) / 10, detail: '% de pixels changés en 1 s', detailEn: '% of pixels changed in 1 s' },
        { id: 'webgl.fps', label: `Fluidité (≥ ${minFps} images/s)`, labelEn: `Smoothness (≥ ${minFps} frames/s)`, status: w.fps >= minFps ? 'pass' : 'fail', value: w.fps },
        (() => {
          const dragOk = w.drag > 1.5 * w.baseline + 0.005;
          const zoomOk = w.zoomRatio >= 1.25 || w.zoomRatio <= 0.8;
          const pct = (v: number) => Math.round(v * 1000) / 10;
          return {
            id: 'webgl.interaction',
            label: 'Réagit à la souris (glisser ou molette)',
            labelEn: 'Reacts to the mouse (drag or wheel)',
            status: dragOk || zoomOk ? 'pass' : 'fail',
            detail: `glisser : ${pct(w.drag)} % de pixels changés (animation seule : ${pct(w.baseline)} %) ${dragOk ? '✓' : '✗'} · molette : surface × ${w.zoomRatio.toFixed(2)} ${zoomOk ? '✓' : '✗'}`,
            detailEn: `drag: ${pct(w.drag)} % of pixels changed (animation alone: ${pct(w.baseline)} %) ${dragOk ? '✓' : '✗'} · wheel: area × ${w.zoomRatio.toFixed(2)} ${zoomOk ? '✓' : '✗'}`,
          } satisfies CheckResult;
        })(),
      ];
    }
    case 'scenario': {
      const file = path.join(c.task.dir, typeof opts === 'string' ? opts : (opts.file ?? 'hidden/scenarios.mjs'));
      const mod = await import(pathToFileURL(file).href);
      const out: CheckResult[] = [];
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(c.server!.url, { waitUntil: 'load' });
        await mod.default({
          page,
          url: c.server!.url,
          check: (id: string, label: string, ok: boolean, detail?: string) =>
            out.push({ id: `scenario.${id}`, label, status: ok ? 'pass' : 'fail', ...(detail ? { detail } : {}) }),
        } satisfies ScenarioContext);
      });
      return out;
    }
    case 'visible_tests': {
      const r = await runCommand(opts.command, c.work, 5 * 60_000);
      const t = parseNodeTestOutput(r.output);
      const total = t ? t.passed + t.failed : 0;
      return [{
        id: 'visible_tests', label: 'Tests fournis', labelEn: 'Provided tests', status: t && t.failed === 0 && total > 0 ? 'pass' : 'fail',
        value: total ? Math.round((t!.passed / total) * 100) : 0, detail: t ? `${t.passed}/${total} verts` : r.output.slice(-500), ...(t ? { detailEn: `${t.passed}/${total} passing` } : {}),
      }];
    }
    case 'hidden_tests': {
      const r = await runHiddenTests(c.work, path.join(c.task.dir, opts.dir ?? 'hidden'), opts.command);
      const total = r.passed + r.failed;
      // Failing behaviours are reported like a client would (name + expected/observed), so a fix
      // round can address them; the test files themselves never reach the agent.
      const failing = r.failing.slice(0, 20).map((t) => `- ${t.name}${t.message ? ` : ${t.message}` : ''}`);
      return [{
        id: 'hidden_tests', label: 'Comportements de la spécification', labelEn: 'Behaviours of the spec', status: total > 0 && r.failed === 0 ? 'pass' : 'fail',
        value: total ? Math.round((r.passed / total) * 100) : 0,
        detail: total ? [`${r.passed}/${total} conformes`, ...failing].join('\n') : r.output.slice(-500),
        ...(total ? { detailEn: [`${r.passed}/${total} compliant`, ...failing].join('\n') } : {}),
      }];
    }
    case 'video': {
      const file = path.join(c.work, c.task.deliverable?.static_dir ?? '', opts.file ?? 'video.mp4');
      const v = await inspectVideo(file, c.outDir);
      return videoChecks(v, {
        file: opts.file ?? 'video.mp4',
        duration: opts.duration ?? [9.5, 10.5],
        width: opts.width ?? 1920,
        height: opts.height ?? 1080,
        fps: opts.fps ?? 30,
      }, c.rel);
    }
    case 'untouched': {
      const files: string[] = Array.isArray(opts) ? opts : (opts.files ?? []);
      const changed = await modifiedFiles(path.join(c.task.dir, 'starter'), c.work, files);
      return [{ id: 'untouched', label: 'Tests fournis non modifiés', labelEn: 'Provided tests unchanged', status: changed.length ? 'fail' : 'pass', detail: changed.join(', ') || undefined }];
    }
    default:
      return [{ id: name, label: name, status: 'error', detail: `check inconnu : ${name}`, detailEn: `unknown check: ${name}` }];
  }
}
