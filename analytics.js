(() => {
  if (navigator.doNotTrack === "1") return;

  let path = location.pathname || "/";
  if (path === "/index.html") path = "/";

  const allowed = new Set([
    "/",
    "/projetos.html",
    "/sobre.html",
    "/idealizador.html"
  ]);

  if (!allowed.has(path)) return;

  let referrer_host = null;
  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      if (ref.hostname && !ref.hostname.endsWith("viasantacruz.com.br")) {
        referrer_host = ref.hostname.slice(0, 160);
      }
    }
  } catch {}

  fetch("https://vgpivbxykeobgjzqlqcl.supabase.co/functions/v1/vsc-pageview", {
    method: "POST",
    mode: "cors",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, referrer_host })
  }).catch(() => {});
})();