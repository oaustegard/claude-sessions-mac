const DEFAULTS = { openDelay: 250, closeDelay: 300, activeMs: 80, idleMs: 200 };

function pointIn(rect, p, pad = 0) {
  return p.x >= rect.x - pad && p.x <= rect.x + rect.width + pad && p.y >= rect.y - pad && p.y <= rect.y + rect.height + pad;
}

/**
 * Decides from the pointer position when the tray hover card opens and closes.
 * Electron's tray 'mouse-enter' only fires when the shell forwards a mouse move
 * to the icon, which Electron does not do reliably, so the caller polls the
 * cursor and feeds each reading to tick().
 */
function createHoverTracker(options = {}) {
  const { openDelay, closeDelay, activeMs, idleMs } = { ...DEFAULTS, ...options };
  let overSince = null;
  let outsideSince = null;
  let suppressed = false;
  let lastVisible = false;

  return {
    /** Returns 'show', 'hide' or null. `visible` includes a card that is still loading. */
    tick({ now, cursor, icon, card, visible }) {
      lastVisible = visible;
      const onIcon = !!icon && icon.width > 0 && pointIn(icon, cursor, 2);
      if (visible) {
        overSince = null;
        if (onIcon || (card && pointIn(card, cursor, 6))) {
          outsideSince = null;
          return null;
        }
        if (outsideSince === null) outsideSince = now;
        if (now - outsideSince < closeDelay) return null;
        outsideSince = null;
        return 'hide';
      }
      outsideSince = null;
      if (!onIcon) {
        overSince = null;
        suppressed = false;
        return null;
      }
      if (suppressed) return null;
      if (overSince === null) overSince = now;
      if (now - overSince < openDelay) return null;
      overSince = null;
      return 'show';
    },

    /** After a click: stay closed until the pointer has left the icon. */
    suppress() {
      suppressed = true;
      overSince = null;
    },

    reset() {
      overSince = null;
      outsideSince = null;
      suppressed = false;
      lastVisible = false;
    },

    /** Fast while the card is up, the rest of the dwell while waiting to open, otherwise idle. */
    nextTickIn(now) {
      if (lastVisible) return activeMs;
      if (overSince !== null) return Math.max(10, openDelay - (now - overSince));
      return idleMs;
    }
  };
}

module.exports = { createHoverTracker, pointIn };
