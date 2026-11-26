// A native modal keeps keyboard focus inside and makes the page beneath it inert.
let dialog, photo, caption, closeButton, thumbnail, animation;
let closing = false;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

function makeDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'lightbox';
  dialog.setAttribute('aria-label', 'Expanded image');
  dialog.innerHTML = `<button type="button" class="icon-button lightbox-close" aria-label="Close expanded image" autofocus>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
    </button><figure><img alt=""><figcaption></figcaption></figure>`;
  photo = dialog.querySelector('img');
  caption = dialog.querySelector('figcaption');
  closeButton = dialog.querySelector('button');
  document.body.append(dialog);
  dialog.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
}

// Translate and scale the full-size image between two viewport rectangles.
function pose(rect, frame) {
  return `translate(${rect.left - frame.left}px, ${rect.top - frame.top}px) scale(${rect.width / frame.width}, ${rect.height / frame.height})`;
}

function close() {
  if (closing || !dialog.open) return;
  closing = true;
  const from = photo.getBoundingClientRect();
  const opacity = getComputedStyle(photo).opacity;
  animation?.cancel();
  const frame = photo.getBoundingClientRect();
  const target = thumbnail.querySelector('img').getBoundingClientRect();
  dialog.classList.add('closing');
  const frames = reduced.matches || !target.width || !frame.width
    ? [{opacity}, {opacity: 0}]
    : [{transform: pose(from, frame)}, {transform: pose(target, frame)}];
  animation = photo.animate(frames, {duration: reduced.matches ? 120 : 210, easing: 'ease-in-out', fill: 'forwards'});
  animation.onfinish = () => {
    dialog.close();
    animation.cancel();
    animation = null;
    dialog.classList.remove('closing');
    thumbnail.focus({preventScroll: true});
    thumbnail = null;
    closing = false;
  };
}

document.addEventListener('click', event => {
  const button = event.target.closest('button.image-thumb');
  if (!button || dialog?.open) return;
  const image = button.querySelector('img');
  if (!image?.naturalWidth) return;
  if (!dialog) makeDialog();
  thumbnail = button;
  const start = image.getBoundingClientRect();
  photo.src = image.currentSrc || image.src;
  photo.alt = image.alt || button.getAttribute('aria-label').replace(/^Enlarge /, '');
  photo.width = image.naturalWidth;
  photo.height = image.naturalHeight;
  const text = button.closest('.model-status') ? photo.alt : button.closest('figure')?.querySelector('figcaption')?.textContent;
  caption.textContent = text || '';
  caption.hidden = !text;
  photo.classList.toggle('kit-image', !!button.closest('.kit-grid'));
  dialog.showModal();
  closeButton.focus({preventScroll: true});
  const frame = photo.getBoundingClientRect();
  const frames = reduced.matches || !frame.width
    ? [{opacity: 0}, {opacity: 1}]
    : [{transform: pose(start, frame)}, {transform: 'none'}];
  animation = photo.animate(frames, {duration: reduced.matches ? 120 : 260, easing: 'cubic-bezier(.2,.75,.2,1)'});
});
