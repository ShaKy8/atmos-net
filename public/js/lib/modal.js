/** One focus lifecycle for Settings, Location, Alerts and Briefing. */
export function createModalController(overlay, card, background) {
  const doc = card.ownerDocument;
  const selector = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';
  let returnFocus = null, wasInert = false;

  const focusable = () => [...card.querySelectorAll(selector)]
    .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled')
      && !node.closest('[hidden], [inert]') && node.getClientRects().length
      && doc.defaultView.getComputedStyle(node).visibility !== 'hidden')
    .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));

  const focusFirst = () => (focusable()[0] || card).focus();

  function containFocus(event) {
    if (!overlay.hidden && !card.contains(event.target)) focusFirst();
  }

  function onKey(event) {
    if (overlay.hidden || event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    // Re-query each time: search results and enabled controls can change.
    const controls = focusable();
    const first = controls[0], last = controls.at(-1);
    if (!first) {
      event.preventDefault();
      card.focus({ preventScroll: true });
    } else if (!controls.includes(doc.activeElement)
      || (event.shiftKey ? doc.activeElement === first : doc.activeElement === last)) {
      event.preventDefault();
      // Let the browser reveal the destination in a scrolled/short dialog.
      (event.shiftKey ? last : first).focus();
    }
  }

  function open(html, onMount, trigger) {
    // Replacing an open overlay must not remember a soon-to-be-removed control.
    if (overlay.hidden) {
      returnFocus = trigger || doc.activeElement;
      wasInert = background?.inert || false;
      if (background) background.inert = true;
      doc.addEventListener('keydown', onKey, true);
      doc.addEventListener('focusin', containFocus);
    }
    card.innerHTML = html;
    const heading = card.querySelector('.hd');
    if (heading) {
      heading.id ||= 'modalTitle';
      card.setAttribute('aria-labelledby', heading.id);
      card.removeAttribute('aria-label');
    } else {
      card.removeAttribute('aria-labelledby');
      card.setAttribute('aria-label', 'Weather dialog');
    }
    overlay.hidden = false;
    overlay.scrollTop = card.scrollTop = 0;
    if (onMount) onMount(card);
    // Search intentionally chooses its input in onMount. Leave that intact.
    if (!card.contains(doc.activeElement)) focusFirst();
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('focusin', containFocus);
    card.innerHTML = '';
    if (background) background.inert = wasInert;
    const trigger = returnFocus;
    returnFocus = null;
    if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
  }

  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  return { open, close };
}
