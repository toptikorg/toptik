import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

export function assertLogoGeometry(m) {
  if (m.text !== 'TOPTIK' || !m.visible || !m.first || !m.logo) throw new Error('TopTik mobile logo is missing or invisible');
  for (const [name, rect] of [['first letter', m.first], ['logo', m.logo]]) {
    if (rect.width <= 0 || rect.height <= 0 || rect.left < 1 || rect.right > m.width - 1 || rect.top < 0 || rect.bottom > m.height) {
      throw new Error(`${name} is clipped or outside the viewport at width ${m.width}`);
    }
    for (const clip of m.clips) {
      if (rect.left < clip.left || rect.right > clip.right || rect.top < clip.top || rect.bottom > clip.bottom) {
        throw new Error(`${name} is clipped by an ancestor at width ${m.width}`);
      }
    }
  }
  if (!m.firstHit) throw new Error(`first letter is covered at width ${m.width}`);
}

export async function checkLogo({ themeId, evidenceDir = 'production-monitor-evidence' } = {}) {
  const { webkit } = await import('playwright');
  const browser = await webkit.launch({ headless: true });
  try {
    for (const width of [320, 375, 390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
      try {
        const url = new URL('https://www.toptik.co.il/');
        if (themeId) url.searchParams.set('preview_theme_id', String(themeId));
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!response || !response.ok()) throw new Error(`Store returned HTTP ${response?.status() ?? 'unknown'}`);
        await page.locator('#toptik-header .tt-mark b').waitFor({ state: 'visible', timeout: 15000 });
        await page.evaluate(() => document.fonts.ready);
        const actualTheme = await page.evaluate(() => window.Shopify?.theme?.id);
        if (themeId && String(actualTheme) !== String(themeId)) throw new Error('Preview theme identity mismatch');
        const m = await page.evaluate(() => {
          const el = document.querySelector('#toptik-header .tt-mark b');
          const range = document.createRange();
          const text = el?.firstChild;
          if (!text || text.nodeType !== Node.TEXT_NODE) return { text: '', visible: false };
          range.setStart(text, 0); range.setEnd(text, 1);
          const first = range.getBoundingClientRect();
          const whole = document.createRange();
          whole.selectNodeContents(el);
          const logo = whole.getBoundingClientRect();
          const clips = [];
          for (let a = el.parentElement; a; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (/(hidden|clip|scroll|auto)/.test(s.overflowX) || /(hidden|clip|scroll|auto)/.test(s.overflowY)) {
              const r = a.getBoundingClientRect();
              clips.push({ left: /(hidden|clip|scroll|auto)/.test(s.overflowX) ? r.left : -Infinity, right: /(hidden|clip|scroll|auto)/.test(s.overflowX) ? r.right : Infinity, top: /(hidden|clip|scroll|auto)/.test(s.overflowY) ? r.top : -Infinity, bottom: /(hidden|clip|scroll|auto)/.test(s.overflowY) ? r.bottom : Infinity });
            }
          }
          const hit = document.elementFromPoint(first.left + first.width / 2, first.top + first.height / 2);
          const css = getComputedStyle(el);
          return { text: el.textContent.trim(), visible: css.visibility === 'visible' && css.display !== 'none' && Number(css.opacity) > 0, first: first.toJSON(), logo: logo.toJSON(), clips, width: innerWidth, height: innerHeight, firstHit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)) };
        });
        assertLogoGeometry(m);
        console.log(`PASS WebKit mobile logo width=${width} theme=${actualTheme}`);
      } catch (error) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: `${evidenceDir}/mobile-logo-webkit-${width}.png` }).catch(() => {});
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.indexOf('--theme-id');
  const value = arg < 0 ? undefined : process.argv[arg + 1];
  if (arg >= 0 && !/^\d+$/.test(value ?? '')) { console.error('Invalid theme ID'); process.exitCode = 1; }
  else checkLogo({ themeId: value }).catch((error) => { console.error(error); process.exitCode = 1; });
}
