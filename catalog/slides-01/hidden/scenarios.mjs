// Scenarios of task slides-01: one slide at a time, keyboard navigation, everything fits, content.
const SLIDES = 10;
const SETTLE = 700; // transitions between slides

/** Indices of the [data-slide] elements actually on screen. */
const visibleSlides = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-slide]')].flatMap((el, i) => {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return [];
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      return w > 0 && h > 0 && w * h > 0.5 * innerWidth * innerHeight * 0.5 ? [i] : [];
    }),
  );

const press = async (page, key) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(SETTLE);
};

const fresh = async (page, width, height) => {
  await page.setViewportSize({ width, height });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
};

/**
 * Problems of the slide on screen: the slide out of the window, text outside the slide or the
 * window, text clipped by a container, the page scrolling, text too small. One string each.
 */
const inspectCurrent = (page, minFontPx) =>
  page.evaluate((minFontPx) => {
    const out = [];
    const slide = [...document.querySelectorAll('[data-slide]')].find((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getBoundingClientRect().width > 0);
    if (!slide) return ['aucune slide visible'];
    const s = slide.getBoundingClientRect();
    const tol = 2;
    if (s.left < -tol || s.top < -tol || s.right > innerWidth + tol || s.bottom > innerHeight + tol) out.push('la slide sort de la fenêtre');
    const doc = document.documentElement;
    if (doc.scrollHeight > innerHeight + 1 || doc.scrollWidth > innerWidth + 1) out.push('la page défile');
    const scale = slide.offsetWidth ? s.width / slide.offsetWidth : 1;
    const box = { left: Math.max(s.left, 0), top: Math.max(s.top, 0), right: Math.min(s.right, innerWidth), bottom: Math.min(s.bottom, innerHeight) };
    const outside = (r, b) => r.left < b.left - tol || r.top < b.top - tol || r.right > b.right + tol || r.bottom > b.bottom + tol;
    let smallest = Infinity;
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!n.textContent.trim() || !parent?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const sample = `« ${n.textContent.trim().slice(0, 40)} »`;
      if (outside(r, box)) out.push(`texte hors de la slide : ${sample}`);
      else {
        for (let a = parent; a && a !== slide; a = a.parentElement) {
          const st = getComputedStyle(a);
          if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
          if (outside(r, a.getBoundingClientRect())) { out.push(`texte coupé : ${sample}`); break; }
        }
      }
      smallest = Math.min(smallest, parseFloat(getComputedStyle(parent).fontSize) * scale);
    }
    if (minFontPx && smallest < minFontPx) out.push(`texte de ${smallest.toFixed(1)} px`);
    return out;
  }, minFontPx);

export default async function scenarios({ page, check }) {
  check('lang', 'Page déclarée en français', (await page.getAttribute('html', 'lang'))?.startsWith('fr') === true);

  const count = await page.locator('[data-slide]').count();
  check('slide_count', `${SLIDES} slides marquées data-slide`, count === SLIDES, `${count} trouvées`);
  if (count === 0) return;

  // All the deck's text, hidden slides included.
  const text = (await page.locator('[data-slide]').evaluateAll((els) => els.map((e) => e.textContent).join(' '))).replace(/\s+/g, ' ');
  const has = (re) => re.test(text);
  check('traction', 'Chiffres de traction (12 400, 42 %, 4,7/5)', has(/12[\s  ]?400/) && has(/42[\s  ]?%/) && has(/4,7[\s  ]?\/[\s  ]?5/));
  check('pricing', 'Offres Gratuit, Plus 4 €, Équipe 12 €', has(/Gratuit/) && has(/Plus/) && has(/Équipe/) && has(/\b4[\s  ]?€/) && has(/12[\s  ]?€/));
  check('funding', 'Levée de 1,5 M€ (50 / 30 / 20 %)', has(/1,5[\s  ]?M€/) && has(/50[\s  ]?%/) && has(/30[\s  ]?%/) && has(/20[\s  ]?%/));
  check('contact', 'Contact contact@lumio.example', has(/contact@lumio\.example/));

  const slides = page.locator('[data-slide]');
  if (count >= 6) {
    const months = await slides.nth(5).evaluate((el) => (el.textContent ?? '').toLowerCase());
    const labelled = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin'].filter((m) => months.includes(m)).length;
    check('chart_labels', 'Slide 6 : mois et valeurs lisibles', labelled === 6 && /2[\s  ]?100/.test(months) && /12[\s  ]?400/.test(months), `${labelled}/6 mois en texte`);
  }
  if (count >= 7) {
    const table = await slides.nth(6).evaluate((el) => {
      const t = el.querySelector('table, [role="table"]');
      const rows = t ? t.querySelectorAll('tr, [role="row"]').length : 0;
      return { rows, text: el.textContent ?? '' };
    });
    check('comparison', 'Slide 7 : tableau Lumio / HabitPro / DailyLoop', table.rows >= 4 && /HabitPro/.test(table.text) && /DailyLoop/.test(table.text), `${table.rows} lignes de tableau`);
  }

  // Navigation, at 1280×720.
  await fresh(page, 1280, 720);
  const start = await visibleSlides(page);
  check('one_at_a_time', 'Une seule slide visible, la première, au départ', start.length === 1 && start[0] === 0, `visibles : ${start.map((i) => i + 1).join(', ') || 'aucune'}`);
  await press(page, 'ArrowLeft');
  const stayFirst = await visibleSlides(page);
  await press(page, 'ArrowRight');
  const second = await visibleSlides(page);
  await press(page, 'ArrowLeft');
  const backFirst = await visibleSlides(page);
  await press(page, 'Space');
  const spaceSecond = await visibleSlides(page);
  const same = (a, i) => a.length === 1 && a[0] === i;
  check('keyboard_nav', 'Navigation : → et Espace avancent, ← recule', same(stayFirst, 0) && same(second, 1) && same(backFirst, 0) && same(spaceSecond, 1),
    `← ${stayFirst.join()} · → ${second.join()} · ← ${backFirst.join()} · Espace ${spaceSecond.join()} (index depuis 0)`);

  // Walk the whole deck at two sizes: everything fits, the counter follows.
  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await fresh(page, w, h);
    const problems = [];
    let counterOk = true;
    let navOk = true;
    for (let i = 0; i < count; i++) {
      if (i > 0) await press(page, 'ArrowRight');
      const on = await visibleSlides(page);
      if (!same(on, i)) navOk = false;
      for (const p of await inspectCurrent(page, w === 1280 ? 14 : 0)) problems.push(`slide ${i + 1} : ${p}`);
      // Measured on screen: a hidden slide's chart has no size.
      if (w === 1280 && i === 5) {
        const chart = await slides.nth(5).evaluate((el) =>
          [...el.querySelectorAll('svg, canvas')].some((c) => c.getBoundingClientRect().width >= 300),
        );
        check('chart', 'Slide 6 : graphique SVG ou canvas', chart);
      }
      if (w === 1280) {
        const shown = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
        if (!new RegExp(`\\b${i + 1}\\s*/\\s*${SLIDES}\\b`).test(shown)) counterOk = false;
      }
    }
    if (w === 1280) {
      await press(page, 'ArrowRight');
      const last = await visibleSlides(page);
      check('last_stays', 'Sur la dernière slide, → ne fait rien', same(last, count - 1), `visibles : ${last.map((i) => i + 1).join(', ') || 'aucune'}`);
      check('counter', 'Numéro « n / 10 » à jour sur chaque slide', counterOk);
      check('walk', 'Les 10 slides défilent une à une avec →', navOk);
    }
    const label = `${w}×${h}`;
    const unique = [...new Set(problems)];
    check(`fit_${w}`, `Tout tient dans chaque slide à ${label}${w === 1280 ? ', texte ≥ 14 px' : ''}`, unique.length === 0,
      unique.length ? `${unique.length} problème(s) : ${unique.slice(0, 6).join(' · ')}` : undefined);
  }
}
