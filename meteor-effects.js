import * as THREE from './vendor/three/three.module.min.js';

const between = (min, max) => min + Math.random() * (max - min);
const direction = () => new THREE.Vector3().randomDirection();
let disc;
function softDisc() {
  if (disc) return disc;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(.4, 'rgba(255,255,255,.78)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  disc = new THREE.CanvasTexture(canvas);
  return disc;
}

// Unit-radius model, shared by the shelf and the flight simulation.
export function meteorTemplate(scene, model) {
  const bounds = new THREE.Box3().setFromObject(scene, true);
  const center = bounds.getCenter(new THREE.Vector3());
  const point = new THREE.Vector3();
  let radius = 0;
  const centered = new THREE.Group();
  const meshes = [];
  scene.traverse(node => { if (node.isMesh) meshes.push(node); });
  const fiery = model.id === 'meteor_fire';
  const glow = model.meteor.glow;
  const body = new THREE.MeshStandardMaterial({vertexColors: true, roughness: .88,
    emissive: fiery ? '#f73800' : '#000000', emissiveIntensity: .75});
  for (const mesh of meshes) {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      radius = Math.max(radius, point.distanceTo(center));
    }
    mesh.material = body;
  }
  scene.position.sub(center);
  const rock = new THREE.Group();
  rock.add(scene);
  rock.scale.setScalar(1 / radius);
  centered.add(rock);
  if (glow) {
    const shell = rock.clone(true);
    const skin = new THREE.MeshBasicMaterial({color: glow, transparent: true, opacity: fiery ? .44 : .36,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide});
    shell.traverse(node => { if (node.isMesh) node.material = skin; });
    shell.scale.multiplyScalar(fiery ? 1.057 : 1.066);
    centered.add(shell);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({color: fiery ? '#ff4600' : '#ffca00',
      map: softDisc(), transparent: true, opacity: .68, blending: THREE.AdditiveBlending, depthWrite: false}));
    halo.scale.setScalar(2.8);
    centered.add(halo);
  }
  return centered;
}

const puff = {count: 15, color: '#c8c8c8', life: [.5, 1.3], speed: [2, 5], size: [2, 3]};
const sparks = {count: 25, color: '#ff8c00', life: [.3, .8], speed: [3, 8], size: [1, 1.5]};

export class MeteorVolley {
  constructor(view, templates, reduced) {
    this.view = view;
    this.group = new THREE.Group();
    this.group.quaternion.copy(view.camera.quaternion);
    view.scene.add(this.group);
    this.rocks = [];
    this.particles = [];
    this.time = 0;
    this.shake = 0;
    this.radius = view.rest.bodyRadius;
    const camera = view.camera;
    const count = reduced ? 3 : THREE.MathUtils.randInt(5, 8);
    const phase = between(0, Math.PI * 2);
    const offset = THREE.MathUtils.randInt(0, templates.length - 1);
    for (let i = 0; i < count; i++) {
      const rock = templates[(i + offset) % templates.length].clone(true);
      const size = this.radius * between(.06, .12);
      rock.scale.setScalar(size);
      const sign = i % 2 === 0 ? -1 : 1;
      const fromSide = i % 4 !== 3;
      const x = fromSide ? sign * Math.max(camera.right, -camera.left) * 1.12 : between(camera.left, camera.right);
      const y = fromSide ? between(camera.bottom, camera.top) : Math.sign(Math.cos(i + phase)) * camera.top * 1.15;
      const start = new THREE.Vector3(x, y, .14 * this.radius);
      // End on the near hemisphere with a visible front-to-back component.
      const contact = new THREE.Vector3(x, y, 0).normalize().multiplyScalar(between(.65, .94));
      contact.z = Math.sqrt(1 - contact.lengthSq());
      contact.multiplyScalar(this.radius);
      rock.position.copy(start);
      rock.rotation.set(between(0, 4), between(0, 4), between(0, 4));
      rock.visible = false;
      this.group.add(rock);
      this.rocks.push({rock, start, contact, axis: direction(), delay: i / (count - 1) * 1.85, duration: between(.77, 1.05)});
    }
  }

  burst(contact, effect) {
    const unit = this.radius * .047;
    for (let i = 0; i < effect.count; i++) {
      const material = new THREE.SpriteMaterial({map: softDisc(), color: effect.color, transparent: true, depthWrite: false});
      const sprite = new THREE.Sprite(material);
      sprite.position.copy(contact).addScaledVector(direction(), unit * .3 * Math.cbrt(Math.random()));
      const size = unit * between(...effect.size);
      sprite.scale.setScalar(size);
      this.group.add(sprite);
      this.particles.push({sprite, size, age: 0, life: between(...effect.life), velocity: direction().multiplyScalar(unit * between(...effect.speed))});
    }
  }

  update(dt) {
    this.time += dt;
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const item = this.rocks[i];
      const t = (this.time - item.delay) / item.duration;
      if (t < 0) continue;
      if (t >= 1) {
        this.group.remove(item.rock);
        this.rocks.splice(i, 1);
        this.burst(item.contact, puff);
        this.burst(item.contact, sparks);
        this.shake = .3;
        continue;
      }
      item.rock.visible = true;
      item.rock.position.lerpVectors(item.start, item.contact, t * (.74 + .26 * t));
      item.rock.rotateOnAxis(item.axis, dt * THREE.MathUtils.degToRad(50));
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      const left = Math.max(0, 1 - p.age / p.life);
      p.sprite.position.addScaledVector(p.velocity, dt);
      p.sprite.scale.setScalar(p.size * left);
      p.sprite.material.opacity = left;
      if (!left) {
        this.group.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
      }
    }
    this.shake = Math.max(0, this.shake - dt);
    const amplitude = .03 * this.radius * this.shake / .3;
    this.view.root.position.set(between(-amplitude, amplitude), between(-amplitude, amplitude), 0);
    return this.rocks.length > 0 || this.particles.length > 0;
  }

  dispose() {
    for (const p of this.particles) p.sprite.material.dispose();
    this.view.scene.remove(this.group);
    this.view.root?.position.set(0, 0, 0);
  }
}
