// Scenarios of task web-01, replayed identically on every agent's output.
export default async function scenarios({ page, check }) {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');

  check('lang', 'Page déclarée en français', (await page.getAttribute('html', 'lang'))?.startsWith('fr') === true);
  check('h1', 'Un seul titre h1', (await page.locator('h1').count()) === 1);
  check('cta', 'Bouton « Essayer gratuitement »', /Essayer gratuitement/i.test(text));
  const plans = ['Gratuit', 'Plus', 'Équipe'].filter((p) => text.includes(p));
  check('plans', 'Trois offres (Gratuit, Plus, Équipe)', plans.length === 3, `trouvées : ${plans.join(', ')}`);
  check('prices', 'Prix 4 € et 12 €', /4\s?€/.test(text) && /12\s?€/.test(text));

  // FAQ: the smallest container holding both a « FAQ / questions » heading and collapsible
  // items (the heading may sit in a block separate from the list).
  const toggles = 'summary, [aria-expanded]';
  const toggle = page
    .locator('section, div, article')
    .filter({ has: page.locator('h2, h3', { hasText: /FAQ|questions/i }) })
    .filter({ has: page.locator(toggles) })
    .last()
    .locator(toggles)
    .first();
  if ((await toggle.count()) === 0) {
    check('faq_keyboard', 'FAQ en accordéon utilisable au clavier', false, 'aucun élément repliable trouvé');
    return;
  }
  const isOpen = () =>
    toggle.evaluate((el) =>
      el.tagName === 'SUMMARY' ? el.parentElement.open : el.getAttribute('aria-expanded') === 'true',
    );
  const before = await isOpen();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const after = await isOpen();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const back = await isOpen();
  check('faq_keyboard', 'FAQ en accordéon utilisable au clavier', before !== after && back === before,
    `état : ${before} → Entrée → ${after} → Entrée → ${back}`);
}
