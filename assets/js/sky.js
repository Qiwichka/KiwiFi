// Cloud Sky — Originkit
// Originkit — props baked into the default export.


const MAX_DPR = 2

// Found on a parameter grid; the look depends on these, so they are named.
const PUFF_UP = 0.34 // ellipse radius above the puff centre
const PUFF_DOWN = 0.19 // ...and below it. The gap IS the flat cumulus base.
const ERODE = 0.7 // how hard the fbm eats into the blob edge
const SHADOW_STEP = 0.085 // how far above a pixel the self-shadow samples
const NEAR_CELL = 1.05 // cells across the short side, near layer
const FAR_CELL = 2.15 // ...and far layer
const FAR_MIX = 0.55 // aerial perspective: far cloud mixed toward the sky
const NEAR_DRIFT = 0.055 // cells/sec at Speed 50
const FAR_DRIFT = 0.026
const CIRRUS_DRIFT = 0.014
// A puff's half-width in cells. Clamped so the 5x5 neighbourhood below is
// PROVABLY enough: a puff at cell offset o reaches this pixel whenever its
// half-width exceeds |o| - 0.85, so a cell at |o| = 3 can only matter once w
// passes 2.15. Uncapped, w hits 0.72 * 3.0 = 2.16 at Size 300 and the widest
// puffs get silently dropped -- measured against a wide-window ground truth,
// 0.025% of pixels wrong with a worst error of 0.40, which paints as one hard
// arc through the cloud.
const PUFF_WMAX = 2.15
// Sharpness of the soft-max that blends each puff's height contribution. See
// blobs(): winner-take-all is what put the creases in the cloud body. Picked on
// a sweep -- at 12 the crease count is 0 at every Size while the puff's own
// top-to-bottom gradient keeps 91% of its spread; lower blurs the gradient away,
// higher lets the jump climb back.
const SHADE_BLEND = 12.0

const VERT_SRC = `
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const FRAG_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uNearX, uFarX, uCirrusX;
uniform float uCoverage, uSize, uSoftness, uShadow, uCirrus;
uniform vec3 uZenith, uHorizon, uCloud;
uniform vec4 uGlow;
uniform vec2 uSun;
uniform vec2 uParallax;

// No sin() in the hash: fract(sin(x) * k) quantizes hard once the argument gets
// large, and the cell ids run far off the origin as the sky drifts.
vec2 hash22(vec2 p){
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

float hash12(vec2 p){
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float vnoise(vec2 x){
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++){
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// One hashed puff cluster per cell, walked over the neighbourhood so a puff near
// an edge is still drawn by the cell next door. Most cells are empty -- that is
// what leaves real sky between the clouds.
// Returns (coverage, height within the puff). The second component is what shades
// the cloud: -1 at its base, +1 at its crown. Without it the only shading signal
// is "is there cloud above me", which is true almost everywhere inside a puff, so
// the whole body goes grey and only a one-pixel rim stays white.
//
// THE WINDOW is 5x5, not 3x3, with an exact reach test that skips a cell before
// it costs a hash. A 3x3 window only serves puffs up to 1.85 cells wide; past
// that the widest puffs are dropped and their ellipses end on a hard arc. The
// test is |o| <= w + 0.85, so small sizes cost LESS than the old 3x3 (at Size 20
// only the centre cell can reach at all) and only Size 200+ pays for the ring.
//
// THE HEIGHT is a soft-max blend over every puff, not the nearest puff's. Taking
// it from the winner makes it jump the instant two overlapping puffs swap which
// one is nearest -- measured up to 1.43 across a single pixel -- and shadeCloud
// turns that discontinuity into a hard crease straight across the cloud body.
// That is what appears as Size grows: at Size 100 the puffs barely overlap and
// there are none, at 200 there are 458 and at 300 there are 1585.
//
// The soft-max is the ONLINE form, rescaling the running sums whenever a new
// best arrives, so the dominant weight is always exactly 1.0 and the sums stay
// in [1, 25]. The plain exp(K * val) form overflows outright on a mediump
// fragment path, and its smallest weights flush to zero exactly at the cloud
// edge where the height still has to be right.
vec2 blobs(vec2 uv, float seed){
  vec2 id = floor(uv), f = fract(uv);
  // Sentinel stays small: -1e9 is outside mediump's guaranteed range, and val
  // never falls below about -50 here.
  float best = -1e4;
  float wsum = 0.0, ysum = 0.0;
  float wMax = min(${PUFF_WMAX.toFixed(3)}, 0.72 * uSize);
  float reach = min(2.0, ceil(wMax + 0.85) - 1.0);
  for (int j = -2; j <= 2; j++){
    for (int i = -2; i <= 2; i++){
      vec2 o = vec2(float(i), float(j));
      if (max(abs(o.x), abs(o.y)) > reach) continue;
      vec2 h = hash22(id + o + seed);
      // Coverage decides how many cells hold a cloud at all.
      if (fract(h.x * 37.1) > uCoverage) continue;
      vec2 c = o + 0.15 + h * 0.7;
      float w = min(${PUFF_WMAX.toFixed(3)}, (0.30 + 0.42 * fract(h.y * 19.7)) * uSize);
      vec2 d = f - c;
      // Asymmetric about the centre: tall above, short below. That gap is the
      // flat base a cumulus has and a noise field never produces.
      float ry = (d.y > 0.0 ? ${PUFF_UP.toFixed(3)} : ${PUFF_DOWN.toFixed(3)}) * uSize * (0.8 + 0.5 * fract(h.y * 7.3));
      float e = length(vec2(d.x / max(w, 1e-3), d.y / max(ry, 1e-3)));
      float val = 1.0 - e;
      float yN = d.y / max(ry, 1e-3);
      if (val > best){
        float k = exp(${SHADE_BLEND.toFixed(1)} * (best - val));
        wsum = wsum * k + 1.0;
        ysum = ysum * k + yN;
        best = val;
      } else {
        float g = exp(${SHADE_BLEND.toFixed(1)} * (val - best));
        wsum += g;
        ysum += g * yN;
      }
    }
  }
  return vec2(best, ysum / max(wsum, 1e-4));
}

// Blobs decide WHERE, noise decides the OUTLINE.
vec2 cloudField(vec2 uv, float seed, float detailScale){
  vec2 b = blobs(uv, seed);
  // Two bands: the coarse one dents the silhouette into lobes, the fine one
  // frays it. One band alone gives either a wobbly outline or fuzz, never the
  // feathered edge a cumulus has.
  float n = fbm(uv * detailScale + seed * 3.1) * 0.72
          + fbm(uv * detailScale * 3.3 + seed * 7.7) * 0.28;
  return vec2(b.x - (1.0 - n) * ${ERODE.toFixed(3)}, b.y);
}

// A cumulus is lit from above: white crown, grey underside tinted toward the sky
// it sits in. dyNorm is the pixel's height within its own puff, so this is the
// puff's own vertical gradient rather than a flat tint.
vec3 shadeCloud(float dyNorm, vec3 sky){
  float t = smoothstep(-0.95, 0.25, dyNorm);
  vec3 base = mix(uCloud * 0.52, sky, 0.34);
  return mix(mix(uCloud, base, uShadow), uCloud, t);
}

void main(){
  vec2 frag = gl_FragCoord.xy / max(uRes.y, 1.0);
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = vec2(frag.x, frag.y); // y in [0,1], x in [0,aspect]

  // ---- sky ---------------------------------------------------------------
  vec3 sky = mix(uHorizon, uZenith, smoothstep(-0.15, 1.05, p.y));
  vec2 sunP = vec2(uSun.x * aspect, uSun.y);
  float sd = length(p - sunP);
  // One tight term only. A second broad one reads as a lens wash over the whole
  // sky rather than as a sun, and clips the blue to white halfway across.
  sky += uGlow.rgb * uGlow.a * exp(-sd * 3.4) * 0.30;

  vec3 col = sky;

  // ---- cirrus: a thin high veil, no blobs, pure stretched noise ----------
  if (uCirrus > 0.0) {
    vec2 cuv = vec2(p.x * 1.4 + uCirrusX, p.y * 5.5);
    float veil = fbm(cuv) * fbm(cuv * 2.3 + 9.0);
    veil = smoothstep(0.24, 0.55, veil) * smoothstep(0.15, 0.7, p.y);
    col = mix(col, uCloud, veil * uCirrus * 0.5);
  }

  // ---- far cumulus -------------------------------------------------------
  vec2 fuv = vec2(p.x + uFarX, p.y) * ${FAR_CELL.toFixed(3)} + uParallax * 0.4;
  vec2 fd = cloudField(fuv, 17.0, 11.0);
  float fa = clamp(fd.x * uSoftness, 0.0, 1.0);
  if (fa > 0.0) {
    vec3 lit = shadeCloud(fd.y, sky);
    // Aerial perspective is a mix toward the SKY, not a drop in alpha.
    col = mix(col, mix(lit, sky, ${FAR_MIX.toFixed(3)}), fa);
  }

  // ---- near cumulus ------------------------------------------------------
  vec2 nuv = vec2(p.x + uNearX, p.y) * ${NEAR_CELL.toFixed(3)} + uParallax;
  vec2 nd = cloudField(nuv, 3.0, 8.5);
  float na = clamp(nd.x * uSoftness, 0.0, 1.0);
  if (na > 0.0) {
    vec3 lit = shadeCloud(nd.y, sky);
    // A second sample one step UP is the inter-cloud shadow: a billow standing
    // over this one dims it beyond its own top-lit gradient.
    float above = clamp(cloudField(nuv + vec2(0.0, ${SHADOW_STEP.toFixed(3)}), 3.0, 8.5).x * uSoftness, 0.0, 1.0);
    lit *= 1.0 - 0.18 * uShadow * above;
    // The sun side of a billow picks up the glow.
    lit += uGlow.rgb * uGlow.a * 0.22 * exp(-length(p - sunP) * 1.6);
    col = mix(col, lit, na);
  }

  gl_FragColor = vec4(col, 1.0);
}
`

/* ══ Обвязка вместо React ═══════════════════════════════════════════
 * Всё выше — шейдеры и константы из saittest/src/components/CloudSky.tsx,
 * перенесены без единого изменения. React там был только оболочкой вокруг
 * канваса, поэтому ниже — обычный класс.
 *
 * Отличия от оригинала, и почему они нужны:
 *   1. Своего цикла нет. Кадры раздаёт bg.js: сцены две, и если каждая
 *      заведёт свой requestAnimationFrame, они разъедутся по времени и
 *      будут греть машину вдвое усерднее.
 *   2. Указатель слушается на window, а не на канвасе. Канвас лежит под
 *      интерфейсом с pointer-events:none и своих событий не получает.
 * ══════════════════════════════════════════════════════════════════ */

function parseColor(input, fb) {
    if (!input) return fb
    const str = String(input).trim()
    if (str.charAt(0) === "#") {
        let hex = str.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + (hex.length === 4 ? hex[3] + hex[3] : "")
        }
        if (hex.length >= 6) {
            const r = parseInt(hex.slice(0, 2), 16)
            const g = parseInt(hex.slice(2, 4), 16)
            const b = parseInt(hex.slice(4, 6), 16)
            const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r / 255, g / 255, b / 255, a]
        }
        return fb
    }
    const m = str.match(/[\d.]+/g)
    if (m && m.length >= 3) {
        return [
            Math.min(255, parseFloat(m[0])) / 255,
            Math.min(255, parseFloat(m[1])) / 255,
            Math.min(255, parseFloat(m[2])) / 255,
            m.length >= 4 ? Math.min(1, parseFloat(m[3])) : 1
        ]
    }
    return fb
}

const num = (v, fb) => (typeof v === "number" && isFinite(v) ? v : fb)
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function compile(gl, type, src) {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("CloudSky shader:", gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
    }
    return sh
}

const CLOUD_DEFAULTS = { softness: 100, shadow: 100, cirrus: 45 }
const SUN_DEFAULTS = { x: 78, y: 92, glow: "rgba(232, 243, 255, 0.9)" }
const POINTER_DEFAULTS = { parallax: 100, wind: 100, damping: 20 }

/* Настройки ровно те, что стоят в saittest/src/App.tsx у первой сцены,
   плюс пресет самого компонента. Это и есть «то самое небо». */
export const SKY_PRESET = {
    background: "#1E7BF0",
    baseColor: "#B4D2F0",
    accentColor: "#FFFFFF",
    density: 100,
    speed: 70,
    size: 130,
    clouds: { softness: 200, shadow: 70, cirrus: 100 },
    sun: { x: 78, y: 92, glow: "rgba(232, 243, 255, 0.9)" },
    pointer: { parallax: 300, wind: 300, damping: 50 }
}

export class CloudSky {
    constructor(canvas, props = {}) {
        this.canvas = canvas
        this.ok = false
        this.v = {}
        this.ptr = { x: 0, y: 0, inside: false }
        this.last = performance.now()
        this.nearX = 0
        this.farX = 0
        this.cirrusX = 0
        this.leanX = 0
        this.leanY = 0

        const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false })
        if (!gl) return

        const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC)
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
        if (!vs || !fs) return
        const prog = gl.createProgram()
        gl.attachShader(prog, vs)
        gl.attachShader(prog, fs)
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error("CloudSky link:", gl.getProgramInfoLog(prog))
            return
        }
        gl.useProgram(prog)

        const buf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        const aPos = gl.getAttribLocation(prog, "a_pos")
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

        const locs = {}
        this.u = (name) => {
            if (!(name in locs)) locs[name] = gl.getUniformLocation(prog, name)
            return locs[name]
        }

        this.gl = gl
        this.ok = true
        this.setProps({ ...SKY_PRESET, ...props })

        this._track = (e) => {
            const r = canvas.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) return
            this.ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1
            this.ptr.y = 1 - ((e.clientY - r.top) / r.height) * 2
            this.ptr.inside = true
        }
        this._leave = () => { this.ptr.inside = false }
        window.addEventListener("pointermove", this._track, { passive: true })
        window.addEventListener("pointerleave", this._leave)
    }

    setProps(p) {
        const clouds = { ...CLOUD_DEFAULTS, ...(p.clouds || {}) }
        const sun = { ...SUN_DEFAULTS, ...(p.sun || {}) }
        const ptr = { ...POINTER_DEFAULTS, ...(p.pointer || {}) }
        this.v = {
            zenith: p.background, horizon: p.baseColor, cloud: p.accentColor, glow: sun.glow,
            coverage: clampN(num(p.density, 55), 0, 100) / 100,
            speed: clampN(num(p.speed, 50), 0, 100) / 50,
            size: clampN(num(p.size, 100), 20, 300) / 100,
            softness: 4.5 / Math.max(0.15, clampN(num(clouds.softness, 100), 20, 300) / 100),
            shadow: clampN(num(clouds.shadow, 100), 0, 200) / 100,
            cirrus: clampN(num(clouds.cirrus, 45), 0, 100) / 100,
            sunX: clampN(num(sun.x, 78), 0, 100) / 100,
            sunY: clampN(num(sun.y, 92), 0, 100) / 100,
            parallax: clampN(num(ptr.parallax, 100), 0, 300) / 100,
            wind: clampN(num(ptr.wind, 100), 0, 300) / 100,
            damping: clampN(num(ptr.damping, 20), 1, 100)
        }
    }

    /** Один кадр. Время приходит снаружи — общий цикл в bg.js. */
    frame(now) {
        if (!this.ok) return
        const gl = this.gl
        const canvas = this.canvas
        const v = this.v
        const p = this.ptr

        const dt = Math.min(0.05, (now - this.last) / 1000)
        this.last = now

        const k = 1 - Math.exp(-v.damping * 0.12 * dt)
        this.leanX += ((p.inside ? p.x : 0) - this.leanX) * k
        this.leanY += ((p.inside ? p.y : 0) - this.leanY) * k

        const gust = 1 + this.leanX * v.wind
        const rate = v.speed * gust
        this.nearX = (this.nearX - NEAR_DRIFT * rate * dt) % 1000
        this.farX = (this.farX - FAR_DRIFT * rate * dt) % 1000
        this.cirrusX = (this.cirrusX - CIRRUS_DRIFT * rate * dt) % 1000

        // Потолок плотности ниже, чем в оригинале: там это была витрина на
        // весь экран, здесь — фон под интерфейсом, и лишние пиксели видно
        // не будет, а батарею они съедят.
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
        const bw = Math.max(1, Math.round((canvas.clientWidth || 1200) * dpr))
        const bh = Math.max(1, Math.round((canvas.clientHeight || 800) * dpr))
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
        gl.viewport(0, 0, bw, bh)

        const zen = parseColor(v.zenith, [0.369, 0.576, 0.824, 1])
        const hor = parseColor(v.horizon, [0.706, 0.824, 0.941, 1])
        const cld = parseColor(v.cloud, [1, 1, 1, 1])
        const glow = parseColor(v.glow, [0.91, 0.953, 1, 0.9])
        const u = this.u

        gl.uniform2f(u("uRes"), bw, bh)
        gl.uniform1f(u("uNearX"), this.nearX)
        gl.uniform1f(u("uFarX"), this.farX)
        gl.uniform1f(u("uCirrusX"), this.cirrusX)
        gl.uniform1f(u("uCoverage"), v.coverage)
        gl.uniform1f(u("uSize"), v.size)
        gl.uniform1f(u("uSoftness"), v.softness)
        gl.uniform1f(u("uShadow"), v.shadow)
        gl.uniform1f(u("uCirrus"), v.cirrus)
        gl.uniform2f(u("uSun"), v.sunX, v.sunY)
        gl.uniform2f(u("uParallax"), -this.leanX * v.parallax * 0.07, -this.leanY * v.parallax * 0.05)
        gl.uniform3f(u("uZenith"), zen[0], zen[1], zen[2])
        gl.uniform3f(u("uHorizon"), hor[0], hor[1], hor[2])
        gl.uniform3f(u("uCloud"), cld[0], cld[1], cld[2])
        gl.uniform4f(u("uGlow"), glow[0], glow[1], glow[2], glow[3])

        gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    /* Пауза может длиться долго, и накопленное «now - last» дало бы один
       гигантский шаг. Отметку времени сбрасываем при возобновлении. */
    resume(now) { this.last = now }

    dispose() {
        window.removeEventListener("pointermove", this._track)
        window.removeEventListener("pointerleave", this._leave)
    }
}
