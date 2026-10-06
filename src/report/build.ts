import { copyFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { loadPrices, normalizeModelId } from '../measure/prices.js';
import { bugTitle, isOpen, type Bug } from '../qa/bugs.js';
import { checkLabel } from '../checks/types.js';
import { disclaimer } from '../format.js';
import { dec, lang, locale, tr } from '../i18n.js';
import { repositoryUrl } from '../paths.js';
import { modeHelp, modeLabel } from '../ui/labels.js';
import { modelLabel } from '../ui/model-label.js';
import { checkReportRules, failedRules, htmlText } from './rules.js';
import { BAR_JS, CHART_CSS, modelColors, projectBars } from './charts.js';
import { cursorPriceModel, isCursorModel } from '../agents/cursor.js';
import { loadRun, type RunData } from './data.js';

type Job = RunData['jobs'][number];

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const usd = (v: number | null | undefined) => (v === null || v === undefined ? tr('non chiffré', 'not priced') : `${dec(v.toFixed(2))} $`);

function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

const verdictInfo = (v: string): [string, string] | undefined =>
  (({
    works: ['OK', 'ok'],
    works_with_bugs: [tr('Bugs restants', 'Bugs left'), 'warn'],
    broken: [tr('Ne fonctionne pas', 'Does not work'), 'ko'],
    abandoned: [tr('Abandonné', 'Abandoned'), 'ko'],
  }) as Record<string, [string, string]>)[v];

const statusLabel = (s: string): string =>
  ({
    confirmed: tr('confirmé', 'confirmed'), unconfirmed: tr('non confirmé', 'unconfirmed'), fixed: tr('corrigé', 'fixed'),
    remaining: tr('restant', 'remaining'), regression: tr('régression', 'regression'), inconclusive: tr('non concluant', 'inconclusive'),
    remark: tr('remarque', 'remark'),
  })[s] ?? s;

/** What an agent looked at that it should not have seen. */
const leakLabel = (kind: string): string =>
  ({
    other_job: tr("dossier d'un autre job", "another job's folder"),
    other_run: tr("dossier d'un autre run", "another run's folder"),
    ailovebench: tr('code ou catalogue de ailovebench (tests cachés compris)', "ailovebench's code or catalog (hidden tests included)"),
    task_ideas: tr('idées de tâches de ailovebench', "ailovebench's task ideas"),
  })[kind] ?? kind;

/** Mode badge with its explanation (and, with a harness, the skills / MCP actually used) on hover. */
const modeBadge = (j: Job) => {
  const partial = j.mode === 'bare' && j.agent === 'cursor';
  const text = `${modeLabel(j.mode)}${partial ? tr(' (partiel)', ' (partial)') : ''}`;
  return `<span class="mode" tabindex="0" data-tip="${esc(`${text}\n${modeHelp(j.mode, j.harness, j.agent)}`)}">${text}</span>`;
};

/** The agent looked at other jobs or at ailovebench's checks: its result is not comparable. */
const contaminated = (j: Job) => Boolean(j.leaks?.length);

const leakTip = (j: Job) =>
  `${tr("Résultat non comparable : l'agent a consulté ce qu'il ne devait pas voir.", 'Not comparable: the agent looked at what it should not have seen.')}\n${(j.leaks ?? [])
    .map((l) => `${leakLabel(l.kind)} : ${l.target} (${l.count}×)`)
    .join('\n')}`;

const verdictBadge = (j: Job) => {
  const leak = contaminated(j) ? ` <span class="badge ko" tabindex="0" data-tip="${esc(leakTip(j))}">${tr('Contaminé', 'Contaminated')}</span>` : '';
  if (!j.verdict) return `<span class="badges"><span class="badge">${esc(j.status)}</span>${leak}</span>`;
  const [label, cls] = verdictInfo(j.verdict)!;
  return `<span class="badges"><span class="badge ${cls}">${label}</span>${leak}</span>`;
};

const finalCost = (j: Job) => j.split?.total.costUsd ?? j.measure?.total.cost.value ?? null;
const agentTime = (j: Job) => j.split?.total.timeMs ?? null;

function quotaUsed(j: Job): string {
  let total = 0;
  let any = false;
  for (const p of j.phases ?? []) {
    const a = p.quotaBefore?.window5hPct;
    const b = p.quotaAfter?.window5hPct;
    if (typeof a === 'number' && typeof b === 'number' && b >= a) {
      total += b - a;
      any = true;
    }
  }
  if (!any) return '—';
  return total < 1 ? '< 1 %' : `${total} %`;
}

const PRICES = loadPrices();
/** Readable model name from the price table (« Claude Sonnet 5.5 »), else the id. */
const shortModel = modelLabel;

/** First screenshot found for the job, copied next to the report. */
async function screenshot(j: Job, assets: string): Promise<string | null> {
  for (const name of ['video-sheet.png', 'page-1440.png', 'webgl-a.png', 'page-768.png', 'page-375.png']) {
    const src = path.join(j.dir, 'qa', 'round-0', name);
    try {
      await access(src);
    } catch {
      continue;
    }
    const file = `${j.id}-${name}`;
    await copyFile(src, path.join(assets, file));
    return `assets/${file}`;
  }
  return null;
}

const tok = (n: number) => (n >= 1_000_000 ? `${dec((n / 1_000_000).toFixed(2))} M` : n >= 1000 ? `${dec((n / 1000).toFixed(1))} k` : String(n));

/** Tooltip lines for a measured phase: tokens by category and API-equivalent cost. */
function usageLines(b: { requests: number; usage: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }; cost: { value: number | null } } | undefined): string[] {
  if (!b) return [tr('tokens : non mesurés', 'tokens: not measured')];
  const u = b.usage;
  const input = tok(u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h);
  return [
    tr(`tokens : ${input} en entrée (dont ${tok(u.cacheRead)} lus en cache) · ${tok(u.output)} en sortie`, `tokens: ${input} in (${tok(u.cacheRead)} read from cache) · ${tok(u.output)} out`),
    tr(`${b.requests} requête${b.requests > 1 ? 's' : ''} · coût éq. API ${usd(b.cost.value)}`, `${b.requests} request${b.requests > 1 ? 's' : ''} · API-equivalent cost ${usd(b.cost.value)}`),
  ];
}

function timeline(j: Job): string {
  const segs: Array<{ kind: string; label: string; start: number; end: number; lines: string[] }> = [];
  for (const p of j.phases ?? []) {
    const bucket = j.measure?.byPhase.find((b) => b.phase === p.name);
    segs.push({
      kind: p.name === 'build' ? 'build' : 'fix',
      label: p.name === 'build' ? `Build · ${shortModel(j.model)}` : `${tr('Correction', 'Fix')} ${p.name.slice(4)} · ${shortModel(j.model)}`,
      start: Date.parse(p.startedAt), end: Date.parse(p.endedAt), lines: usageLines(bucket),
    });
  }
  for (const q of j.qa ?? []) {
    if (q.startedAt && q.endedAt) {
      segs.push({
        kind: 'qa', label: `${tr('Checks automatiques', 'Automatic checks')} · round ${q.round}`, start: Date.parse(q.startedAt), end: Date.parse(q.endedAt),
        lines: [`${q.passed}/${q.results.length} ok`, tr('aucun modèle sollicité : 0 token, 0 $', 'no model involved: 0 tokens, 0 $')],
      });
    }
  }
  for (const p of j.tester?.phases ?? []) {
    segs.push({
      kind: 'tester', label: `${tr('Recette', 'Tester')} · ${shortModel(j.tester!.model)}`, start: Date.parse(p.startedAt), end: Date.parse(p.endedAt),
      lines: [...usageLines(j.tester?.measure?.total), tr('coût de la mesure, hors coût du modèle testé', 'cost of measuring, not counted for the tested model')],
    });
  }
  const valid = segs.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start).sort((a, b) => a.start - b.start);
  if (!valid.length) return '';
  const t0 = valid[0]!.start;
  const span = Math.max(1, Math.max(...valid.map((s) => s.end)) - t0);
  const bars = valid
    .map((s) => {
      const left = ((s.start - t0) / span) * 100;
      const width = Math.max(0.8, ((s.end - s.start) / span) * 100);
      const tip = [s.label, `${tr('durée', 'duration')} : ${dur(s.end - s.start)}`, ...s.lines].join('\n');
      return `<div class="seg ${s.kind}" tabindex="0" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" data-tip="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ' · '))}"></div>`;
    })
    .join('');
  return `<div class="timeline">${bars}</div>
  <div class="legend"><span class="k build"></span>build <span class="k fix"></span>fix (agent) <span class="k qa"></span>checks <span class="k tester"></span>${tr('recette', 'tester')} — total ${dur(span)} <span class="hint">· ${tr('survole un segment pour le détail', 'hover a segment for details')}</span></div>`;
}

function bugList(bugs: Bug[]): string {
  if (!bugs.length) return `<p class="muted">${tr('Aucun bug relevé.', 'No bug found.')}</p>`;
  return `<ul class="bugs">${bugs
    .map((b) => `<li><span class="st ${b.status}">${statusLabel(b.status)}${b.fixedInRound ? ` · ${tr('tour', 'round')} ${b.fixedInRound}` : ''}</span> ${esc(bugTitle(b))} <span class="muted">(${b.source === 'check' ? 'check' : `${tr('recette', 'tester')}${b.severity ? `, ${b.severity}` : ''}`})</span></li>`)
    .join('')}</ul>`;
}


/** A proof as a reader understands it: the test name, or the check's label. */
function proofLabel(proof: string, j: Job): string {
  const [checkId, test] = proof.split(/:(.*)/s) as [string, string | undefined];
  const r = j.qa?.[0]?.baseline?.results.find((x) => x.id === checkId);
  return test ?? (r ? checkLabel(r) : checkId);
}

/** « 12/12 corrigés », for the job slide. */
function knownBugsLine(j: Job): string | null {
  const kb = j.knownBugs;
  if (!kb?.length) return null;
  const detected = kb.filter((b) => b.atStart === 'present').length;
  const fixed = kb.filter((b) => b.atStart === 'present' && b.atEnd === 'absent').length;
  return tr(
    `${fixed}/${detected} corrigés <span class="muted">(${detected} détectés sur la version d'origine${detected < kb.length ? `, ${kb.length - detected} non reproduits` : ''})</span>`,
    `${fixed}/${detected} fixed <span class="muted">(${detected} found on the original version${detected < kb.length ? `, ${kb.length - detected} not reproduced` : ''})</span>`,
  );
}

/**
 * Repair tasks: the bugs planted in the starter, each explained, detected on the original version
 * by the bench itself, then checked on every model's version.
 */
function knownBugsSlide(jobs: Job[]): string {
  const ref = jobs.find((j) => j.knownBugs?.length);
  if (!ref) return '';
  const bugs = ref.knownBugs!;
  const cols = jobs.filter((j) => j.knownBugs?.length);
  const fixedCount = (j: Job) => j.knownBugs!.filter((b) => b.atStart === 'present' && b.atEnd === 'absent').length;
  const detected = bugs.filter((b) => b.atStart === 'present').length;
  const score = cols.map((j) => {
    const n = fixedCount(j);
    return `<li class="${n === detected ? 'all' : 'some'}"><strong>${n}/${detected}</strong> ${esc(shortModel(j.model))}</li>`;
  }).join('');
  const cards = bugs.map((b, i) => {
    const left = cols.filter((j) => j.knownBugs!.find((x) => x.id === b.id)?.atEnd !== 'absent');
    const status = b.atStart !== 'present'
      ? `<p class="kb-status muted">${tr("non reproduit sur la version d'origine", 'not reproduced on the original version')}</p>`
      : left.length === 0
        ? `<p class="kb-status ok">✓ ${cols.length > 1 ? tr(`corrigé par les ${cols.length} modèles`, `fixed by all ${cols.length} models`) : tr('corrigé par le modèle', 'fixed by the model')}</p>`
        : `<p class="kb-status ko">✗ ${tr('restant chez', 'left in')} ${esc(left.map((j) => shortModel(j.model)).join(', '))}</p>`;
    const tip = `${b.title}\n${b.proofs.length ? `${tr('Détecté par', 'Found by')} : ${b.proofs.map((p) => proofLabel(p, ref)).join(' · ')}` : tr("Non reproduit sur la version d'origine", 'Not reproduced on the original version')}`;
    return `<article class="kb-card" tabindex="0" data-tip="${esc(tip)}"><span class="num">${String(i + 1).padStart(2, '0')}</span>
      <h3>${esc(b.title)}</h3>${b.symptom ? `<p>${esc(b.symptom)}</p>` : ''}${b.where ? `<code>${esc(b.where)}</code>` : ''}${status}</article>`;
  }).join('');
  return `<section class="slide known-bugs"><header><p class="eyebrow">${esc(ref.task.id)} · ${tr('bugs de départ', 'starting bugs')}</p><h2>${tr(`${detected} bugs plantés, à trouver et corriger`, `${detected} planted bugs to find and fix`)}</h2></header>
  <p class="lead">${tr("La version d'origine est livrée avec ces bugs. Le bench les a tous vérifiés sur elle avant de lancer les agents, puis à nouveau sur la version de chaque modèle.", 'The original version ships with these bugs. The bench checked every one of them on it before starting the agents, then again on each model\'s version.')}</p>
  <ul class="kb-score" aria-label="${tr('Bugs corrigés par modèle', 'Bugs fixed per model')}">${score}</ul>
  <div class="kb-grid">${cards}</div>
</section>`;
}

/** Opens the case studies: one slide per job, grouped by project, with a jump list. */
function caseIntroSlide(jobs: Job[]): string {
  const tasks = [...new Map(jobs.map((j) => [j.task.id, j.task.title])).entries()];
  return `<section class="slide case-intro" id="jobs"><header><p class="eyebrow">${tr('Au cas par cas', 'Case by case')}</p></header>
  <div class="case-hero"><h1>${tr('Au cas par cas.', 'Case by case.')}</h1>
  <p class="lead">${tr("Une slide par modèle et par projet : le produit livré, ce qu'il a coûté, le temps passé, les bugs trouvés et ce que l'agent dit avoir fait.", 'One slide per model and project: the product delivered, what it cost, the time spent, the bugs found and what the agent says it did.')}</p></div>
  <div class="case-index">${tasks.map(([id, title]) => `<div><h3>${esc(title)}</h3><ul>${jobs.filter((j) => j.task.id === id).map((j) => `<li><a href="#job-${esc(j.id)}">${esc(shortModel(j.model))}</a> ${verdictBadge(j)}</li>`).join('')}</ul></div>`).join('')}</div>
</section>`;
}


/** Every model's product for one project, side by side (the full slides follow). */
function gallerySlide(jobs: Job[], shots: Map<string, string | null>): string {
  if (!jobs.length) return '';
  const task = jobs[0]!.task;
  const cards = jobs.map((j) => {
    const img = shots.get(j.id);
    const media = img
      ? `<a class="img" href="${esc(demoHref(j))}" data-job="${esc(j.id)}" target="_blank" rel="noopener"><img src="${img}" alt="${tr('Produit livré par', 'Product delivered by')} ${esc(shortModel(j.model))}" loading="lazy"></a>`
      : `<div class="missing">${tr('pas de capture', 'no screenshot')}</div>`;
    return `<figure>${media}<figcaption><strong>${esc(shortModel(j.model))}</strong>${verdictBadge(j)} <span class="muted">${dur(agentTime(j))} · ${usd(finalCost(j))}</span><a class="case-link" href="#job-${esc(j.id)}">${tr('Étude du cas', 'Case study')} →</a></figcaption></figure>`;
  }).join('');
  return `<section class="slide" id="gallery-${esc(task.id)}">
  <header><p class="eyebrow">${esc(task.id)} · ${tr('produits livrés', 'delivered products')}</p><h2>${tr('Les rendus', 'The results')} · ${esc(task.title)}</h2></header>
  <p class="lead">${tr('Une capture par modèle : cliquez dessus pour ouvrir le projet dans un nouvel onglet. Le verdict vient des checks, pas de la capture.', 'One screenshot per model: click it to open the project in a new tab. The verdict comes from the checks, not from the screenshot.')}</p>
  <div class="gallery">${cards}</div>
</section>`;
}

/** Served URL when the run is showcased, else the built file next to the run. */
let DEMO_URLS: Record<string, string> = {};
const demoHref = (j: Job) => DEMO_URLS[j.id] ?? path.join('..', path.basename(j.dir), 'work', 'dist', 'index.html');

/** Link to the delivered video, next to the demo page, when the task asked for one. */
function videoHref(j: Job): string | null {
  const file = j.qa?.[0]?.results.find((r) => r.id === 'video.exists' && r.status === 'pass')?.detail;
  if (!file) return null;
  const demo = demoHref(j);
  return /^https?:/.test(demo) ? new URL(file, demo).href : path.join(path.dirname(demo), file);
}

/** One slide per job that went through fix rounds: what was sent, what the agent says, what was verified. */
function fixesSlide(j: Job): string {
  const fixes = (j.phases ?? []).filter((p) => p.name.startsWith('fix-'));
  if (!fixes.length) return '';
  const byId = new Map((j.bugs ?? []).map((b) => [b.id, b]));
  const rows = fixes
    .map((p) => {
      const round = Number(p.name.slice(4));
      const sent = (p.bugsSent ?? []).map((id) => byId.get(id)).filter((b): b is Bug => !!b);
      const verdicts = sent
        .map((b) => {
          const fixedHere = b.fixedInRound === round;
          const label = fixedHere ? tr('corrigé', 'fixed') : b.status === 'inconclusive' ? tr('non concluant', 'inconclusive') : tr('toujours présent', 'still there');
          return `<li><span class="st ${fixedHere ? 'fixed' : b.status === 'inconclusive' ? 'inconclusive' : 'remaining'}">${label}</span> ${esc(bugTitle(b))}</li>`;
        })
        .join('');
      const cost = j.measure?.byPhase.find((b) => b.phase === p.name)?.cost.value;
      return `<tr><td><strong>${tr('Tour', 'Round')} ${round}</strong><br><span class="muted">${dur(Date.parse(p.endedAt) - Date.parse(p.startedAt))}${cost !== null && cost !== undefined ? ` · ${usd(cost)}` : ''}</span></td>
        <td><ul class="bugs">${verdicts || '<li class="muted">—</li>'}</ul></td>
        <td class="agent-summary">${p.summary ? markdown(p.summary) : '—'}</td></tr>`;
    })
    .join('');
  return `<section class="slide fixes"><header><p class="eyebrow">${esc(j.task.id)} · ${tr('corrections', 'fixes')}</p>
  <h2>${esc(shortModel(j.model))} ${modeBadge(j)} ${verdictBadge(j)}</h2></header>
  <div class="tablewrap"><table class="summary"><thead><tr><th>${tr('Tour', 'Round')}</th><th>${tr('Bugs envoyés → constat après revérification', 'Bugs sent → status after re-checking')}</th><th>${tr("Message de l'agent en fin de tour", "Agent's message at the end of the round")}</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="muted small">${tr("Le constat vient de la revérification automatique (checks et scripts de reproduction rejoués), pas de ce que l'agent affirme. Le message peut être une annonce plutôt qu'un bilan : certains agents annoncent puis terminent sans résumer.", 'The status comes from automatic re-checking (checks and reproduction scripts replayed), not from what the agent claims. The message may be an announcement rather than a summary: some agents announce, then finish without summing up.')}</p></section>`;
}

/** Before / after (repair tasks): the buggy starter's capture, copied next to the report. */
async function beforeShot(j: Job, assets: string): Promise<string | null> {
  for (const name of ['before-1440.png', 'before-375.png']) {
    const src = path.join(j.dir, 'qa', 'before', name);
    try {
      await access(src);
    } catch {
      continue;
    }
    const file = `${j.id}-${name}`;
    await copyFile(src, path.join(assets, file));
    return `assets/${file}`;
  }
  return null;
}

async function jobSlide(j: Job, assets: string): Promise<string> {
  const img = await screenshot(j, assets);
  const before = await beforeShot(j, assets);
  const last = j.qa?.at(-1);
  const first = j.qa?.[0];
  const checks = first
    ? `${first.passed}/${first.results.length} ${tr('au premier jet', 'on the first try')}${last && last !== first ? ` · ${last.passed}/${last.results.length} ${tr(`après ${last.round} tour(s) de fix`, `after ${last.round} fix round(s)`)}` : ''}`
    : tr('pas de QA', 'no QA');
  const split = j.split;
  const demo = demoHref(j);
  return `<section class="slide job" id="job-${esc(j.id)}">
  <header><p class="eyebrow">${esc(j.task.id)} · ${esc(j.task.category)}</p>
  <h2>${esc(shortModel(j.model))} ${modeBadge(j)} ${verdictBadge(j)}</h2></header>
  <div class="cols">
    <div class="col">
      ${before
        ? `<div class="ba">
          <figure><img class="shot" src="${before}" alt="${tr("Version d'origine, avec ses bugs", 'Original version, with its bugs')}"><figcaption>${tr("Avant · version d'origine", 'Before · original version')}</figcaption></figure>
          <figure>${img ? `<img class="shot" src="${img}" alt="${tr('Après correction par', 'After the fix by')} ${esc(j.model)}">` : `<div class="shot empty">${tr('pas de capture', 'no screenshot')}</div>`}<figcaption>${tr('Après · corrigé par', 'After · fixed by')} ${esc(shortModel(j.model))}</figcaption></figure>
        </div>`
        : img ? `<img class="shot" src="${img}" alt="${tr('Capture du produit livré par', 'Screenshot of the product delivered by')} ${esc(j.model)}">` : `<div class="shot empty">${tr('pas de capture', 'no screenshot')}</div>`}
      <p class="muted small"><a href="${esc(demo)}" data-job="${esc(j.id)}" target="_blank" rel="noopener">${tr('Ouvrir la démo', 'Open the demo')} ↗</a>${videoHref(j) ? ` · <a href="${esc(videoHref(j)!)}" target="_blank" rel="noopener">${tr('Voir la vidéo', 'Watch the video')} ↗</a> <span class="muted">${tr('(planche : 10 images à intervalles réguliers)', '(contact sheet: 10 frames at regular intervals)')}</span>` : ''} · effort ${esc(j.effort ?? '—')}</p>
    </div>
    <div class="col">
      <table class="kv">
        <tr><th>${tr('Coût initial', 'Initial cost')}</th><td>${usd(split?.initial.costUsd ?? j.measure?.total.cost.value)} · ${dur(split?.initial.timeMs)}</td></tr>
        <tr><th>${tr('Reprise', 'Rework')}</th><td>${usd(split?.rework.costUsd)} · ${dur(split?.rework.timeMs)}${split?.reworkShare ? ` <span class="muted">(+${Math.round(split.reworkShare * 100)} %)</span>` : ''}</td></tr>
        <tr><th>${tr("Jusqu'au produit final", 'Up to the final product')}</th><td><strong>${usd(split?.total.costUsd ?? j.measure?.total.cost.value)} · ${dur(split?.total.timeMs)}</strong></td></tr>
        <tr><th>${tr('Usage abonnement', 'Subscription usage')}</th><td>${quotaUsed(j)} ${tr('de la fenêtre 5 h', 'of the 5-hour window')}</td></tr>
        <tr><th>Checks</th><td>${checks}</td></tr>
        ${knownBugsLine(j) ? `<tr><th>${tr('Bugs de départ', 'Starting bugs')}</th><td>${knownBugsLine(j)}</td></tr>` : ''}
      </table>
      ${j.phases?.[0]?.summary ? `<h3>${tr("Résumé de l'agent", "Agent's summary")}</h3><div class="agent-summary clamp" tabindex="0" data-tip="${esc(`${tr("Résumé de l'agent", "Agent's summary")}\n${j.phases[0].summary}`)}">${markdown(j.phases[0].summary)}</div>` : ''}
      ${j.knownBugs?.length
        ? `<h3>${tr('Bugs restants ou nouveaux', 'Remaining or new bugs')}</h3>${j.bugs?.length ? bugList(j.bugs) : `<p class="muted">${tr('Aucun : la version livrée passe tous les checks. Le détail des bugs de départ est sur la slide « bugs de départ ».', 'None: the delivered version passes every check. The starting bugs are detailed on the "starting bugs" slide.')}</p>`}`
        : `<h3>Bugs</h3>${bugList(j.bugs ?? [])}`}
      ${!j.tester && j.qa?.length ? `<p class="muted small">${tr('Recette indépendante désactivée sur ce run : seuls les checks automatiques ont cherché des bugs.', 'Independent tester disabled on this run: only the automatic checks looked for bugs.')}</p>` : ''}
      ${j.tester ? `<h3>${tr('Recette', 'Tester')} · ${esc(j.tester.agent)} ${esc(j.tester.model)}</h3>
      <ul class="pros">${j.tester.strengths.slice(0, 4).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <ul class="cons">${j.tester.weaknesses.slice(0, 3).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    </div>
  </div>
  ${timeline(j)}
</section>`;
}



/** Served by the showcase: open each project on its own port (demos.json is written next to the report). */
const DEMO_JS = `(()=>{if(!/^https?:/.test(location.protocol))return;fetch('demos.json',{cache:'no-store'}).then(r=>r.ok?r.json():{}).then(urls=>{document.querySelectorAll('a[data-job]').forEach(a=>{const u=urls[a.dataset.job];if(u)a.href=u})}).catch(()=>{})})();`;

/** Bottom bar: progress, counter, previous / next (keyboard arrows too). Texts in the report's language. */
const navJs = () => `(()=>{const slides=[...document.querySelectorAll('.slide')];if(slides.length<2)return;
const foot=document.createElement('div');foot.className='footer';foot.innerHTML='<span class="progress"></span><span>ailovebench <span class="keyhint">· ← → ${tr('naviguer', 'navigate')}</span></span><span class="controls"><button type="button" data-go="-1" aria-label="${tr('Slide précédente', 'Previous slide')}">←</button><span class="count"></span><button type="button" data-go="1" aria-label="${tr('Slide suivante', 'Next slide')}">→</button></span>';document.body.append(foot);
const bar=foot.querySelector('.progress'),count=foot.querySelector('.count'),prev=foot.querySelector('[data-go="-1"]'),next=foot.querySelector('[data-go="1"]');
let cur=0;const go=i=>{i=Math.max(0,Math.min(slides.length-1,i));slides[i].scrollIntoView({behavior:'smooth'})};
const update=()=>{const y=innerHeight*0.4;let i=0;slides.forEach((s,k)=>{if(s.getBoundingClientRect().top<=y)i=k});cur=i;
bar.style.width=((i+1)/slides.length*100)+'%';count.textContent=(i+1)+' / '+slides.length;prev.disabled=i===0;next.disabled=i===slides.length-1};
foot.addEventListener('click',e=>{const b=e.target.closest('[data-go]');if(b)go(cur+Number(b.dataset.go))});
document.addEventListener('keydown',e=>{if(e.target.closest&&e.target.closest('input,textarea,select'))return;if(e.key==='ArrowRight'){e.preventDefault();go(cur+1)}else if(e.key==='ArrowLeft'){e.preventDefault();go(cur-1)}else if(e.key==='Home'){go(0)}else if(e.key==='End'){go(slides.length-1)}});
addEventListener('scroll',update,{passive:true});addEventListener('resize',update);update();})();`;


function modesSlide(jobs: Job[]): string {
  const pairs = new Map<string, { bare?: Job; harness?: Job }>();
  for (const j of jobs) {
    const k = `${j.task.id}|${j.model}`;
    const e = pairs.get(k) ?? {};
    e[j.mode] = j;
    pairs.set(k, e);
  }
  const both = [...pairs.values()].filter((p) => p.bare && p.harness);
  if (!both.length) return '';
  const rows = both
    .map(({ bare, harness }) => `<tr><td>${esc(bare!.task.id)}</td><td>${esc(shortModel(bare!.model))}</td>
      <td>${verdictBadge(bare!)} ${usd(finalCost(bare!))} · ${dur(agentTime(bare!))}</td>
      <td>${verdictBadge(harness!)} ${usd(finalCost(harness!))} · ${dur(agentTime(harness!))}</td></tr>`)
    .join('');
  return `<section class="slide"><header><p class="eyebrow">${tr('Ton setup', 'Your setup')}</p><h2>${tr('Sans ou avec harness : combien ton setup fait gagner ?', 'Bare or with harness: how much does your setup help?')}</h2></header>
  <div class="tablewrap"><table class="summary"><thead><tr><th>${tr('Projet', 'Project')}</th><th>${tr('Modèle', 'Model')}</th><th>${modeLabel('bare')}</th><th>${modeLabel('harness')}</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="muted">${tr("Avec harness = la config de l'utilisateur (instructions, skills, plugins, MCP, hooks). Sans harness = l'agent sans aucune personnalisation. Survole un badge pour voir les skills réellement utilisées.", "With harness = the user's setup (instructions, skills, plugins, MCP, hooks). Bare = the agent with no customization. Hover a badge to see the skills actually used.")}</p></section>`;
}

function annexSlide(run: RunData): string {
  const prices = PRICES;
  const priceId = (m: string) => (isCursorModel(m) ? cursorPriceModel(m) : normalizeModelId(m));
  const used = [...new Set(run.jobs.flatMap((j) => [j.model, j.tester?.model].filter(Boolean) as string[]).map(priceId))];
  const rows = used
    .map((m) => {
      const p = prices.models[m];
      return p
        ? `<tr><td>${esc(p.label)}</td><td>${p.input}</td><td>${p.cache_read}</td><td>${p.cache_write_5m} / ${p.cache_write_1h}</td><td>${p.output}</td><td>${esc(p.checked_at)}</td></tr>`
        : `<tr><td>${esc(m)}</td><td colspan="5" class="muted">${tr('pas de prix : tokens non chiffrés', 'no price: tokens not priced')}</td></tr>`;
    })
    .join('');
  const notes = run.jobs.flatMap((j) => (j.bugs ?? []).filter((b) => !isOpen(b) && b.status !== 'fixed').map((b) => `<li>${esc(shortModel(j.model))} · ${esc(j.task.id)} : <span class="st ${b.status}">${statusLabel(b.status)}</span> ${esc(bugTitle(b))}</li>`));
  return `<section class="slide annex"><header><p class="eyebrow">${tr('Annexes', 'Appendix')}</p><h2>${tr('Prix et notes', 'Prices and notes')}</h2></header>
  <div>
  <h3>${tr('Prix utilisés ($ / M tokens) · table du', 'Prices used ($ / M tokens) · table of')} ${esc(prices.updated_at)}</h3>
  <div class="table-wrap"><table class="prices"><thead><tr><th>${tr('Modèle', 'Model')}</th><th>${tr('Entrée', 'Input')}</th><th>${tr('Cache lu', 'Cache read')}</th><th>${tr('Écr. cache 5 min / 1 h', 'Cache write 5 min / 1 h')}</th><th>${tr('Sortie', 'Output')}</th><th>${tr('Relevé', 'Checked')}</th></tr></thead><tbody>${rows}</tbody></table></div>
  ${notes.length ? `<h3>${tr('Bugs non retenus', 'Bugs not kept')}</h3><ul class="bugs small">${notes.join('')}</ul>` : ''}
  <p class="muted small">${esc(disclaimer())}</p>
  </div></section>`;
}

/** How the bench works, before any result: what each agent gets and how its work is judged. */
function methodSlide(run: RunData): string {
  const rounds = run.plan?.maxFixRounds ?? 3;
  const steps: Array<[string, string]> = [
    [tr('Même départ', 'Same start'), tr("Chaque agent travaille seul dans un dossier jetable, avec l'abonnement de l'utilisateur. Même prompt, mêmes règles d'autonomie, même effort de raisonnement.", "Each agent works alone in a throwaway folder, on the user's own subscription. Same prompt, same autonomy rules, same reasoning effort.")],
    [tr('Sans ou avec harness', 'Bare or with harness'), tr("Sans harness : aucune personnalisation chargée (skills, règles, MCP). Avec harness : la configuration habituelle de l'utilisateur.", "Bare: no customization loaded (skills, rules, MCP). With harness: the user's usual setup.")],
    [tr('Isolé', 'Isolated'), tr("Sur macOS, une sandbox empêche l'agent de lire les autres jobs et les tests du bench. Les transcripts sont aussi vérifiés : un agent qui a regardé est marqué « contaminé ».", 'On macOS, a sandbox keeps the agent from reading other jobs and the bench\'s tests. Transcripts are checked too: an agent that looked is flagged "contaminated".')],
    [tr('Vérifié', 'Checked'), tr("Checks automatiques (build, console, Lighthouse, scénarios, WebGL, tests cachés), puis, si activée, une recette en boîte noire par un modèle d'un autre fournisseur.", 'Automatic checks (build, console, Lighthouse, scenarios, WebGL, hidden tests), then, if enabled, black-box testing by a model from another provider.')],
    [tr('Corrigé', 'Fixed'), tr(`Un bug compte s'il est reproduit deux fois. Les bugs confirmés repartent à l'agent, dans la même session, jusqu'à ${rounds} tours. Les défauts hors cahier des charges restent des remarques.`, `A bug counts if it reproduces twice. Confirmed bugs go back to the agent, in the same session, for up to ${rounds} rounds. Defects outside the spec stay remarks.`)],
    [tr('Mesuré', 'Measured'), tr("Tokens lus dans les transcripts, convertis en coût équivalent API avec une table de prix datée ; temps de l'agent ; quota de l'abonnement relevé avant et après chaque phase.", "Tokens read from the transcripts, turned into an API-equivalent cost with a dated price table; the agent's time; the subscription quota read before and after each phase.")],
  ];
  return `<section class="slide method-slide"><header><p class="eyebrow">${tr('Méthode', 'Method')}</p><h2>${tr('Comment ce bench est mené', 'How this bench is run')}</h2></header>
  <ol class="steps">${steps.map(([t, d], i) => `<li><span class="num">${String(i + 1).padStart(2, '0')}</span><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('')}</ol>
</section>`;
}

/** Small Markdown subset (headings, lists, bold, paragraphs) for the AI synthesis. */
function markdown(md: string): string {
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])[*_](\S.*?\S|\S)[*_](?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  const out: string[] = [];
  let list = false;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const item = line.match(/^[-*] (.*)$/);
    if (item) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(item[1]!)}</li>`);
      continue;
    }
    if (list) out.push('</ul>');
    list = false;
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
      continue;
    }
    const h = line.match(/^#{1,6} (.*)$/);
    if (h) out.push(`<h3>${inline(h[1]!)}</h3>`);
    else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}


/** Last slide: invite people who found the bench useful to star the repo. Hidden until the repo exists. */
function supportSlide(): string {
  const repo = repositoryUrl();
  if (!repo) return '';
  return `<section class="slide support">
  <p class="eyebrow">ailovebench</p>
  <h2>${tr("Ce bench t'a été utile ?", 'Was this bench useful?')}</h2>
  <p class="lead">${tr("ailovebench est gratuit et open source. Une étoile sur GitHub l'aide à être trouvé par d'autres devs qui veulent tester les modèles sur leurs propres projets.", 'ailovebench is free and open source. A star on GitHub helps other developers who want to test models on their own projects find it.')}</p>
  <p><a class="star" href="${esc(repo)}" target="_blank" rel="noopener">⭐ ${tr('Mettre une étoile sur GitHub', 'Star it on GitHub')}</a></p>
  <p class="muted small">${esc(repo)}</p>
  <p class="muted">Stop trusting AI companies' benchmarks. Do it yourself. Bench yourself.</p>
</section>`;
}

/** Sandbox for every job, none, or a mix (jobs added to an older run). */
function isolationText(jobs: Job[]): string {
  const jailed = jobs.filter((j) => j.isolation === 'sandbox').length;
  const leaks = jobs.filter(contaminated).length;
  const base = jailed === jobs.length
    ? tr('sandbox macOS : chaque agent ne lit que son propre dossier (ni les autres jobs, ni les checks de ailovebench)', "macOS sandbox: each agent only reads its own folder (neither other jobs nor ailovebench's checks)")
    : jailed === 0
      ? tr("aucune sandbox (run antérieur à l'isolation) : transcripts vérifiés après coup", 'no sandbox (run older than isolation): transcripts checked afterwards')
      : tr(`sandbox macOS pour ${jailed}/${jobs.length} jobs ; les autres, antérieurs, sont vérifiés après coup dans leurs transcripts`, `macOS sandbox for ${jailed}/${jobs.length} jobs; the older ones are checked afterwards in their transcripts`);
  return `${base}${leaks ? tr(` · ${leaks} job(s) contaminé(s), exclu(s) des comparaisons`, ` · ${leaks} contaminated job(s), left out of the comparisons`) : tr(' · aucune contamination détectée', ' · no contamination found')}`;
}

function conditionsSlide(run: RunData, jobs: Job[]): string {
  const m = run.machine ?? {};
  const v = run.versions ?? {};
  const plan = run.plan ?? {};
  const models = [...new Set(jobs.map((j) => j.model))];
  const modes = [...new Set(jobs.map((j) => j.mode))];
  const efforts = [...new Set(jobs.map((j) => j.effort).filter(Boolean))];
  const testers = [...new Set(jobs.map((j) => j.tester?.model).filter(Boolean))] as string[];
  const tester = plan.tester === 'none' || (!plan.tester && !testers.length)
    ? tr('checks automatiques seulement', 'automatic checks only')
    : tr(`testeur indépendant (${testers.map(shortModel).join(', ') || 'autre fournisseur'}) + checks automatiques`, `independent tester (${testers.map(shortModel).join(', ') || 'another provider'}) + automatic checks`);
  const gb = tr('Go', 'GB');
  const gpus = (m.gpus ?? []).map((g: any) => (g.vramGb ? `${g.name} (${g.vramGb} ${gb})` : g.name)).join(', ');
  const row = (k: string, val: string | null | undefined) => (val ? `<tr><th>${esc(k)}</th><td>${esc(val)}</td></tr>` : '');
  const agents = [
    v.claude ? `Claude Code ${v.claude}` : null,
    v.codex ? `Codex ${v.codex}` : null,
    v.cursor ? `Cursor ${v.cursor}` : null,
  ].filter(Boolean).join(' · ');
  return `<section class="slide conditions"><header><p class="eyebrow">${tr('Conditions du bench', 'Bench conditions')}</p><h2>${tr('Machine, agents et réglages', 'Machine, agents and settings')}</h2></header>
  <div class="cols">
    <table class="kv">
      ${row(tr('Système', 'Operating system'), [m.os, m.arch].filter(Boolean).join(' · '))}
      ${row(tr('Processeur', 'Processor'), m.cpu ? `${m.cpu}${m.cores ? ` · ${m.cores} ${tr('cœurs', 'cores')}` : ''}` : null)}
      ${row(tr('Mémoire vive', 'Memory'), m.ramGb ? `${m.ramGb} ${gb}` : null)}
      ${row('GPU', gpus || null)}
      ${row('Node · herdr', [m.node ? `Node ${m.node}` : null, (v.herdr ?? m.herdr) ? `herdr ${v.herdr ?? m.herdr}` : null].filter(Boolean).join(' · ') || null)}
      ${row('Agents', agents || null)}
    </table>
    <table class="kv">
      ${row(tr('Modèles', 'Models'), models.map(shortModel).join(' · '))}
      ${row(tr('Effort de raisonnement', 'Reasoning effort'), efforts.join(' · ') || null)}
      ${row('Modes', modes.map(modeLabel).join(' · '))}
      ${row(tr('Recette', 'Testing'), `${tester}${plan.maxFixRounds !== undefined ? tr(` · ${plan.maxFixRounds} tours de fix max`, ` · up to ${plan.maxFixRounds} fix rounds`) : ''}`)}
      ${row(tr('Exécution', 'Execution'), plan.sequential ? tr('séquentielle (un job à la fois)', 'sequential (one job at a time)') : tr('en vagues : un projet à la fois, modèles en parallèle', 'in waves: one project at a time, models in parallel'))}
      ${row(tr('Isolation des agents', 'Agent isolation'), isolationText(jobs))}
      ${row(tr('Table de prix', 'Price table'), run.pricesUpdatedAt ? tr(`relevée le ${run.pricesUpdatedAt}`, `checked on ${run.pricesUpdatedAt}`) : null)}
    </table>
  </div>
  <p class="muted small">${tr("Un résultat n'a de sens qu'avec ses conditions : même modèle, autre machine ou autre jour → autres résultats.", 'A result only means something with its conditions: same model, another machine or another day → other results.')}</p>
</section>`;
}

function coverSlide(run: RunData): string {
  const m = run.machine;
  const models = [...new Set(run.jobs.map((j) => shortModel(j.model)))];
  const tasks = [...new Map(run.jobs.map((j) => [j.task.id, j.task.title])).entries()];
  const date = run.startedAt ? new Date(run.startedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const s = (n: number) => (n > 1 ? 's' : '');
  return `<section class="slide cover">
  <p class="eyebrow">ailovebench · ${tr("benchmark de modèles d'IA", 'AI model benchmark')}</p>
  <div class="hero">
    <div>
      <h1>${tr(`${tasks.length} projet${s(tasks.length)}, ${models.length} modèle${s(models.length)}, une machine.`, `${tasks.length} project${s(tasks.length)}, ${models.length} model${s(models.length)}, one machine.`)}</h1>
      <p class="lead">${esc(models.join(' · '))}</p>
      <p class="facts">${esc(date)}${m ? ` · ${esc(m.os)} · ${esc(m.cpu)} · ${esc(m.ramGb)} ${tr('Go RAM', 'GB RAM')}` : ''}${run.versions ? ` · Claude Code ${esc(run.versions.claude ?? '—')} · Codex ${esc(run.versions.codex ?? '—')}${run.versions.cursor ? ` · Cursor ${esc(run.versions.cursor)}` : ''} · herdr ${esc(run.versions.herdr ?? '—')}` : ''}</p>
    </div>
    <div class="hero-art" aria-label="${run.jobs.length} ${tr('exécutions', 'runs')}"><span>${run.jobs.length}</span><small>${tr('exécutions', 'runs')}</small></div>
  </div>
  <nav class="chips" aria-label="${tr('Projets', 'Projects')}">${tasks.map(([id, title]) => `<a href="#gallery-${esc(id)}">${esc(title)} →</a>`).join('')}</nav>
  <p class="warning">${tr(`${run.jobs.length} tests, une machine, une date : une indication, pas un classement.`, `${run.jobs.length} tests, one machine, one date: an indication, not a ranking.`)}</p>
</section>`;
}

const CSS = `
:root{--bg:#f5f2ea;--alt:#e8ece2;--card:rgba(255,255,255,.6);--card-solid:#fbfaf6;--ink:#232821;--muted:#60675c;--line:#d5d9cd;--accent:#d4f576;--green:#245b40;--terra:#245b40;--orange:#a54620;--ok:#194d31;--warn:#813516;--ko:#9d2f22;--code:#e6e9de}
*{box-sizing:border-box}html{scroll-snap-type:y proximity;scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:var(--green)}button{font:inherit}button:focus-visible,a:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--orange);outline-offset:3px}
.slide{min-height:100svh;scroll-snap-align:start;padding:32px 5vw 96px;display:flex;flex-direction:column;gap:20px;position:relative}
.slide:nth-of-type(even){background:var(--alt)}
@media (min-width:1440px){.slide{padding-left:max(5vw,calc((100vw - 1300px)/2));padding-right:max(5vw,calc((100vw - 1300px)/2))}}
.eyebrow{text-transform:uppercase;letter-spacing:.15em;font-size:12px;font-weight:700;color:var(--ink);margin:0;display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:16px}
.eyebrow::after{content:var(--run-label);color:var(--ink);white-space:nowrap}
h1,h2,h3,p{margin:0}
h1{font-size:clamp(52px,7vw,100px);letter-spacing:-.065em;line-height:.98;font-weight:650}
h2{font-size:clamp(30px,3.6vw,50px);letter-spacing:-.045em;line-height:1.1;font-weight:650;margin:22px 0 4px;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
h3{font-size:17px;letter-spacing:-.02em;margin:18px 0 6px;color:var(--ink)}
.lead{font-size:19px;line-height:1.5;color:var(--muted);max-width:870px}.muted{color:var(--muted)}.small{font-size:13px}
.cover{justify-content:flex-start}.hero{display:grid;grid-template-columns:1.25fr 1fr;gap:4vw;align-items:center;min-height:440px;flex:1}
.hero p.lead{margin-top:26px;max-width:630px;color:var(--ink)}.hero .facts{margin-top:14px;font-size:14px;color:var(--muted)}
.hero-art{position:relative;background:#11170f;border-radius:50%;aspect-ratio:1;max-width:400px;width:100%;justify-self:center;display:grid;place-items:center;box-shadow:inset 0 0 0 1px #7e9261}
.hero-art::before,.hero-art::after{content:"";position:absolute;border:1px solid #6c8052;border-radius:50%;width:80%;height:80%;transform:rotate(-30deg) scaleY(.55)}.hero-art::after{width:110%;height:110%;transform:rotate(35deg) scaleY(.55)}
.hero-art span{font-size:clamp(65px,8vw,116px);letter-spacing:-.07em;color:var(--accent);z-index:1;font-weight:500}.hero-art small{position:absolute;bottom:22%;color:#c2d0ad;letter-spacing:.1em;font-size:12px;text-transform:uppercase}
.chips{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.chips a{border:1px solid var(--line);text-decoration:none;color:var(--ink);border-radius:99px;padding:9px 14px;font-size:13px}.chips a:hover{background:var(--accent)}
.warning,.notice{border-left:4px solid var(--green);padding:13px 18px;background:var(--card);font-size:16px;line-height:1.5;max-width:none}
.tablewrap,.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{text-transform:uppercase;letter-spacing:.06em;font-size:10px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--ink)}
.summary{font-size:14px}.summary td{vertical-align:middle}.summary td.num{white-space:nowrap}@media (max-width:1200px){.summary{font-size:13px}.summary th,.summary td{padding:8px}}
.badge{display:inline-block;border-radius:99px;font-size:11px;font-weight:700;padding:5px 10px;white-space:nowrap;background:#e3e6dc;color:var(--ink);letter-spacing:0}
.badge.ok{background:#dbe9d9;color:var(--ok)}.badge.warn{background:#f6decc;color:var(--warn)}.badge.ko{background:#f3d3cc;color:var(--ko)}
.mode{font-size:12px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:3px 10px;cursor:help;white-space:nowrap;letter-spacing:0}
.cols{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:32px}.cols>*{min-width:0}@media (max-width:900px){.cols{grid-template-columns:1fr}}
.shot{width:100%;max-height:420px;object-fit:cover;object-position:top;border-radius:12px;border:1px solid var(--line);background:var(--card-solid)}.shot.empty{display:grid;place-items:center;height:240px;color:var(--muted)}
.kv{align-self:start}.kv,.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;border-collapse:separate;border-spacing:0;overflow:hidden}.kv th{width:42%;color:var(--muted);font-weight:500;text-transform:none;letter-spacing:0;font-size:14px;border-bottom:1px solid var(--line)}.kv tr:last-child th,.kv tr:last-child td{border-bottom:0}
.panel{padding:22px}
ul{margin:0;padding-left:20px}.bugs{list-style:none;padding:0}.bugs li{margin:4px 0}

code{font-size:.9em;background:var(--code);padding:0 4px;border-radius:4px}
.st{display:inline-block;white-space:nowrap;font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px;background:#e3e6dc}.st.fixed{background:#dbe9d9;color:var(--ok)}.st.remaining,.st.regression,.st.confirmed{background:#f3d3cc;color:var(--ko)}.st.remark,.st.inconclusive,.st.unconfirmed{background:#e9ebe3;color:var(--muted)}
.pros li::marker{content:"+ ";color:var(--ok)}.cons li::marker{content:"− ";color:var(--ko)}
.timeline{position:relative;height:22px;background:var(--card-solid);border:1px solid var(--line);border-radius:99px;overflow:hidden}.seg{position:absolute;top:0;bottom:0}
.seg.build,.k.build{background:var(--green)}.seg.fix,.k.fix{background:#c9824f}.seg.qa,.k.qa{background:#a9bd96}.seg.tester,.k.tester{background:#c8b8a2}
.seg{cursor:help}.seg:hover,.seg:focus-visible{filter:brightness(1.12);outline:2px solid var(--ink);outline-offset:-2px;z-index:2}
#tip{position:fixed;z-index:50;max-width:380px;background:var(--ink);color:#f5f2ea;padding:10px 12px;border-radius:10px;font-size:12.5px;line-height:1.45;white-space:pre-line;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.25)}#tip strong{display:block;font-size:13px;margin-bottom:2px}
.legend{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap}.k{display:inline-block;width:12px;height:12px;border-radius:3px;margin-left:8px}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ba figure{margin:0}.ba .shot{max-height:340px}.ba figcaption{font-size:12px;color:var(--muted);margin-top:4px}
.sortbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.sortbar button{font-size:13px;padding:8px 15px;border-radius:99px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}.sortbar button:hover{background:var(--accent)}.sortbar button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}

.gallery{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px}.gallery figure{margin:0;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.gallery a.img{display:block;height:150px;background:#e0e3da}.gallery img{width:100%;height:100%;object-fit:cover;object-position:top;display:block}
.gallery figcaption{font-size:12px;padding:10px;line-height:1.4}.gallery figcaption strong{display:block}.gallery .missing{height:150px;display:grid;place-items:center;background:repeating-linear-gradient(135deg,#e8eade,#e8eade 10px,#f3f4eb 10px,#f3f4eb 20px);color:var(--muted);font-size:13px}
@media (max-width:1000px){.gallery{grid-template-columns:repeat(2,minmax(0,1fr))}}

.footer{position:fixed;bottom:0;left:0;right:0;z-index:45;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 5vw;background:var(--bg);border-top:1px solid var(--line);font-size:12px}
.footer .controls{display:flex;align-items:center;gap:12px}.footer button{border:1px solid var(--line);border-radius:99px;padding:8px 15px;background:transparent;color:var(--ink);cursor:pointer}.footer button:hover{background:var(--accent)}.footer button:disabled{opacity:.35;cursor:default}
.footer .progress{position:absolute;top:-3px;left:0;height:3px;background:var(--green);transition:width .2s}.footer .keyhint{color:var(--muted)}
@media (max-width:760px){.slide{padding:24px 16px 90px}.hero{grid-template-columns:1fr;gap:30px;min-height:0}.hero-art{max-width:230px}.hero-art span{font-size:70px}h1{font-size:52px}h2{font-size:32px}.footer{padding:10px 16px}.footer .keyhint{display:none}.eyebrow{font-size:10px}.eyebrow::after{display:none}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.footer .progress{transition:none}}
.badges{display:inline-flex;flex-wrap:wrap;gap:6px;vertical-align:middle}.nowrap{white-space:nowrap}
.cover .chips{justify-content:flex-end;margin-top:0}
.steps{list-style:none;margin:8px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.steps li{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}.steps .num,.points .num,.kb-card .num{font-size:13px;font-weight:700;color:var(--green);letter-spacing:.05em}.steps h3{font-size:20px;margin:8px 0 6px}.steps p{font-size:15px;line-height:1.55;color:var(--muted)}
.points{list-style:none;margin:6px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.points li{display:flex;gap:12px;align-items:flex-start;border-top:2px solid var(--ink);padding-top:12px}.points p{font-size:16px;line-height:1.5}
.project-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.project-cards h3{margin:4px 0 6px;font-size:18px}.project-cards p{font-size:14px;line-height:1.55}.eyebrow-sm{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);font-weight:700}
.notes{display:grid;gap:10px}.notice strong{margin-right:4px}
.case-intro{justify-content:flex-start}.case-hero{margin-top:6vh;max-width:900px}.case-hero .lead{margin-top:18px;color:var(--ink)}.case-index{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px;margin-top:auto}.case-index ul{list-style:none;padding:0;margin:6px 0 0;display:grid;gap:6px;font-size:14px}.case-index a{color:var(--ink);font-weight:600}
.gallery figcaption .badges{margin:4px 6px 0 0}.case-link{display:block;margin-top:6px;font-weight:600;text-decoration:none}.case-link:hover{text-decoration:underline}
.kb-score{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px}.kb-score li{border:1px solid var(--line);border-radius:99px;padding:6px 12px;font-size:13px;background:var(--card)}.kb-score li.all strong{color:var(--ok)}.kb-score li.some strong{color:var(--ko)}
.kb-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.kb-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;cursor:help;display:flex;flex-direction:column;gap:6px}.kb-card h3{font-size:15px;margin:0;line-height:1.3}.kb-card p{font-size:13px;line-height:1.45;color:var(--muted)}.kb-card code{font-size:11px;align-self:flex-start}.kb-card .kb-status{margin-top:auto;font-weight:700;font-size:12px}.kb-status.ok{color:var(--ok)}.kb-status.ko{color:var(--ko)}
@media (max-width:1100px){.kb-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.steps{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:640px){.kb-grid,.steps{grid-template-columns:1fr}}
@media print{.kb-grid{gap:8px}.kb-card{padding:10px}.kb-card p{font-size:11px}.steps li{padding:16px}.steps p{font-size:13px}}
.support{justify-content:center;align-items:flex-start}.star{display:inline-block;background:var(--ink);color:var(--accent);text-decoration:none;font-weight:700;font-size:20px;padding:14px 26px;border-radius:999px}.star:hover,.star:focus-visible{background:var(--green);color:#fff}
.agent-summary{font-size:14px}.agent-summary p{margin:0 0 6px}.agent-summary ul{margin:0 0 6px;padding-left:18px}.agent-summary.clamp{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden;cursor:help}.fixes .agent-summary{max-height:none;font-size:13px}
.prose{max-width:860px;font-size:17px}.prose blockquote{margin:8px 0;padding:10px 16px;border-left:4px solid var(--green);background:var(--card)}.prose p{margin:0 0 12px}.prose h3{color:var(--ink)}.method li{margin:8px 0}.prices{font-size:13px}
@media print{html{scroll-snap-type:none;scroll-behavior:auto}@page{size:1280px 720px;margin:0}.footer,#tip,.hint,.sortbar{display:none}.slide{height:720px;min-height:0;overflow:hidden;page-break-after:always;padding:30px 56px;gap:12px}.slide:nth-of-type(even){-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:72px}h2{font-size:36px;margin-top:14px}.hero{min-height:0}.shot{max-height:300px}.job{font-size:13px}.job h3{margin:10px 0 4px}.job .pros li:nth-child(n+3),.job .cons li:nth-child(n+2){display:none}.job .kv th,.job .kv td{padding:6px 10px}.gallery a.img,.gallery .missing{height:120px}}
`;

const TIP_JS = `(()=>{const t=document.createElement('div');t.id='tip';t.hidden=true;document.body.appendChild(t);
const show=(el,x,y)=>{const [h,...r]=el.dataset.tip.split('\\n');t.innerHTML='';const s=document.createElement('strong');s.textContent=h;t.append(s,document.createTextNode(r.join('\\n')));t.hidden=false;
const w=t.offsetWidth,hh=t.offsetHeight;

t.style.left=Math.min(innerWidth-w-8,Math.max(8,x-w/2))+'px';t.style.top=(y-hh-12<8?y+18:y-hh-12)+'px'};
document.addEventListener('mousemove',e=>{const el=e.target.closest&&e.target.closest('[data-tip]');if(el)show(el,e.clientX,e.clientY);else if(!(e.target.closest&&e.target.closest('.hit')))t.hidden=true});
document.addEventListener('focusin',e=>{const el=e.target.closest&&e.target.closest('[data-tip]');if(el){const r=el.getBoundingClientRect();show(el,r.left+r.width/2,r.top)}});
document.addEventListener('focusout',()=>{t.hidden=true});})();`;

const JS = `addEventListener('keydown',e=>{const s=[...document.querySelectorAll('.slide')];const y=scrollY+innerHeight/2;let i=s.findIndex(x=>x.offsetTop<=y&&x.offsetTop+x.offsetHeight>y);if(['ArrowDown','PageDown',' ','ArrowRight'].includes(e.key)){e.preventDefault();s[Math.min(s.length-1,i+1)]?.scrollIntoView({behavior:'smooth'})}if(['ArrowUp','PageUp','ArrowLeft'].includes(e.key)){e.preventDefault();s[Math.max(0,i-1)]?.scrollIntoView({behavior:'smooth'})}})`;

/**
 * Builds `<run>/report/index.html` (self-contained, screenshots in report/assets). `demoUrls`: the
 * URLs the products are served on (showcase), used for the demo links.
 */
export async function buildReport(runDir: string, o: { demoUrls?: Record<string, string> } = {}): Promise<string> {
  DEMO_URLS = o.demoUrls ?? {};
  const run = await loadRun(runDir);
  const outDir = path.join(runDir, 'report');
  const assets = path.join(outDir, 'assets');
  await mkdir(assets, { recursive: true });
  const jobs = [...run.jobs].sort((a, b) => a.task.id.localeCompare(b.task.id) || a.mode.localeCompare(b.mode) || a.model.localeCompare(b.model));
  const colors = modelColors(jobs);
  const jobSlides = await Promise.all(jobs.map(async (j) => (await jobSlide(j, assets)) + fixesSlide(j)));
  const shots = new Map(await Promise.all(jobs.map(async (j) => [j.id, await screenshot(j, assets)] as const)));
  const html = `<!doctype html>
<html lang="${lang()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ailovebench · ${esc(run.runId)}</title><style>${CSS}${CHART_CSS}</style></head>
<body style="--run-label:'${esc(run.runId)}'">
${coverSlide(run)}
${conditionsSlide(run, jobs)}
${methodSlide(run)}
${[...new Set(jobs.map((j) => j.task.id))].map((t) => gallerySlide(jobs.filter((j) => j.task.id === t), shots) + projectBars(jobs.find((j) => j.task.id === t)!.task.title, t, jobs.filter((j) => j.task.id === t), colors) + knownBugsSlide(jobs.filter((j) => j.task.id === t))).join('\n')}
${caseIntroSlide(jobs)}
${jobSlides.join('\n')}
${modesSlide(jobs)}
${annexSlide(run)}
${supportSlide()}
<script>${JS};\n${TIP_JS}\n${BAR_JS}\n${navJs()}\n${DEMO_JS}</script>
</body></html>`;
  const file = path.join(outDir, 'index.html');
  await writeFile(file, html);
  const missing = failedRules(checkReportRules(htmlText(html), run));
  if (missing.length) process.stderr.write(`⚠️ ${tr('Rapport incomplet', 'Incomplete report')} (docs/REPORT_RULES.md) : ${missing.map((c) => c.label).join(', ')}\n`);
  return file;
}
