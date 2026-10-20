// Docs pages: theme toggle, the mobile menu, copy buttons on code, the "on this page" highlight, and a heading
// search over search.json (built by site/build.mjs).
const root = document.documentElement;

document.querySelector('.theme-toggle')?.addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('sw-theme', root.dataset.theme);
  } catch {}
});

const menu = document.querySelector('.menu-toggle');
const sidebar = document.getElementById('sidebar');
menu?.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  menu.setAttribute('aria-expanded', String(open));
});

// The button goes on a wrapper around the block, not in it: a block wider than the page scrolls sideways, and a
// button inside it would scroll away with the code.
for (const pre of document.querySelectorAll('.prose pre')) {
  const wrap = document.createElement('div');
  wrap.className = 'code';
  pre.replaceWith(wrap);
  wrap.appendChild(pre);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy';
  b.textContent = 'Copy';
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select and copy';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  });
  wrap.appendChild(b);
}

// Highlight the section being read in the "on this page" list.
const links = new Map([...document.querySelectorAll('.toc a')].map((a) => [a.getAttribute('href').slice(1), a]));
const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        for (const a of links.values()) a.classList.remove('on');
        links.get(e.target.id)?.classList.add('on');
      }
  },
  { rootMargin: '-70px 0px -70% 0px' },
);
for (const id of links.keys()) {
  const h = document.getElementById(id);
  if (h) seen.observe(h);
}

// Search: headings across all pages, matched on every word typed.
const input = document.querySelector('[data-search]');
const results = document.querySelector('[data-results]');
let index = null;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
input?.addEventListener('input', async () => {
  index ??= await fetch('search.json').then((r) => r.json()).catch(() => []);
  const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return void (results.hidden = true);
  const hits = index.filter((e) => words.every((w) => `${e.t} ${e.in || ''}`.toLowerCase().includes(w))).slice(0, 12);
  results.innerHTML = hits.length
    ? hits.map((e) => `<li><a href="${e.p}.html${e.id ? `#${e.id}` : ''}">${esc(e.t)}${e.in ? `<span>${esc(e.in)}</span>` : ''}</a></li>`).join('')
    : '<li class="none">No headings match</li>';
  results.hidden = false;
});
input?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') results.querySelector('a')?.click();
  if (e.key === 'Escape') (input.value = ''), (results.hidden = true);
});
