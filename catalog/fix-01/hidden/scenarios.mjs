// Scenarios of task fix-01 (checkout page), replayed identically on every agent's output.
// Expected amounts follow the README specification.

const fr = (cents) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const has = (text, cents) => norm(text).includes(norm(fr(cents)));

// Starting cart: notebook 14.50 € × 1, pen 3.90 € × 2, stickers 6.00 € × 1 → 28.30 € excl. VAT → 33.96 € incl. VAT.
const TTC_START = 3396;
const TTC_BIENVENUE10 = 3056; // 2830 × 90 / 100 = 2547 → × 1,2 = 3056,4 → 3056

export default async function scenarios({ page, url, check }) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const line = (name) => page.locator('li, tr, [role="listitem"]').filter({ hasText: name }).last();
  const plus = (name) => line(name).getByRole('button', { name: /^\+$|ajouter|augmenter/i }).first();
  const totalRow = async () => norm(await page.getByText(/^Total TTC$/).first().locator('xpath=..').innerText());
  const payText = async () => norm(await page.getByRole('button', { name: /payer/i }).first().innerText());
  const reload = async () => {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(200);
  };

  // 1. Starting totals
  await reload();
  check('line_totals', 'Total de ligne = prix × quantité', has(await line('Stylo bambou').innerText(), 780),
    'Stylo bambou × 2 doit afficher 7,80 €');
  check('total_start', 'Total TTC du panier de départ (33,96 €)', has(await totalRow(), TTC_START), await totalRow());
  check('pay_label', 'Le bouton Payer affiche le total TTC', has(await payText(), TTC_START), await payText());

  // 2. « + » acts on its own line, the last one included
  await reload();
  try {
    await plus('Stylo bambou').click({ timeout: 3000 });
    await page.waitForTimeout(200);
    const stylo = await line('Stylo bambou').innerText();
    const carnet = await line('Carnet Lumio').innerText();
    check('plus_right_line', '« + » change la quantité de sa propre ligne', has(stylo, 1170) && !has(carnet, 2900),
      `Stylo : ${norm(stylo).slice(0, 80)} · Carnet : ${norm(carnet).slice(0, 80)}`);
  } catch (e) {
    check('plus_right_line', '« + » change la quantité de sa propre ligne', false, String(e.message ?? e).split('\n')[0]);
  }
  await reload();
  const before = errors.length;
  try {
    await plus('Pack de stickers').click({ timeout: 3000 });
    await page.waitForTimeout(200);
    check('plus_last_line', '« + » fonctionne sur la dernière ligne', has(await line('Pack de stickers').innerText(), 1200) && errors.length === before,
      errors.slice(before).join(' | ') || undefined);
  } catch (e) {
    check('plus_last_line', '« + » fonctionne sur la dernière ligne', false, String(e.message ?? e).split('\n')[0]);
  }

  // 3. « Retirer » (remove) only removes its own line
  await reload();
  try {
    await line('Carnet Lumio').getByRole('button', { name: /retirer|supprimer/i }).last().click({ timeout: 3000 });
    await page.waitForTimeout(200);
    const body = await page.locator('body').innerText();
    check('remove_one', '« Retirer » ne supprime que sa ligne',
      !body.includes('Carnet Lumio') && body.includes('Stylo bambou') && body.includes('Pack de stickers'));
  } catch (e) {
    check('remove_one', '« Retirer » ne supprime que sa ligne', false, String(e.message ?? e).split('\n')[0]);
  }

  // 4. Promo code: immediate update, an unknown code changes nothing
  await reload();
  await page.getByLabel(/code promo/i).fill('bienvenue10');
  await page.getByRole('button', { name: /appliquer/i }).click();
  await page.waitForTimeout(250);
  check('promo_updates', 'Un code valide met à jour le total tout de suite (30,56 €)', has(await totalRow(), TTC_BIENVENUE10), await totalRow());
  check('promo_pay_label', 'Le bouton Payer suit la remise', has(await payText(), TTC_BIENVENUE10), await payText());
  await reload();
  const totalBefore = await totalRow();
  await page.getByLabel(/code promo/i).fill('GRATUIT');
  await page.getByRole('button', { name: /appliquer/i }).click();
  await page.waitForTimeout(250);
  const body = await page.locator('body').innerText();
  // Compared with the total before, so a wrong starting total does not count twice.
  check('promo_unknown', 'Un code inconnu est signalé et ne change pas le total',
    /code promo inconnu/i.test(body) && (await totalRow()) === totalBefore);

  // 5. Visible keyboard focus on the Pay button
  await reload();
  const pay = page.getByRole('button', { name: /payer/i }).first();
  await pay.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const style = await pay.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0, shadow: s.boxShadow !== 'none' };
  });
  check('focus_visible', 'Focus clavier visible (bouton Payer)', style.outline || style.shadow);

  // 6. Pay button contrast (WCAG AA: 4.5:1 for normal-size text)
  const ratio = await pay.evaluate((el) => {
    const parse = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bgEl = el;
    let bg = parse(getComputedStyle(bgEl).backgroundColor);
    while (bgEl && (bg.length < 3 || bg[3] === 0)) {
      bgEl = bgEl.parentElement;
      bg = bgEl ? parse(getComputedStyle(bgEl).backgroundColor) : [255, 255, 255];
    }
    const fg = parse(getComputedStyle(el).color);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  check('pay_contrast', 'Bouton Payer lisible (contraste ≥ 4,5:1)', ratio >= 4.5, `contraste ${ratio.toFixed(2)}:1`);

  check('no_js_errors', 'Aucune erreur JavaScript pendant les scénarios', errors.length === 0, errors.slice(0, 3).join(' | ') || undefined);
}
