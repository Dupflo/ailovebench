import type { RunData } from './data.js';
import type { SeriesPoint } from './series.js';
import { modelLabel } from '../ui/model-label.js';
import { dec, tr } from '../i18n.js';

type Job = RunData['jobs'][number];

/**
 * Categorical palette (dataviz reference instance), validated on the report surface #fffaf2:
 * adjacent pairs pass CVD and normal-vision floors; three slots are under 3:1 contrast, so every
 * series is also direct-labeled and the results table is the table view. Scatter (all pairs on
 * screen) is safe for the first three slots only: beyond, dots go neutral and labels carry identity.
 */
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const OTHER = '#8a8178';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const label = modelLabel;

/** Color follows the model (sorted once for the whole run), never its rank in a chart. */
export function modelColors(jobs: Job[]): Record<string, string> {
  const models = [...new Set(jobs.map((j) => j.model))].sort();
  return Object.fromEntries(models.map((m, i) => [m, PALETTE[i] ?? OTHER]));
}

const seriesName = (j: Job) => `${label(j.model)}${j.mode === 'bare' ? '' : tr(' · avec harness', ' · with harness')}`;

/** Seconds under a minute, then « 12 min 36 s » (never « 755,7 s »). */
const fmtTime = (s: number) => {
  const r = Math.round(s);
  if (r < 60) return `${r} s`;
  const m = Math.floor(r / 60);
  const sec = r % 60;
  return sec ? `${m} min ${String(sec).padStart(2, '0')} s` : `${m} min`;
};
const fmtTok = (n: number) => dec(n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(Math.round(n)));
const fmtUsd = (v: number) => `${dec(v.toFixed(2))} $`;

export const CHART_CSS = `
.chart-head{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between}
.legend-list{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--ink)}
.legend-list li{display:flex;align-items:center;gap:6px}
.sw{display:inline-block;width:18px;height:0;border-top:3px solid var(--c);border-radius:2px}.sw.dashed{border-top-style:dashed}
.chart{margin:0;position:relative}.chart [hidden]{display:none}.chart svg{width:100%;height:auto;display:block;overflow:visible}
.chart .grid{stroke:var(--line);stroke-width:1}.chart .axis{stroke:var(--ink);stroke-width:1}
.chart .tick{font-size:11px;fill:var(--muted)}.chart .axis-title{font-size:11px;fill:var(--muted)}
.chart .series{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.chart .leader{fill:none;stroke-width:1;stroke-dasharray:2 3;opacity:.55}
.chart .end{stroke:var(--bg);stroke-width:2}.chart .dotnum{font-size:11px;font-weight:700;fill:var(--bg);pointer-events:none}.dotref{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:11px;font-weight:700;}.chart .endlabel{font-size:12px;fill:var(--ink);font-weight:600}
.chart .crosshair{stroke:var(--ink);stroke-width:1;stroke-dasharray:3 3}.chart .hit{fill:transparent;cursor:crosshair}
.chart .hit-dot{fill:transparent}.chart .dot{cursor:help;outline:none}.chart .dot:focus-visible .end,.chart .dot:hover .end{stroke:var(--ink)}
.chart .corner{font-size:12px;fill:var(--ok);font-weight:600}
.hbars{list-style:none;margin:0;padding:0;display:grid;gap:14px}.hbars[hidden]{display:none}
.hb-row{display:grid;gap:5px;outline:none;cursor:help}.hb-name{font-size:15px;font-weight:650;letter-spacing:-.01em;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hb-track{display:flex;align-items:center;gap:12px;min-height:30px}.hb-bar{display:flex;height:30px;border-radius:99px;overflow:hidden;min-width:8px;background:repeating-linear-gradient(45deg,var(--c) 0 3px,color-mix(in srgb,var(--c) 22%,var(--bg)) 3px 7px);transition:width .5s cubic-bezier(.2,.8,.2,1)}
.hb-initial{display:block;height:100%;background:var(--c)}.hb-value{font-size:20px;font-weight:650;letter-spacing:-.02em;white-space:nowrap;font-variant-numeric:tabular-nums}
.hb-value small{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:0}
.hb-row:hover .hb-bar,.hb-row:focus-visible .hb-bar{filter:brightness(1.08)}.hb-row:focus-visible{outline:3px solid var(--orange);outline-offset:4px;border-radius:8px}
.hb-flag{font-size:11px;font-weight:700;border-radius:99px;padding:2px 8px;background:#e3e6dc;color:var(--muted)}.hb-flag.ko{background:#f3d3cc;color:var(--ko)}
.hb-row.unknown .hb-track{min-height:30px}
@media print{.hbars{gap:8px}.hb-bar,.hb-track{height:22px;min-height:22px}.hb-value{font-size:15px}.hb-name{font-size:13px}}
.k.solid{background:var(--ink)}.k.hatched{background:repeating-linear-gradient(45deg,var(--ink) 0 2px,transparent 2px 5px);border:1px solid var(--ink)}
.ranking{list-style:none;margin:0;padding:0}.ranking li{display:grid;grid-template-columns:36px 22px 1fr auto;gap:4px 8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.ranking .muted{grid-column:3 / span 2}.ranking .score{font-weight:700;font-variant-numeric:tabular-nums}.ranking .rk{font-weight:700}
@media print{.metric-switch{display:none}.chart-slide .chart svg{max-height:420px}}
`;

/** Metric switch + crosshair tooltip (values of every series at the hovered agent time). */

type BarMetric = { key: 'cost' | 'time' | 'tokens'; label: string; best: string; fmt: (v: number) => string; axis: (v: number) => string };

const barMetrics = (): BarMetric[] => [
  { key: 'cost', label: tr('Coût éq. API', 'API-equiv. cost'), best: tr('le moins cher', 'cheapest'), fmt: fmtUsd, axis: fmtUsd },
  { key: 'time', label: tr('Temps', 'Time'), best: tr('le plus rapide', 'fastest'), fmt: fmtTime, axis: fmtTime },
  { key: 'tokens', label: tr('Tokens générés', 'Tokens generated'), best: tr('le plus sobre', 'leanest'), fmt: fmtTok, axis: fmtTok },
];

/** First turn and fix rounds of a job, for one metric; null when unknown. */
function barParts(j: Job, key: BarMetric['key']): { initial: number; rework: number } | null {
  const s = j.split;
  if (key === 'time') return s ? { initial: s.initial.timeMs / 1000, rework: s.rework.timeMs / 1000 } : null;
  if (key === 'cost') return s && s.initial.costUsd !== null && s.rework.costUsd !== null ? { initial: s.initial.costUsd, rework: s.rework.costUsd } : null;
  const phases = j.measure?.byPhase;
  if (!phases?.length) return null;
  const out = (pred: (p: string) => boolean) => phases.filter((b) => pred(b.phase)).reduce((n, b) => n + b.usage.output, 0);
  return { initial: out((p) => p === 'build'), rework: out((p) => p.startsWith('fix-')) };
}

/**
 * One project, the way product launches compare performance: one horizontal bar per model, best
 * on top, the value at the end of the bar. One metric at a time (cost, time, generated tokens);
 * each bar splits the first turn (solid) from the fix rounds (hatched).
 */
export function projectBars(taskTitle: string, taskId: string, jobs: Job[], colors: Record<string, string>): string {
  if (!jobs.length) return '';
  const layers = barMetrics().map((metric, mi) => {
    const rows = jobs.map((j) => ({ j, v: barParts(j, metric.key) }));
    const known = rows.filter((r) => r.v !== null).sort((a, b) => a.v!.initial + a.v!.rework - (b.v!.initial + b.v!.rework));
    const unknown = rows.filter((r) => r.v === null);
    const max = Math.max(...known.map((r) => r.v!.initial + r.v!.rework), 0) || 1;
    const pct = (v: number) => `${((v / max) * 82).toFixed(2)}%`;
    // The mention goes to the first product that works and was not contaminated.
    const bestJob = known.find((r) => r.j.verdict === 'works' && !r.j.leaks?.length)?.j;
    const items = [...known, ...unknown].map(({ j, v }) => {
      const name = seriesName(j);
      const flags = `${j.leaks?.length ? ` <span class="hb-flag ko">${tr('contaminé', 'contaminated')}</span>` : ''}${j.verdict !== 'works' ? ` <span class="hb-flag">${j.status === 'timeout' ? tr('délai dépassé', 'timed out') : tr('bugs restants', 'bugs left')}</span>` : ''}`;
      if (!v) return `<li class="hb-row unknown"><div class="hb-name">${esc(name)}${flags}</div><div class="hb-track"><span class="hb-value muted">${tr('non chiffré', 'not priced')}</span></div></li>`;
      const total = v.initial + v.rework;
      const tip = `${name}\n${metric.label} : ${metric.fmt(total)}\n${tr('premier jet', 'first try')} : ${metric.fmt(v.initial)}${v.rework ? `\n${tr('reprise', 'rework')} : ${metric.fmt(v.rework)}` : ''}${j.leaks?.length ? `\n⚠️ ${tr('contaminé : non comparable', 'contaminated: not comparable')}` : ''}`;
      return `<li class="hb-row" tabindex="0" data-tip="${esc(tip)}" style="--c:${colors[j.model]}">
        <div class="hb-name">${esc(name)}${flags}</div>
        <div class="hb-track"><span class="hb-bar" style="width:${pct(total)}"><span class="hb-initial" style="width:${((v.initial / total) * 100).toFixed(2)}%"></span>${v.rework ? '<span class="hb-rework"></span>' : ''}</span><span class="hb-value">${esc(metric.fmt(total))}${j === bestJob ? `<small> · ${esc(metric.best)}</small>` : ''}</span></div>
      </li>`;
    }).join('');
    return `<ol class="hbars" data-metric="${metric.key}"${mi ? ' hidden' : ''}>${items}</ol>`;
  }).join('');
  return `<section class="slide bars-slide"><header><p class="eyebrow">${esc(taskId)} · ${tr('comparaison', 'comparison')}</p><h2>${esc(taskTitle)}</h2></header>
  <div class="chart-head">
    <div class="sortbar metric-switch" role="group" aria-label="${tr('Mesure affichée', 'Shown measure')}">
      ${barMetrics().map((mt, i) => `<button type="button" data-metric="${mt.key}" aria-pressed="${i === 0}">${esc(mt.label)}</button>`).join('')}
    </div>
    <p class="legend"><span class="k solid"></span>${tr('premier jet', 'first try')} <span class="k hatched"></span>${tr('reprise (tours de correction) · plus court = mieux, en haut le meilleur', 'rework (fix rounds) · shorter is better, best on top')}</p>
  </div>
  <div class="hbars-wrap">${layers}</div>
  <p class="muted small">${tr("Jusqu'au produit final : premier jet plus reprise. Survolez une barre pour le détail.", 'Up to the final product: first try plus rework. Hover a bar for details.')}</p>
</section>`;
}

export const BAR_JS = `(()=>{document.querySelectorAll('.bars-slide').forEach(slide=>{slide.querySelectorAll('.metric-switch button').forEach(b=>b.addEventListener('click',()=>{slide.querySelectorAll('.metric-switch button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));slide.querySelectorAll('.hbars[data-metric]').forEach(g=>g.toggleAttribute('hidden',g.dataset.metric!==b.dataset.metric))}))})})();`;
