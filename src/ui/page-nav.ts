// ─── Page navigation ─────────────────────────────────────────────
// Two pages — Studio and Document Reader — shown one at a time. The
// active page is mirrored into the URL hash (#studio / #reader) so
// links and reloads land where the user expects. Any element with
// `data-page-jump="…"` switches pages (e.g. the "load a model" call to
// action on the Reader page).

export type PageName = 'studio' | 'reader';

const PAGES: PageName[] = ['studio', 'reader'];

export function showPage(name: PageName): void {
  for (const page of PAGES) {
    const el = document.getElementById(`page-${page}`);
    if (el) el.hidden = page !== name;
  }
  document.querySelectorAll<HTMLElement>('[data-page-target]').forEach(tab => {
    const active = tab.dataset.pageTarget === name;
    tab.setAttribute('aria-selected', String(active));
    tab.classList.toggle('page-nav__tab--active', active);
  });
  if (location.hash !== `#${name}`) {
    // Keep back/forward useful without scrolling the page.
    history.replaceState(null, '', `#${name}`);
  }
}

function pageFromHash(): PageName {
  const hash = location.hash.replace('#', '');
  return (PAGES as string[]).includes(hash) ? (hash as PageName) : 'studio';
}

export function bindPageNav(): void {
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-page-target], [data-page-jump]',
    );
    if (!target) return;
    const name = (target.dataset.pageTarget ?? target.dataset.pageJump) as PageName;
    if ((PAGES as string[]).includes(name)) {
      showPage(name);
      document.getElementById(`page-${name}`)?.focus?.();
    }
  });
  window.addEventListener('hashchange', () => showPage(pageFromHash()));
  showPage(pageFromHash());
}
