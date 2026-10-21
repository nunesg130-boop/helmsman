// Helmy, the floating helper, drawn live in 3D.
//
// The model (assets/helmy/helmy.glb) is a single static mesh with no
// skeleton, so the "rig" lives in the vertex shader: vertices out past the
// shoulders follow an arm rotation, vertices above the neck follow a head
// rotation, and each blends in smoothly so armour bends instead of tearing.
// Everything else (floating, breathing, leaning, spinning) moves the whole
// model. Helmy has no legs: he floats, he never walks.
//
// The app only talks to the controller returned by createHelmy():
//   mood("idle" | "thinking" | "alert" | "chat")  what he is doing now
//   react("wave" | "nod" | "celebrate" | "alert") a one-off gesture
//   pointer(x, y)       the mouse, so he can look at it
//   hover(on)           the mouse is over him
//   drag(dx) / drop()   being carried, with horizontal speed
//   travel(dx)          gliding to a new spot
//   destroy()
//
// With prefers-reduced-motion he holds still and only changes pose; when
// the tab is hidden nothing is drawn at all.

import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  GLTFLoader,
  Group,
  HemisphereLight,
  Matrix4,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  TextureLoader,
  Vector3,
  WebGLRenderer
} from "../vendor/three-helmy.js";

const FRAME_MS = 1000 / 30;
const TAU = Math.PI * 2;

// Model-space landmarks, measured from the mesh: the torso spans y -0.65 to
// -0.10, the arms run out from |x| 0.30 at y -0.40 to -0.13, and the helmet
// sits above y -0.08.
const RIG_GLSL = `
uniform mat4 helmyRest;
uniform mat4 helmyRestInverse;
uniform vec3 helmyArmLeft;
uniform vec3 helmyArmRight;
uniform vec3 helmyHead;
vec3 helmyPoint;
vec3 helmyNormal;
mat3 helmyRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 helmyRotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 helmyRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
void helmyRig(vec3 restPosition, vec3 restNormal) {
  vec3 p = (helmyRest * vec4(restPosition, 1.0)).xyz;
  vec3 n = normalize(mat3(helmyRest) * restNormal);
  float side = p.x >= 0.0 ? 1.0 : -1.0;
  float arm = smoothstep(0.26, 0.40, side * p.x) * (1.0 - smoothstep(-0.13, -0.05, p.y));
  if (arm > 0.0) {
    vec3 angles = (side > 0.0 ? helmyArmRight : helmyArmLeft) * arm;
    mat3 turn = helmyRotY(angles.y) * helmyRotZ(angles.z) * helmyRotX(angles.x);
    vec3 pivot = vec3(0.30 * side, -0.27, 0.0);
    p = pivot + turn * (p - pivot);
    n = turn * n;
  }
  float head = smoothstep(-0.15, -0.03, p.y) * (1.0 - arm);
  if (head > 0.0) {
    vec3 angles = helmyHead * head;
    mat3 turn = helmyRotY(angles.x) * helmyRotX(angles.y) * helmyRotZ(angles.z);
    vec3 pivot = vec3(0.0, -0.10, 0.0);
    p = pivot + turn * (p - pivot);
    n = turn * n;
  }
  helmyPoint = (helmyRestInverse * vec4(p, 1.0)).xyz;
  helmyNormal = normalize(mat3(helmyRestInverse) * n);
}
`;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Moves `current` toward `target` at a rate that does not depend on frame time.
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function easeOutBack(t) {
  const c = 1.7;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

/** Poses: arm angles are [twist, forward, drop]; drop > 0 lowers the arm. */
const MOODS = Object.freeze({
  idle: { left: [0, 0.18, 1.02], right: [0, 0.18, 1.02], head: [0.18, 0.04, 0], bob: 0.035, bobSpeed: 1.7, swing: 0.07, yaw: 0.28 },
  // Arms folded in front, head tipped and looking up: mulling it over.
  thinking: { left: [0, 0.95, 0.72], right: [0, 0.95, 0.72], head: [0.35, -0.2, 0.22], bob: 0.018, bobSpeed: 1.1, swing: 0.03, yaw: 0.18 },
  alert: { left: [0, 0.35, 0.55], right: [0, 0.35, 0.55], head: [0, -0.05, 0], bob: 0.03, bobSpeed: 3.2, swing: 0.04, yaw: 0 },
  chat: { left: [0, 0.3, 0.95], right: [0, 0.3, 0.95], head: [-0.32, 0.02, -0.05], bob: 0.028, bobSpeed: 1.6, swing: 0.05, yaw: -0.5 }
});

const REACTION_SECONDS = Object.freeze({ wave: 1.8, nod: 1.0, celebrate: 1.3, alert: 1.0, glance: 1.8, stretch: 1.6, spin: 1.1 });

export async function createHelmy({ container, modelUrl, reducedMotion = false }) {
  const canvas = document.createElement("canvas");
  canvas.className = "agent-helper__canvas";
  canvas.setAttribute("aria-hidden", "true");
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power", premultipliedAlpha: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  scene.add(new HemisphereLight(0xeaf6ff, 0x1d2a33, 2.1));
  const key = new DirectionalLight(0xffffff, 2.6);
  key.position.set(2, 3, 4);
  scene.add(key);
  const rim = new DirectionalLight(0x7fe6c2, 1.2);
  rim.position.set(-3, 1.5, -2);
  scene.add(rim);

  const camera = new PerspectiveCamera(28, 1, 0.05, 20);
  camera.position.set(0, -0.05, 4.6);
  camera.lookAt(0, -0.05, 0);

  const loader = new GLTFLoader();
  // GLTFLoader decodes embedded textures by fetching blob: URLs, which the
  // shell's connect-src 'self' refuses. An <img>-based loader reads the same
  // blob: URLs under img-src instead, so the policy stays as strict as it is.
  loader.register((parser) => {
    parser.textureLoader = new TextureLoader(parser.options.manager);
    return { name: "helmsman_image_textures" };
  });
  const gltf = await loader.loadAsync(modelUrl);
  const model = gltf.scene;
  model.updateMatrixWorld(true);

  const uniforms = {
    helmyRest: { value: new Matrix4() },
    helmyRestInverse: { value: new Matrix4() },
    helmyArmLeft: { value: new Vector3() },
    helmyArmRight: { value: new Vector3() },
    helmyHead: { value: new Vector3() }
  };
  let rigged = 0;
  model.traverse((object) => {
    if (!object.isMesh) return;
    // Positions may be quantized; this matrix takes them back to the model
    // space the rig's landmarks were measured in.
    uniforms.helmyRest.value.copy(object.matrixWorld);
    uniforms.helmyRestInverse.value.copy(object.matrixWorld).invert();
    object.frustumCulled = false;
    const material = object.material;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${RIG_GLSL}`)
        .replace("#include <beginnormal_vertex>", "helmyRig(position, normal);\nvec3 objectNormal = helmyNormal;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif")
        .replace("#include <begin_vertex>", "vec3 transformed = helmyPoint;");
    };
    material.customProgramCacheKey = () => "helmy-rig-1";
    rigged += 1;
  });
  if (!rigged) throw new Error("The helper model has no mesh.");

  // The model's own origin is its centre; the body group carries every
  // whole-body motion, the spin group only the celebration spin.
  const body = new Group();
  const spin = new Group();
  spin.add(model);
  body.add(spin);
  scene.add(body);
  const bounds = new Box3().setFromObject(model);
  const height = bounds.max.y - bounds.min.y;
  const fitScale = 1.35 / Math.max(0.001, height);
  model.scale.multiplyScalar(fitScale);

  container.append(canvas);

  const pose = {
    left: [...MOODS.idle.left],
    right: [...MOODS.idle.right],
    head: [...MOODS.idle.head],
    yaw: MOODS.idle.yaw,
    roll: 0,
    lift: 0,
    squash: 1
  };
  const status = {
    mood: "idle",
    reaction: null,
    reactionStart: 0,
    lastReaction: 0,
    pointer: null,
    pointerAt: -Infinity,
    hover: false,
    dragging: false,
    dragSpeed: 0,
    travel: 0,
    travelAt: -Infinity,
    fidgetAt: 0
  };
  let width = 0;
  let heightPx = 0;
  let frame = 0;
  let last = 0;
  let clock = 0;
  let stopped = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    if (nextWidth === width && nextHeight === heightPx) return;
    width = nextWidth;
    heightPx = nextHeight;
    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    renderer.setSize(width, heightPx, false);
    camera.aspect = width / heightPx;
    camera.updateProjectionMatrix();
  }

  function scheduleFidget(now) {
    status.fidgetAt = now + 6 + Math.random() * 7;
  }

  function startReaction(name, now) {
    status.reaction = name;
    status.reactionStart = now;
    status.lastReaction = now;
  }

  // The pose he is aiming for right now, before smoothing.
  function targetPose(now) {
    const mood = MOODS[status.mood] || MOODS.idle;
    const target = {
      left: [...mood.left],
      right: [...mood.right],
      head: [...mood.head],
      yaw: mood.yaw,
      roll: 0,
      lift: 0,
      squash: 1,
      spin: 0
    };
    if (reducedMotion) return target;

    const bob = Math.sin(now * mood.bobSpeed * Math.PI);
    target.lift = bob * mood.bob;
    target.squash = 1 + Math.sin(now * mood.bobSpeed * Math.PI * 2) * 0.012;
    target.left[2] += Math.sin(now * mood.bobSpeed * Math.PI + 0.6) * mood.swing;
    target.right[2] += Math.sin(now * mood.bobSpeed * Math.PI + 2.4) * mood.swing;
    target.roll = Math.sin(now * 0.9) * 0.035;

    // Looking at the mouse while it moves nearby.
    if (status.pointer && now - status.pointerAt < 2.5 && status.mood !== "thinking") {
      const rect = canvas.getBoundingClientRect();
      const dx = status.pointer.x - (rect.left + rect.width / 2);
      const dy = status.pointer.y - (rect.top + rect.height * 0.42);
      target.head[0] = clamp(dx / 320, -1, 1) * 0.6;
      target.head[1] = clamp(dy / 320, -1, 1) * 0.32;
      target.yaw = clamp(dx / 320, -1, 1) * 0.35 + mood.yaw * 0.3;
    }
    if (status.hover && !status.dragging) {
      target.lift += 0.04;
      target.squash *= 1.02;
    }

    // Carried: leans against the motion and paddles his arms.
    if (status.dragging) {
      const lean = clamp(status.dragSpeed * 0.0035, -0.45, 0.45);
      target.roll = -lean;
      target.yaw = clamp(status.dragSpeed * 0.004, -0.7, 0.7);
      const paddle = Math.sin(now * 14) * 0.25;
      target.left = [0, 0.1, 0.25 + paddle];
      target.right = [0, 0.1, 0.25 - paddle];
      target.head[1] = -0.12;
      target.squash = 1.05;
    } else if (now - status.travelAt < 1.1) {
      // Gliding somewhere: turns and leans into it, arms trailing.
      const direction = Math.sign(status.travel) || 1;
      const progress = (now - status.travelAt) / 1.1;
      const amount = Math.sin(progress * Math.PI);
      target.yaw = direction * 0.75 * amount + target.yaw * (1 - amount);
      target.roll = -direction * 0.16 * amount;
      target.left[2] -= 0.35 * amount;
      target.right[2] -= 0.35 * amount;
    }

    const reaction = status.reaction;
    if (reaction) {
      const elapsed = now - status.reactionStart;
      const duration = REACTION_SECONDS[reaction];
      const t = clamp(elapsed / duration, 0, 1);
      const envelope = Math.sin(t * Math.PI);
      if (reaction === "wave") {
        target.right = [Math.sin(elapsed * 10) * 0.35 * envelope, 0.3, 1.02 - 2.3 * envelope];
        target.head[2] = -0.12 * envelope;
        target.yaw = target.yaw * (1 - envelope) + 0.15 * envelope;
      } else if (reaction === "nod") {
        target.head[1] = Math.sin(elapsed * 12) * 0.28 * envelope;
        target.lift += 0.02 * envelope;
      } else if (reaction === "celebrate") {
        target.left = [0, 0.15, 1.02 - 2.5 * envelope];
        target.right = [0, 0.15, 1.02 - 2.5 * envelope];
        target.lift += Math.sin(t * Math.PI) * 0.28;
        target.spin = easeOutBack(t) * TAU;
        target.head[1] = -0.2 * envelope;
      } else if (reaction === "alert") {
        target.roll = Math.sin(elapsed * 38) * 0.18 * (1 - t);
        target.left = [0, 0.4, 1.02 - 1.6 * envelope];
        target.right = [0, 0.4, 1.02 - 1.6 * envelope];
        target.squash = 1 - 0.06 * envelope;
        target.head[1] = -0.1;
      } else if (reaction === "glance") {
        const side = status.glanceSide || 1;
        target.head[0] = side * 0.75 * envelope;
        target.head[1] = -0.08 * envelope;
      } else if (reaction === "stretch") {
        target.left = [0, 0.05, 1.02 - 2.2 * envelope];
        target.right = [0, 0.05, 1.02 - 2.2 * envelope];
        target.head[1] = -0.25 * envelope;
        target.squash = 1 + 0.05 * envelope;
      } else if (reaction === "spin") {
        target.spin = easeOutBack(t) * TAU;
        target.lift += 0.08 * envelope;
      }
      if (elapsed >= duration) {
        status.reaction = null;
        target.spin = 0;
      }
    }
    return target;
  }

  function applyPose(target, dt) {
    const rate = reducedMotion ? 1_000 : 9;
    for (const part of ["left", "right", "head"]) {
      for (let index = 0; index < 3; index += 1) pose[part][index] = approach(pose[part][index], target[part][index], rate, dt);
    }
    pose.yaw = approach(pose.yaw, target.yaw, reducedMotion ? 1_000 : 6, dt);
    pose.roll = approach(pose.roll, target.roll, reducedMotion ? 1_000 : 10, dt);
    pose.lift = approach(pose.lift, target.lift, reducedMotion ? 1_000 : 12, dt);
    pose.squash = approach(pose.squash, target.squash, reducedMotion ? 1_000 : 14, dt);

    // Uniforms: [twist, forward, drop] become rotations about x, y and z.
    // The right arm (x > 0) lowers with a negative z turn and swings forward
    // with a negative y turn; the left arm mirrors both.
    uniforms.helmyArmRight.value.set(pose.right[0], -pose.right[1], -pose.right[2]);
    uniforms.helmyArmLeft.value.set(-pose.left[0], pose.left[1], pose.left[2]);
    uniforms.helmyHead.value.set(pose.head[0], pose.head[1], pose.head[2]);
    body.rotation.set(0, pose.yaw, pose.roll);
    body.position.set(0, pose.lift, 0);
    body.scale.set(1 / Math.sqrt(pose.squash), pose.squash, 1 / Math.sqrt(pose.squash));
    spin.rotation.y = target.spin || 0;
  }

  function draw(now, dt) {
    resize();
    if (!reducedMotion && !status.reaction && !status.dragging && now >= status.fidgetAt) {
      if (status.mood === "idle" && now - status.lastReaction > 4) {
        const roll = Math.random();
        status.glanceSide = Math.random() < 0.5 ? -1 : 1;
        startReaction(roll < 0.5 ? "glance" : roll < 0.75 ? "stretch" : roll < 0.9 ? "wave" : "spin", now);
      }
      scheduleFidget(now);
    }
    applyPose(targetPose(now), dt);
    renderer.render(scene, camera);
  }

  function loop(time) {
    frame = 0;
    if (stopped) return;
    if (document.visibilityState !== "visible") return;
    if (time - last >= FRAME_MS - 1) {
      const dt = last ? Math.min(0.1, (time - last) / 1000) : FRAME_MS / 1000;
      last = time;
      clock += dt;
      draw(clock, dt);
    }
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (stopped || frame) return;
    if (reducedMotion) {
      draw(clock, 1);
      return;
    }
    last = 0;
    frame = requestAnimationFrame(loop);
  }

  function onVisibility() {
    if (document.visibilityState === "visible") start();
  }

  function onContextLost(event) {
    event.preventDefault();
    controller.destroy();
    controller.onLost?.();
  }

  document.addEventListener("visibilitychange", onVisibility);
  canvas.addEventListener("webglcontextlost", onContextLost);
  scheduleFidget(0);
  // He says hello once he appears.
  if (!reducedMotion) startReaction("wave", 0.4);
  start();

  const controller = {
    onLost: null,
    mood(name) {
      if (!MOODS[name] || status.mood === name) return;
      status.mood = name;
      if (reducedMotion) start();
    },
    react(name) {
      if (!REACTION_SECONDS[name] || reducedMotion) return;
      // A celebration or alert always wins; a wave never interrupts one.
      if (status.reaction && ["celebrate", "alert"].includes(status.reaction) && !["celebrate", "alert"].includes(name)) return;
      if (name === "glance") status.glanceSide = Math.random() < 0.5 ? -1 : 1;
      startReaction(name, clock);
    },
    pointer(x, y) {
      status.pointer = { x, y };
      status.pointerAt = clock;
    },
    hover(on) {
      const entering = on && !status.hover;
      status.hover = Boolean(on);
      if (entering && clock - status.lastReaction > 6) controller.react("wave");
    },
    drag(speed) {
      status.dragging = true;
      status.dragSpeed = approach(status.dragSpeed, speed, 8, 1 / 30);
    },
    drop() {
      status.dragging = false;
      status.dragSpeed = 0;
    },
    travel(dx) {
      if (Math.abs(dx) < 4) return;
      status.travel = dx;
      status.travelAt = clock;
    },
    destroy() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      model.traverse((object) => {
        if (!object.isMesh) return;
        object.geometry?.dispose();
        const material = object.material;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      });
      renderer.dispose();
      canvas.remove();
    }
  };
  return controller;
}

/** True when this browser has WebGL at all; creating the renderer can still fail. */
export function helmySupported() {
  return typeof globalThis.WebGLRenderingContext === "function" || typeof globalThis.WebGL2RenderingContext === "function";
}
