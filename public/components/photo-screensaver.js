import { api } from '../api.js';
import { formatDate } from '../i18n.js';

const IDLE_MS = Math.max(30, Number.parseInt(document.documentElement.dataset.screensaverIdle || '300', 10)) * 1000;
const SLIDE_MS = 20_000;

let idleTimer;
let slideTimer;
let overlay;
let run = 0;

function stop() {
  run += 1;
  clearInterval(slideTimer);
  slideTimer = undefined;
  overlay?.remove();
  overlay = undefined;
}

function resetIdle(event) {
  const wasVisible = Boolean(overlay);
  stop();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(start, IDLE_MS);
  // A dismissing gesture belongs to the overlay and must not activate the
  // dashboard control underneath it (particularly important on wall tablets).
  if (wasVisible && event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function caption(photo) {
  const place = [photo.city, photo.country].filter(Boolean).join(', ');
  if (!photo.takenAt) return place;
  const date = new Date(photo.takenAt);
  // Follows the date-format preference like every other date in the app.
  const formatted = Number.isNaN(date.getTime()) ? '' : formatDate(date);
  return [formatted, place].filter(Boolean).join(' · ');
}

async function start() {
  // A running kitchen timer (#844) keeps the screensaver away. A countdown that
  // disappears behind a photo is not a timer, and the wall tablet is exactly
  // where both of these live. The attribute is the one source, set by
  // components/wall-timer.js; it is dropped the moment the timer rings, so a
  // finished timer nobody acknowledged does not block the screensaver forever.
  if (document.documentElement.hasAttribute('data-wall-timer')) return false;

  const currentRun = ++run;
  try {
    const payload = await api.get('/screensaver/photos');
    if (currentRun !== run) return false;
    const photos = payload?.data?.photos || [];
    if (!payload?.data?.enabled || !photos.length) return false;

    overlay = document.createElement('div');
    overlay.className = 'photo-screensaver';
    overlay.setAttribute('aria-hidden', 'true');
    const image = document.createElement('img');
    image.alt = '';
    const label = document.createElement('p');
    overlay.append(image, label);
    document.body.append(overlay);

    let index = Math.floor(Math.random() * photos.length);
    const show = () => {
      if (!overlay) return;
      const photo = photos[index++ % photos.length];
      image.classList.remove('photo-screensaver__visible');
      image.onload = () => image.classList.add('photo-screensaver__visible');
      image.src = `/api/v1/screensaver/photos/${encodeURIComponent(photo.id)}`;
      label.textContent = caption(photo);
      // Move the only persistent text so the screensaver itself has no fixed
      // bright pixels that could cause burn-in.
      label.dataset.position = String(index % 4);
    };
    show();
    slideTimer = setInterval(show, SLIDE_MS);
    return true;
  } catch {
    // Screensaver is optional; retry after the next period of inactivity.
    return false;
  }
}

/** Opens the real screensaver immediately for the admin configuration preview. */
export async function preview() {
  stop();
  clearTimeout(idleTimer);
  const opened = await start();
  if (!opened) resetIdle();
  return opened;
}

let lastMove = 0;
for (const eventName of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
  window.addEventListener(eventName, resetIdle, { passive: false, capture: true });
}
window.addEventListener('pointermove', () => {
  const now = Date.now();
  if (now - lastMove > 1000) { lastMove = now; resetIdle(); }
}, { passive: true, capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop(); else resetIdle();
});
resetIdle();
