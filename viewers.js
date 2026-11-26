import * as THREE from './vendor/three/three.module.min.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { aimAt, bladeHub, clayModel, disposeModel, fitProjection, frameModel, maxZoom, minZoom, poseRig, restingBounds, silhouette } from './model-stage.js';

import { MeteorVolley, meteorTemplate } from './meteor-effects.js';

const send = document.querySelector('[data-send]');
const meteorCache = new Map();
const loader = new GLTFLoader();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const views = new Map();
const identity = new THREE.Quaternion();
const up = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3(1, 0, 0);
const motionButtons = document.querySelectorAll('[data-pause]');
let seasonAtlas;
let atlasRequest;
let seasonHeading = -.58;
const planetPicker = document.querySelector('.planet-picks');
let models = new Map();
let renderer;
let frame = 0;
let previousTime = 0;
let paused = false;
let closed = false;
let graphicsFailed = false;

function wake() {
  if (!frame && !document.hidden && !closed && !graphicsFailed) frame = requestAnimationFrame(draw);
}

function setState(view, state, message = '') {
  view.info.state = state;
  view.figure.dataset.state = state;
  view.status.replaceChildren(message);
  view.status.hidden = state === 'ready';
  if (view.tools) view.tools.hidden = state !== 'ready';
  if (send && view.info.kind === 'planet') send.disabled = state !== 'ready' || !!view.busy;
}

function unload(view) {
  if (!view.root) return;
  view.volley?.dispose();
  view.volley = null;
  view.busy = false;
  view.scene.remove(view.root);
  if (view.info.kind !== 'meteor') disposeModel(view.root, seasonAtlas);
  view.root = null;
  view.rig = view.spin = view.energy = null;
}

function fallback(view) {
  unload(view);
  setState(view, 'fallback', '3D preview unavailable.');
  view.stage.removeAttribute('tabindex');
  view.canvas.hidden = true;
  if (view.info.kind === 'cover') { view.status.hidden = true; return; }
  if (view.figure.dataset.fallback) {
    const img = document.createElement('img');
    img.width = 1600;
    img.height = 970;
    img.loading = 'lazy';
    img.alt = view.figure.querySelector('.model-name').textContent + ' in Blender';
    img.src = view.figure.dataset.fallback;
    img.addEventListener('error', () => img.remove(), {once: true});
    const enlarge = document.createElement('button');
    enlarge.type = 'button';
    enlarge.className = 'image-thumb';
    enlarge.setAttribute('aria-haspopup', 'dialog');
    enlarge.setAttribute('aria-label', 'Enlarge ' + img.alt);
    enlarge.append(img);
    view.status.prepend(enlarge);
  }
}

function createRenderer() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', {alpha: true, antialias: true});
  if (!context) throw new Error('WebGL 2 unavailable');
  const gl = new THREE.WebGLRenderer({canvas, context, alpha: true, antialias: true});
  gl.setClearColor(0, 0);
  gl.setScissorTest(true);
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.NoToneMapping;
  gl.domElement.addEventListener('webglcontextlost', () => {
    graphicsFailed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    for (const view of views.values()) fallback(view);
    for (const button of motionButtons) button.hidden = true;
  });
  return gl;
}

function trackPoint(view, point) {
  const rect = view.stage.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  const x = (2 * (point.x - rect.left) - rect.width) / size;
  const y = (rect.height - 2 * (point.y - rect.top)) / size;
  const r2 = x * x + y * y;
  return new THREE.Vector3(x, y, r2 <= .5 ? Math.sqrt(1 - r2) : .5 / Math.sqrt(r2)).normalize();
}

function zoomTo(view, value) {
  view.info.zoom = THREE.MathUtils.clamp(value, minZoom, maxZoom);
  for (const button of view.tools?.querySelectorAll('[data-zoom]') ?? []) {
    button.disabled = Number(button.dataset.zoom) < 0 ? view.info.zoom <= minZoom : view.info.zoom >= maxZoom;
  }
  view.dirty = true;
  wake();
}

function pointerDistance(view) {
  const [a, b] = view.pointers.values();
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function wireInput(view) {
  const el = view.stage;
  el.addEventListener('pointerdown', e => {
    if (!view.root || e.button !== 0 || view.pointers.size >= 2) return;
    view.pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    el.setPointerCapture(e.pointerId);
    wake();
  });
  el.addEventListener('pointermove', e => {
    const old = view.pointers.get(e.pointerId);
    if (!old || !view.root) return;
    const point = {x: e.clientX, y: e.clientY};
    const pinch = view.pointers.size === 2;
    const distance = pinch ? pointerDistance(view) : 0;
    view.pointers.set(e.pointerId, point);
    if (pinch) {
      if (distance > 2) zoomTo(view, view.info.zoom * pointerDistance(view) / distance);
    } else {
      const turn = new THREE.Quaternion().setFromUnitVectors(trackPoint(view, old), trackPoint(view, point));
      // Trackball axes are screen-relative; apply the turn in world space.
      turn.premultiply(view.camera.quaternion).multiply(view.camera.quaternion.clone().invert());
      view.orbit.premultiply(turn).normalize();
      view.dirty = true;
      wake();
    }
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    el.addEventListener(event, e => { view.pointers.delete(e.pointerId); wake(); });
  }
  el.addEventListener('wheel', e => {
    if (!view.root || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
    zoomTo(view, view.info.zoom * Math.exp(-delta * .008));
  }, {passive: false});
  // Safari trackpads deliver gesture events. Touchscreens use the pointers above.
  let gestureZoom;
  el.addEventListener('gesturestart', e => {
    if (!view.root || view.pointers.size) return;
    e.preventDefault();
    gestureZoom = view.info.zoom;
  }, {passive: false});
  el.addEventListener('gesturechange', e => {
    if (gestureZoom == null || view.pointers.size) return;
    e.preventDefault();
    zoomTo(view, gestureZoom * e.scale);
  }, {passive: false});
  el.addEventListener('gestureend', () => { gestureZoom = null; });
  el.addEventListener('keydown', e => {
    if (!view.root || e.altKey || e.ctrlKey || e.metaKey) return;
    if (['+', '=', '-', '0'].includes(e.key)) {
      e.preventDefault();
      zoomTo(view, e.key === '0' ? 1 : view.info.zoom * (e.key === '-' ? 1 / 1.2 : 1.2));
    } else if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const axis = ['ArrowLeft', 'ArrowRight'].includes(e.key) ? up : right;
      const sign = ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1;
      view.orbit.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, sign * .25)).normalize();
      view.keyHold = .75;
      view.dirty = true;
      wake();
    }
  });
  for (const button of view.tools?.querySelectorAll('button') ?? []) {
    button.addEventListener('click', () => {
      if (button.hasAttribute('data-reset')) {
        view.orbit.identity();
        view.heading = view.startHeading;
        zoomTo(view, 1);
      } else zoomTo(view, view.info.zoom * 1.2 ** Number(button.dataset.zoom));
    });
  }
}

function describe(view) {
  const model = models.get(view.info.id);
  if (!model || view.info.kind === 'cover') return;
  view.stage.setAttribute('aria-label', model.name + ', 3D model, drag to rotate');
  if (model.season) return;
  view.figure.querySelector('.model-name').textContent = model.name;
  view.figure.querySelector('.triangles').textContent = model.triangles.toLocaleString('en-US') + ' triangles';
  for (const button of view.tools?.querySelectorAll('button') ?? []) {
    const action = button.hasAttribute('data-reset') ? 'Reset view of ' : Number(button.dataset.zoom) < 0 ? 'Zoom out on ' : 'Zoom in on ';
    button.setAttribute('aria-label', action + model.name);
  }
  if (view.info.kind === 'planet') {
    const choice = planetPicker.querySelector('input:checked');
    view.figure.dataset.fallback = choice.dataset.fallback;
    view.figure.querySelector('.planet-stats').textContent = choice.dataset.stats;
  }
}

function getMeteor(model) {
  if (!meteorCache.has(model.id)) {
    const task = loader.loadAsync(model.file).then(({scene}) => meteorTemplate(scene, model));
    meteorCache.set(model.id, task);
    task.catch(() => meteorCache.delete(model.id));
  }
  return meteorCache.get(model.id);
}

async function textureSeason(scene, url) {
  atlasRequest ??= new THREE.TextureLoader().loadAsync(url).then(texture => {
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    seasonAtlas = texture;
    return texture;
  }).catch(error => {
    atlasRequest = null;
    throw error;
  });
  const map = await atlasRequest;
  scene.traverse(node => {
    if (!node.isMesh) return;
    for (const material of [].concat(node.material)) {
      material.map = map;
      material.color.set(0xffffff);
      material.roughness = .5;
      material.side = THREE.DoubleSide;
      material.needsUpdate = true;
    }
  });
}

async function load(view) {
  if (view.info.state !== 'idle' || !view.near || view.figure.closest('[hidden]') || closed) return;
  const model = models.get(view.info.id);
  if (!model || graphicsFailed || !view.context) { fallback(view); return; }
  if (!renderer) {
    try { renderer = createRenderer(); }
    catch {
      graphicsFailed = true;
      for (const item of views.values()) fallback(item);
      for (const button of motionButtons) button.hidden = true;
      return;
    }
  }
  setState(view, 'loading', 'Loading 3D model…');
  const version = ++view.version;
  let scene;
  try {
    if (model.meteor) {
      const template = await getMeteor(model);
      if (closed || graphicsFailed || version !== view.version) return;
      view.root = template.clone(true);
    } else {
      ({scene} = await loader.loadAsync(model.file));
      if (model.season && !closed && !graphicsFailed) await textureSeason(scene, model.atlas);
      if (closed || graphicsFailed || version !== view.version) { disposeModel(scene, seasonAtlas); return; }
      if (model.untextured) scene = clayModel(scene);
      if (model.spin) view.spin = bladeHub(scene, model.spin);
      if (model.pulseMaterial) {
        scene.traverse(node => {
          if (node.material?.name === model.pulseMaterial) view.energy = node.material;
        });
        if (view.energy) {
          // Leave headroom for the pulse on an untone-mapped sRGB display.
          view.energy.emissive.multiplyScalar(.19);
          view.energy.emissiveIntensity = 1;
        }
      }
      const framed = frameModel(scene, model);
      view.root = framed.root;
      view.rig = framed.rig;
    }
    view.scene.add(view.root);
    view.root.quaternion.setFromAxisAngle(up, view.heading);
    if (view.rig && !reduced.matches && !paused) {
      const angles = aimAt(model, view.elapsed);
      poseRig(view.rig, angles);
      Object.assign(view.info, angles);
    }
    const bounds = restingBounds(view.root, view.camera, model, view.rig);
    if (model.bodyRadius) {
      const radius = model.bodyRadius * view.root.scale.x;
      view.rest = {x: 0, y: 0, bodyRadius: radius, half: radius / (view.info.kind === 'cover' ? .78 : .67)};
    } else {
      view.rest = {x: (bounds.left + bounds.right) / 2, y: (bounds.bottom + bounds.top) / 2,
        width: bounds.width, height: bounds.height, fill: model.meteor ? 1.10 : 1.40};
    }
    if (view.info.kind !== 'cover') view.stage.tabIndex = 0;
    view.canvas.hidden = false;
    view.dirty = true;
    wake();
  } catch {
    if (scene && !view.root) disposeModel(scene, seasonAtlas);
    if (!closed && version === view.version) fallback(view);
  }
}

function animate(view, dt) {
  const auto = !paused && !reduced.matches;
  const kind = view.info.kind;
  const moving = auto && (kind !== 'turret' || !!view.rig || !!view.energy);
  if (moving) {
    view.elapsed += dt;
    if (view.rig) {
      const angles = aimAt(models.get(view.info.id), view.elapsed);
      poseRig(view.rig, angles);
      Object.assign(view.info, angles);
    } else if (view.energy) {
      const beat = view.elapsed % 4;
      const up = THREE.MathUtils.smoothstep(beat, 1.7, 2.3);
      const down = THREE.MathUtils.smoothstep(beat, 2.65, 3.45);
      view.energy.emissiveIntensity = 1 + 5 * (up - down);
    } else {
      if (view.spin) view.spin.hub.rotateOnAxis(view.spin.axis, dt * view.spin.speed);
      if (!view.pointers.size && kind !== 'season') view.heading = (view.heading + dt * .18) % (2 * Math.PI);
    }
  }
  if (kind === 'season') view.heading = seasonHeading;
  const inFlight = !!view.volley;
  if (inFlight && !view.volley.update(dt)) {
    view.volley.dispose();
    view.volley = null;
    view.busy = false;
    send.disabled = false;
  }
  view.keyHold = Math.max(0, view.keyHold - dt);
  const settling = !view.pointers.size && view.orbit.angleTo(identity) > .0001;
  if (settling && !view.keyHold) view.orbit.slerp(identity, 1 - Math.exp(-5 * dt));
  view.root.quaternion.setFromAxisAngle(up, view.heading).premultiply(view.orbit);
  if (kind === 'meteor') view.root.rotateZ(view.elapsed * .22);
  return moving || settling || inFlight || view.keyHold > 0;
}

function draw(time) {
  frame = 0;
  if (closed || document.hidden || graphicsFailed || !renderer) return;
  const dt = Math.min((time - (previousTime || time)) / 1000, .05);
  previousTime = time;
  const active = [...views.values()].filter(v => v.visible && v.root && v.stage.clientWidth && v.stage.clientHeight);
  if (!active.length) { previousTime = 0; return; }
  if (!paused && !reduced.matches && active.some(view => view.info.kind === 'season')) {
    seasonHeading = (seasonHeading + dt * .18) % (2 * Math.PI);
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 1, h = 1;
  for (const view of active) {
    view.width = Math.max(1, Math.round(view.stage.clientWidth * dpr));
    view.height = Math.max(1, Math.round(view.stage.clientHeight * dpr));
    w = Math.max(w, view.width);
    h = Math.max(h, view.height);
  }
  const buffer = renderer.domElement;
  if (buffer.width !== w || buffer.height !== h) renderer.setSize(w, h, false);
  let moving = false;
  for (const view of active) {
    const animated = animate(view, dt);
    moving ||= animated;
    const {width, height, canvas, camera} = view;
    const resized = canvas.width !== width || canvas.height !== height;
    if (!resized && !animated && !view.dirty) continue;
    if (resized) { canvas.width = width; canvas.height = height; }
    const inspect = view.info.zoom > 1 || view.orbit.angleTo(identity) > .0001;
    const bounds = inspect ? silhouette(view.root, camera) : null;
    fitProjection(camera, view.rest, width / height, view.info.zoom, bounds);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.clear();
    renderer.render(view.scene, camera);
    view.context.clearRect(0, 0, width, height);
    view.context.drawImage(buffer, 0, h - height, width, height, 0, 0, width, height);
    if (view.info.state === 'loading') setState(view, 'ready');
    view.dirty = false;
  }
  if (moving) wake();
  else previousTime = 0;
}

function setup(figure) {
  const stage = figure.querySelector('.stage');
  const canvas = stage.querySelector('canvas');
  const id = figure.dataset.model;
  const info = {id, kind: figure.dataset.kind, state: 'idle', yawDeg: 0, pitchDeg: 0, zoom: 1};
  window.__viewers.push(info);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb7bcc2, 1.04));
  const key = new THREE.DirectionalLight(0xfffaf2, 1.65);
  key.position.set(-3, 6, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, .52);
  rim.position.set(3, 2, -4);
  scene.add(rim);
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, .1, 20);
  camera.position.set(0, ['planet', 'cover'].includes(info.kind) ? .35 : 2, 4);
  camera.lookAt(0, 0, 0);
  const view = {figure, stage, canvas, scene, camera, info, context: canvas.getContext('2d'),
    status: stage.querySelector('.model-status'), tools: figure.querySelector('.zoom-tools'),
    pointers: new Map(), orbit: new THREE.Quaternion(), elapsed: 0, heading: ({flak: -1.29, gatling: 3.22, rocket: -2.15})[id] ?? -.58,
    dirty: true, visible: false, near: false, version: 0, keyHold: 0};
  view.startHeading = view.heading;
  views.set(stage, view);
  describe(view);
  setState(view, 'idle', '3D model loads when in view.');
  if (view.info.kind !== 'cover') wireInput(view);
  else view.status.hidden = true;
  return view;
}

const near = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const view = views.get(entry.target);
    view.near = entry.isIntersecting;
    if (view.near) load(view);
  }
}, {rootMargin: '280px'});
const visible = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const view = views.get(entry.target);
    view.visible = entry.isIntersecting;
    view.dirty = true;
    if (!view.visible) view.pointers.clear();
  }
  wake();
});
const resized = new ResizeObserver(entries => {
  for (const entry of entries) views.get(entry.target).dirty = true;
  wake();
});

function syncMotion() {
  for (const button of motionButtons) {
    button.hidden = reduced.matches || graphicsFailed;
    button.textContent = paused ? 'Resume motion' : 'Pause motion';
  }
  for (const view of views.values()) view.dirty = true;
  wake();
}
for (const button of motionButtons) {
  button.addEventListener('click', () => { paused = !paused; syncMotion(); });
}
reduced.addEventListener('change', syncMotion);
document.addEventListener('visibilitychange', () => {
  previousTime = 0;
  if (document.hidden) {
    cancelAnimationFrame(frame);
    frame = 0;
    for (const view of views.values()) view.pointers.clear();
  } else wake();
});
window.addEventListener('pageshow', wake);
window.addEventListener('pagehide', event => {
  cancelAnimationFrame(frame);
  frame = previousTime = 0;
  if (event.persisted) return;
  closed = true;
  near.disconnect();
  visible.disconnect();
  resized.disconnect();
  for (const view of views.values()) unload(view);
  for (const task of meteorCache.values()) task.then(disposeModel).catch(() => {});
  atlasRequest?.then(texture => texture.dispose()).catch(() => {});
  renderer?.dispose();
});

async function init() {
  try {
    const response = await fetch('models/models.json');
    if (!response.ok) throw new Error('Manifest unavailable');
    models = new Map((await response.json()).map(model => [model.id, model]));
  } catch { graphicsFailed = true; }
  if (closed) return;
  window.__viewers = [];
  for (const figure of document.querySelectorAll('[data-model]')) {
    const view = setup(figure);
    if (graphicsFailed) { fallback(view); continue; }
    near.observe(view.stage);
    visible.observe(view.stage);
    resized.observe(view.stage);
  }
  if (planetPicker) {
    const planet = views.get(document.querySelector('[data-kind="planet"] .stage'));
    send.addEventListener('click', async () => {
      if (planet.info.state !== 'ready' || planet.busy) return;
      planet.busy = send.disabled = true;
      const version = planet.version;
      try {
        const templates = await Promise.all([...models.values()].filter(m => m.meteor).map(getMeteor));
        if (closed || graphicsFailed || version !== planet.version) return;
        planet.status.hidden = true;
        planet.volley = new MeteorVolley(planet, templates, reduced.matches);
        wake();
      } catch {
        if (version !== planet.version) return;
        planet.busy = send.disabled = false;
        planet.status.textContent = 'Meteors could not load. Try again.';
        planet.status.hidden = false;
      }
    });
    planetPicker.querySelector('[value="planet1"]').checked = true;
    describe(planet);
    planetPicker.disabled = !models.size;
    const choices = [...planetPicker.querySelectorAll('input')];
    for (const step of document.querySelectorAll('.planet-steps button')) {
      step.disabled = !models.size;
      step.addEventListener('click', () => {
        const index = choices.findIndex(choice => choice.checked);
        choices[(index + Number(step.dataset.step) + choices.length) % choices.length].click();
      });
    }
    planetPicker.addEventListener('change', event => {
      const id = event.target.value;
      if (!models.has(id) || id === planet.info.id) return;
      planet.version++;
      unload(planet);
      planet.pointers.clear();
      planet.orbit.identity();
      planet.heading = -.58;
      planet.figure.dataset.model = planet.info.id = id;
      planet.context?.clearRect(0, 0, planet.canvas.width, planet.canvas.height);
      describe(planet);
      setState(planet, 'idle', '3D model loads when in view.');
      if (graphicsFailed) fallback(planet);
      else load(planet);
    });
  }
  syncMotion();
}
init();
