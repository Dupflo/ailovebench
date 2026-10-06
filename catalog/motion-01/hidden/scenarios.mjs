// Scenarios of task motion-01: the page really plays the delivered video.
export default async function scenarios({ page, check }) {
  const video = page.locator('video').first();
  const has = (await video.count()) > 0;
  check('video_tag', 'La page contient une vidéo', has);
  if (!has) return;
  const src = await video.evaluate((v) => v.currentSrc || v.src || v.querySelector('source')?.src || '');
  check('video_src', 'La page lit lumio.mp4', /lumio\.mp4/.test(src), src || 'aucune source');
  // Muted autoplay is allowed by browsers; otherwise start it ourselves.
  await video.evaluate((v) => { v.muted = true; return v.play().catch(() => {}); });
  await page.waitForTimeout(1500);
  const state = await video.evaluate((v) => ({ ready: v.readyState, t: v.currentTime, err: v.error ? v.error.code : 0 }));
  check('video_plays', 'La vidéo se lit dans la page', state.ready >= 2 && state.t > 0.3 && !state.err,
    `readyState ${state.ready} · ${state.t.toFixed(1)} s lues${state.err ? ` · erreur ${state.err}` : ''}`);
}
