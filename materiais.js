(() => {
  'use strict';

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;

  const dialog = document.getElementById('material-save-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  const name = document.getElementById('material-save-name');
  const status = document.getElementById('material-save-status');
  const share = document.getElementById('material-save-share');
  const fallback = document.getElementById('material-save-fallback');
  const address = document.getElementById('material-save-url');
  const open = document.getElementById('material-save-open');
  let file = null;
  let controller = null;
  let sequence = 0;

  const showFallback = message => {
    share.hidden = true;
    fallback.hidden = false;
    status.textContent = message;
  };

  async function prepare(link) {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin ||
        !/^\/arquivos\/materiais\/[a-z0-9-]+\.pdf$/.test(url.pathname)) return;

    if (controller) controller.abort();
    const active = new AbortController();
    controller = active;
    const request = ++sequence;
    file = null;
    name.textContent = link.getAttribute('download');
    address.value = url.href;
    open.href = url.href;
    share.hidden = true;
    share.disabled = false;
    fallback.hidden = true;
    status.textContent = 'Preparando o PDF…';
    if (!dialog.open) dialog.showModal();

    const timeout = setTimeout(() => active.abort(), 20000);
    try {
      const response = await fetch(url.href, { signal: active.signal });
      if (!response.ok) throw new Error('PDF unavailable');
      const bytes = await response.arrayBuffer();
      const signature = String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength)));
      if (signature !== '%PDF-') throw new Error('Invalid PDF');
      if (request !== sequence || !dialog.open) return;
      file = new File([bytes], name.textContent, { type: 'application/pdf' });
      if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' ||
          !navigator.canShare({ files: [file] })) {
        showFallback('Este modo de abertura não oferece opções para salvar o arquivo.');
        return;
      }
      status.textContent = 'PDF pronto. Toque abaixo para escolher onde salvar ou compartilhar.';
      share.hidden = false;
      share.focus();
    } catch (error) {
      if (request !== sequence || !dialog.open) return;
      file = null;
      showFallback('Não foi possível preparar o PDF. Feche esta janela e tente novamente, ou abra o endereço no Safari.');
    } finally {
      clearTimeout(timeout);
      if (controller === active) controller = null;
    }
  }

  share.addEventListener('click', async () => {
    if (!file || share.disabled) return;
    const request = sequence;
    share.disabled = true;
    try {
      // The file is ready before this second tap, preserving user activation.
      await navigator.share({ files: [file] });
      if (request === sequence && dialog.open) dialog.close();
    } catch (error) {
      if (request !== sequence || !dialog.open) return;
      if (error.name === 'AbortError') {
        status.textContent = 'Nenhum destino foi escolhido. Toque novamente para salvar ou compartilhar.';
      } else {
        showFallback('Não foi possível abrir as opções para salvar neste modo de abertura.');
      }
    } finally {
      if (request === sequence) share.disabled = false;
    }
  });

  document.getElementById('material-save-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    ++sequence;
    if (controller) controller.abort();
    controller = null;
    file = null;
  });

  document.getElementById('material-save-copy').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address.value);
      status.textContent = 'Endereço copiado. Cole na barra de endereços do Safari.';
    } catch (error) {
      address.focus();
      address.select();
      status.textContent = 'Endereço selecionado. Copie e abra no Safari.';
    }
  });

  document.querySelectorAll('.material-actions a[download]').forEach(link => {
    link.textContent = 'Salvar PDF';
    link.setAttribute('aria-label', 'Salvar PDF: ' + link.getAttribute('download').replace(/\.pdf$/i, ''));
    link.addEventListener('click', event => {
      if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      prepare(link);
    });
  });

  const note = document.querySelector('.materials-note');
  if (note) note.textContent = 'Use Abrir PDF para consultar ou Salvar PDF para escolher onde guardar uma cópia.';
})();
