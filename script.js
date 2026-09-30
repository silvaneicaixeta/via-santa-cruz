const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.main-nav');

if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  });

  nav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Abrir menu');
    });
  });
}

document.getElementById('year').textContent = new Date().getFullYear();

(() => {
  const SUPABASE_URL = 'https://vgpivbxykeobgjzqlqcl.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_CplQkGKykMUsHso_vRki-g_gIsZJDgh';
  const path = window.location.pathname || '/';
  let referrerHost = null;
  try {
    if (document.referrer) referrerHost = new URL(document.referrer).hostname;
  } catch (_) {}
  fetch(SUPABASE_URL + '/rest/v1/rpc/vsc_record_pageview', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ p_path: path, p_referrer_host: referrerHost }),
    keepalive: true
  }).catch(() => {});
})();
