// Keep the star field still, including when the visitor reduces motion.
if (document.querySelector('.space')) {
  const tile = document.createElement('canvas');
  tile.width = 432;
  tile.height = 288;
  const ctx = tile.getContext('2d');
  if (ctx) {
    let seed = 23;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 180; i++) {
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,' + (.28 + random() * .65) + ')';
      ctx.arc(random() * tile.width, random() * tile.height, .3 + random() ** 3 * 1.05, 0, 2 * Math.PI);
      ctx.fill();
    }
    document.documentElement.style.setProperty('--stars', 'url(' + tile.toDataURL() + ')');
  }
}


if (document.querySelector('[data-model]')) import('./viewers.js?v=7');

// Section rail: mark the section currently under the top bar.
const railLinks = [...document.querySelectorAll('.page-nav a')];
if (railLinks.length) {
  const sections = railLinks.map(link => document.getElementById(link.hash.slice(1)));
  const mark = () => {
    const line = innerHeight * .35;
    let current = -1;
    sections.forEach((section, i) => { if (section.getBoundingClientRect().top <= line) current = i; });
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) current = sections.length - 1;
    railLinks.forEach((link, i) => {
      if (i === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; mark(); });
  }, {passive: true});
  addEventListener('resize', mark);
  // Models above the target can still be settling in; land on the heading once they have.
  for (const [i, link] of railLinks.entries()) {
    link.addEventListener('click', () => setTimeout(() => {
      const offset = sections[i].getBoundingClientRect().top - parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
      if (Math.abs(offset) > 12) sections[i].scrollIntoView();
    }, 900));
  }
  mark();
}

// Gameplay clip: silent by default; sound and playback are opt-in controls.
const clip = document.querySelector('.video-slot video');
if (clip) {
  const sound = document.querySelector('[data-sound]');
  const playback = document.querySelector('[data-playback]');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let userPaused = calm.matches;
  const play = () => clip.play().catch(() => {});
  const sync = () => {
    sound.setAttribute('aria-pressed', String(!clip.muted));
    sound.setAttribute('aria-label', clip.muted ? 'Turn sound on' : 'Turn sound off');
    playback.setAttribute('aria-pressed', String(clip.paused));
    playback.setAttribute('aria-label', clip.paused ? 'Play video' : 'Pause video');
  };
  const toggle = () => { userPaused = !clip.paused; userPaused ? clip.pause() : play(); };
  sound.addEventListener('click', () => { clip.muted = !clip.muted; });
  playback.addEventListener('click', toggle);
  document.querySelector('[data-enlarge]').addEventListener('click', () => {
    if (clip.requestFullscreen) clip.requestFullscreen().catch(() => {});
    else clip.webkitEnterFullscreen?.();
  });
  clip.addEventListener('click', toggle);
  for (const type of ['play', 'pause', 'volumechange']) clip.addEventListener(type, sync);
  // Play only while on screen, and never against a reduced-motion preference or a manual pause.
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !userPaused) play();
    else clip.pause();
  }, {threshold: .25}).observe(clip);
  calm.addEventListener('change', () => { if (calm.matches) { userPaused = true; clip.pause(); } });
  sync();
}
