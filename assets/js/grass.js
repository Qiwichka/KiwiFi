// Grass Field — Originkit
// Originkit — props baked into the default export.


const MAX_DPR = 2
const MAX_BLADES = 40000
const VERTS_PER_BLADE = 9
const GOLDEN = 0.6180339887498949
const SILVER = 0.41421356237309515
const TRIBO = 0.7320508075688772

// Меш земли расширяется как 3.0 + 1.05 * глубина, а кадр - как глубина * ar / FOCAL,
// поэтому геометрия покрывает экран только до ar = 1.05 * FOCAL. На более широком
// канвасе в кадр въезжают её края. uSpread растягивает поле по x ровно во столько
// же раз, во сколько кадр шире расчётного: плотность на экране не меняется.
const DESIGN_AR = 1.05 * 1.55

const EYE_Y = 1.35
const PITCH = 0.135
const FOCAL = 1.55

const QUAD_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

const SKY_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uTop;
uniform vec3  uLow;

float sat(float x) { return clamp(x, 0.0, 1.0); }

float h21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
               mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

float fbm4(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.1 + vec2(3.1, 1.7); a *= 0.5; }
    return s;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 c = mix(uLow, uTop, pow(sat(uv.y), 0.85));
    float cl = fbm4(vec2(uv.x * 2.4 + uTime * 0.012, uv.y * 3.4));
    c = mix(c, vec3(1.0), sat((cl - 0.52) * 1.5) * 0.55 * smoothstep(0.28, 1.0, uv.y));
    gl_FragColor = vec4(c, 1.0);
}
`

/* Shared by the ground mesh and the blades. */
const FIELD_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 uHaze;
varying vec3 vCol;
varying float vFog;

void main() {
    gl_FragColor = vec4(mix(vCol, uHaze, vFog * 0.82), 1.0);
}
`

const HILL_GLSL = `
uniform float uTerrain;
float hill(vec2 b) {
    return uTerrain * (
          0.42 * sin(b.x * 0.155 + 0.6) * cos(b.y * 0.105)
        + 0.30 * sin(b.y * 0.185 + 1.1)
        - 0.10 * cos(b.x * 0.34 - b.y * 0.2)
    );
}
`

const GROUND_VS = `
precision highp float;
attribute vec2 a_xz;

uniform float uAspect;
uniform float uSpread;
uniform float uF;
uniform vec3  uEye;
uniform float uPitch;
uniform vec3  uBase;

varying vec3 vCol;
varying float vFog;

float h21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
}

${HILL_GLSL}

void main() {
    vec2 b = vec2(a_xz.x * uSpread, a_xz.y);
    vec3 P = vec3(b.x, hill(b) - 0.012, b.y);
    vec3 rel = P - uEye;
    float cp = cos(uPitch), sp = sin(uPitch);
    float wx = rel.x;
    float wy = rel.y * cp - rel.z * sp;
    float depth = max(-rel.y * sp - rel.z * cp, 0.05);
    gl_Position = vec4(uF * wx / uAspect, uF * wy, 1.00334 * depth - 0.2003, depth);

    float e = 0.55;
    vec3 n = normalize(vec3(
        hill(b - vec2(e, 0.0)) - hill(b + vec2(e, 0.0)),
        2.0 * e,
        hill(b - vec2(0.0, e)) - hill(b + vec2(0.0, e))
    ));
    float lam = 0.42 + 0.58 * clamp(dot(n, normalize(vec3(-0.35, 0.80, 0.48))), 0.0, 1.0);
    vCol = uBase * (0.55 + 0.85 * lam) * (0.80 + 0.35 * h21(b * 1.7));
    vFog = clamp((depth - 8.0) / 26.0, 0.0, 1.0);
}
`

const BLADE_VS = `
precision highp float;
attribute vec2 a_base;
attribute vec2 a_param;
attribute vec2 a_rand;

uniform float uTime;
uniform float uAspect;
uniform float uSpread;
uniform float uF;
uniform vec3  uEye;
uniform float uPitch;
uniform vec2  uPush;
uniform float uPushAmt;
uniform float uReach;
uniform float uHeight;
uniform float uWind;
uniform float uGust;
uniform vec2  uWindDir;
uniform vec3  uBase;
uniform vec3  uTip;

varying vec3 vCol;
varying float vFog;

float h21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
}

${HILL_GLSL}

void main() {
    vec2 base = vec2(a_base.x * uSpread, a_base.y);
    float v = a_param.x;
    float side = a_param.y;

    float y0 = hill(base);
    float h = (0.16 + 0.20 * a_rand.x) * uHeight;
    float ang = a_rand.y * 6.2831853;
    vec2 lean = normalize(uWindDir + 0.55 * vec2(cos(ang), sin(ang)));

    float wind = sin(uTime * 1.25 + base.x * 0.55 + base.y * 0.30 + a_rand.x * 6.28) * 0.5 + 0.5;
    float gust = 1.0 - uGust * 0.5 + uGust * 0.5 * sin(uTime * 0.42 - base.y * 0.16);
    float bend = (0.10 + 0.16 * wind) * gust * uWind;

    vec2 dp = base - uPush;
    float dl = length(dp) + 1e-4;
    float push = uPushAmt * exp(-dl * dl / max(uReach, 0.05));

    vec2 off = lean * bend * v * v + (dp / dl) * push * v * v * 0.75;
    float drop = 1.0 - 0.30 * dot(off, off) / max(h * h, 1e-4);
    vec3 P = vec3(base.x + off.x, y0 + h * v * clamp(drop, 0.45, 1.0), base.y + off.y);

    vec2 perp = normalize(mix(vec2(1.0, 0.0), vec2(-lean.y, lean.x), 0.40));
    float wdt = (0.0080 + 0.0040 * a_rand.y) * (1.0 - 0.88 * v);
    P.xz += perp * side * wdt;

    vec3 rel = P - uEye;
    float cp = cos(uPitch), sp = sin(uPitch);
    float wx = rel.x;
    float wy = rel.y * cp - rel.z * sp;
    float depth = max(-rel.y * sp - rel.z * cp, 0.05);
    gl_Position = vec4(uF * wx / uAspect, uF * wy, 1.00334 * depth - 0.2003, depth);

    vec3 nrm = normalize(vec3(lean.x * 0.55, 1.0, lean.y * 0.55));
    float lam = 0.34 + 0.66 * clamp(dot(nrm, normalize(vec3(-0.35, 0.80, 0.48))), 0.0, 1.0);
    vec3 c = mix(uBase, uTip, pow(v, 0.85));
    c *= 0.55 + 0.45 * lam;
    c *= 0.70 + 0.42 * h21(base * 3.1);
    c *= mix(0.42, 1.0, pow(v, 0.7));
    vCol = c;
    vFog = clamp((depth - 8.0) / 26.0, 0.0, 1.0);
}
`

/* ══ Обвязка вместо React ═══════════════════════════════════════════
 * Всё выше — шейдеры и константы из
 * saittest/src/components/GrassField.tsx, перенесены без изменений.
 *
 * Сцена тяжелее неба: три программы (небо, земля, стебли) и сорок тысяч
 * травинок, чья геометрия считается на процессоре один раз при запуске.
 * Из-за этого создание объекта заметно дороже кадра — держим экземпляр,
 * а не пересоздаём его при смене настроек.
 * ══════════════════════════════════════════════════════════════════ */

function parseColorG(input, fb) {
    if (!input) return fb
    const str = String(input).trim()
    if (str.charAt(0) === "#") {
        let hex = str.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
        }
        if (hex.length >= 6) {
            const r = parseInt(hex.slice(0, 2), 16)
            const g = parseInt(hex.slice(2, 4), 16)
            const b = parseInt(hex.slice(4, 6), 16)
            if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return [r / 255, g / 255, b / 255]
        }
        return fb
    }
    const m = str.match(/[\d.]+/g)
    if (m && m.length >= 3) {
        return [
            Math.min(255, parseFloat(m[0])) / 255,
            Math.min(255, parseFloat(m[1])) / 255,
            Math.min(255, parseFloat(m[2])) / 255
        ]
    }
    return fb
}

const numG = (v, fb) => (typeof v === "number" && isFinite(v) ? v : fb)
const clampG = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function compileG(gl, type, src) {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("GrassField shader:", gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
    }
    return sh
}

function linkProgram(gl, vsSrc, fsSrc) {
    const vs = compileG(gl, gl.VERTEX_SHADER, vsSrc)
    const fs = compileG(gl, gl.FRAGMENT_SHADER, fsSrc)
    if (!vs || !fs) return null
    const p = gl.createProgram()
    gl.attachShader(p, vs)
    gl.attachShader(p, fs)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        console.error("GrassField link:", gl.getProgramInfoLog(p))
        return null
    }
    return p
}

/* Адреса униформ живут ПО ПРОГРАММЕ. Один общий кэш по имени выдал бы
   адрес из программы неба программе стеблей. */
function uniformer(gl, prog) {
    const cache = {}
    return (name) => {
        if (!(name in cache)) cache[name] = gl.getUniformLocation(prog, name)
        return cache[name]
    }
}

const FIELD_DEFAULTS = { bladeHeight: 100, terrain: 100, haze: 100 }
const WIND_DEFAULTS = { strength: 100, gust: 90, direction: 15 }

/* Настройки из saittest/src/App.tsx, первая сцена. */
export const GRASS_PRESET = {
    background: "#7FB0EA",
    horizon: "#CFE2F5",
    bladeBase: "#0B1D08",
    bladeTip: "#5C9E2B",
    density: 100,
    speed: 100,
    field: { bladeHeight: 181, terrain: 40, haze: 100 },
    wind: { strength: 100, gust: 90, direction: 15 },
    hover: 200,
    reach: 157
}

export class GrassField {
    constructor(canvas, props = {}) {
        this.canvas = canvas
        this.ok = false
        this.v = {}
        this.ptr = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, on: 0, onTarget: 0 }
        this.last = performance.now()
        this.clock = 0

        const gl = canvas.getContext("webgl", { antialias: true, alpha: false, depth: true })
        if (!gl) return

        const skyProg = linkProgram(gl, QUAD_VS, SKY_FS)
        const groundProg = linkProgram(gl, GROUND_VS, FIELD_FS)
        const bladeProg = linkProgram(gl, BLADE_VS, FIELD_FS)
        if (!skyProg || !groundProg || !bladeProg) return

        this.gl = gl
        this.skyProg = skyProg
        this.groundProg = groundProg
        this.bladeProg = bladeProg
        this.su = uniformer(gl, skyProg)
        this.gu = uniformer(gl, groundProg)
        this.bu = uniformer(gl, bladeProg)

        this.quadBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        this.skyPos = gl.getAttribLocation(skyProg, "a_pos")

        // Земля: сетка, сгущающаяся к горизонту, чтобы клетки на экране
        // получались примерно одного размера.
        const NX = 72, NZ = 58
        const gverts = []
        const gz = (i) => -(0.04 * Math.pow(46.0 / 0.04, i / NZ))
        for (let i = 0; i < NZ; i++) {
            const z0 = gz(i), z1 = gz(i + 1)
            const s0 = 3.0 - z0 * 1.05, s1 = 3.0 - z1 * 1.05
            for (let j = 0; j < NX; j++) {
                const t0 = (j / NX) * 2 - 1, t1 = ((j + 1) / NX) * 2 - 1
                gverts.push(t0 * s0, z0, t1 * s0, z0, t0 * s1, z1, t0 * s1, z1, t1 * s0, z0, t1 * s1, z1)
            }
        }
        const gArr = new Float32Array(gverts)
        this.gBuf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this.gBuf)
        gl.bufferData(gl.ARRAY_BUFFER, gArr, gl.STATIC_DRAW)
        this.aXZ = gl.getAttribLocation(groundProg, "a_xz")
        this.groundCount = gArr.length / 2

        // Травинка: два треугольника на полотно и один на кончик.
        const quad = [[0, -1], [0, 1], [0.55, -1], [0.55, -1], [0, 1], [0.55, 1]]
        const tip = [[0.55, -1], [0.55, 1], [1, 0]]

        const baseArr = new Float32Array(MAX_BLADES * VERTS_PER_BLADE * 2)
        const paramArr = new Float32Array(MAX_BLADES * VERTS_PER_BLADE * 2)
        const randArr = new Float32Array(MAX_BLADES * VERTS_PER_BLADE * 2)
        let vi = 0
        for (let b = 0; b < MAX_BLADES; b++) {
            const uu = (b * GOLDEN) % 1
            const dist = 0.55 + 32.0 * Math.pow(uu, 1.75)
            const z = -dist
            const spread = 2.2 + dist * 0.85
            const x = ((b * SILVER) % 1) * 2 * spread - spread
            const r0 = (b * TRIBO) % 1
            const r1 = (b * 0.5436890126920763) % 1
            for (let k = 0; k < VERTS_PER_BLADE; k++) {
                const pv = k < 6 ? quad[k] : tip[k - 6]
                baseArr[vi * 2] = x
                baseArr[vi * 2 + 1] = z
                paramArr[vi * 2] = pv[0]
                paramArr[vi * 2 + 1] = pv[1]
                randArr[vi * 2] = r0
                randArr[vi * 2 + 1] = r1
                vi++
            }
        }
        const mk = (arr) => {
            const b = gl.createBuffer()
            gl.bindBuffer(gl.ARRAY_BUFFER, b)
            gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW)
            return b
        }
        this.bBase = mk(baseArr)
        this.bParam = mk(paramArr)
        this.bRand = mk(randArr)
        this.aBase = gl.getAttribLocation(bladeProg, "a_base")
        this.aParam = gl.getAttribLocation(bladeProg, "a_param")
        this.aRand = gl.getAttribLocation(bladeProg, "a_rand")

        this.ok = true
        this.setProps({ ...GRASS_PRESET, ...props })

        this._track = (e) => {
            const r = canvas.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) return
            this.ptr.tx = clampG((e.clientX - r.left) / r.width, 0, 1)
            this.ptr.ty = clampG((e.clientY - r.top) / r.height, 0, 1)
            this.ptr.onTarget = 1
        }
        this._leave = () => { this.ptr.onTarget = 0 }
        window.addEventListener("pointermove", this._track, { passive: true })
        window.addEventListener("pointerleave", this._leave)
    }

    setProps(p) {
        const fld = { ...FIELD_DEFAULTS, ...(p.field || {}) }
        const wnd = { ...WIND_DEFAULTS, ...(p.wind || {}) }
        const rad = (clampG(numG(wnd.direction, 15), 0, 360) * Math.PI) / 180
        this.v = {
            top: p.background, low: p.horizon, base: p.bladeBase, tip: p.bladeTip,
            count: Math.round(clampG(numG(p.density, 70), 10, 100) * (MAX_BLADES / 100)),
            speed: clampG(numG(p.speed, 50), 0, 100) / 50,
            bladeHeight: clampG(numG(fld.bladeHeight, 100), 30, 250) / 100,
            terrain: clampG(numG(fld.terrain, 100), 0, 250) / 100,
            haze: clampG(numG(fld.haze, 100), 0, 200) / 100,
            strength: clampG(numG(wnd.strength, 100), 0, 300) / 100,
            gust: clampG(numG(wnd.gust, 90), 0, 200) / 100,
            dir: [Math.cos(rad), Math.sin(rad)],
            hover: clampG(numG(p.hover, 100), 0, 200) / 100,
            reach: (clampG(numG(p.reach, 100), 10, 300) / 100) * 1.35
        }
    }

    frame(now) {
        if (!this.ok) return
        const gl = this.gl
        const canvas = this.canvas
        const v = this.v

        const dt = Math.min(0.05, (now - this.last) / 1000)
        this.last = now
        this.clock = (this.clock + dt * v.speed) % 3600

        const ptr = this.ptr
        const k = 1 - Math.exp(-6 * dt)
        ptr.on += (ptr.onTarget - ptr.on) * k
        ptr.x += ((ptr.onTarget > 0 ? ptr.tx : 0.5) - ptr.x) * k
        ptr.y += ((ptr.onTarget > 0 ? ptr.ty : 0.5) - ptr.y) * k

        const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
        const bw = Math.max(1, Math.round((canvas.clientWidth || 1200) * dpr))
        const bh = Math.max(1, Math.round((canvas.clientHeight || 800) * dpr))
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
        const ar = bw / Math.max(bh, 1)
        const spread = Math.max(1, ar / DESIGN_AR)
        gl.viewport(0, 0, bw, bh)

        const top = parseColorG(v.top, [0.408, 0.596, 0.878])
        const low = parseColorG(v.low, [0.741, 0.843, 0.949])
        const baseC = parseColorG(v.base, [0.043, 0.114, 0.031])
        const tipC = parseColorG(v.tip, [0.361, 0.62, 0.169])
        const haze = [
            low[0] * v.haze + (1 - v.haze) * tipC[0],
            low[1] * v.haze + (1 - v.haze) * tipC[1],
            low[2] * v.haze + (1 - v.haze) * tipC[2]
        ]

        gl.clearColor(low[0], low[1], low[2], 1)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.disable(gl.BLEND)

        gl.disable(gl.DEPTH_TEST)
        gl.depthMask(false)
        gl.useProgram(this.skyProg)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf)
        gl.enableVertexAttribArray(this.skyPos)
        gl.vertexAttribPointer(this.skyPos, 2, gl.FLOAT, false, 0, 0)
        gl.uniform2f(this.su("uRes"), bw, bh)
        gl.uniform1f(this.su("uTime"), this.clock)
        gl.uniform3f(this.su("uTop"), top[0], top[1], top[2])
        gl.uniform3f(this.su("uLow"), low[0], low[1], low[2])
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        // Луч от указателя до земли y = 0. Базис камеры при наклоне вниз a:
        // вправо (1,0,0), вверх (0,cos a,-sin a), вперёд (0,-sin a,-cos a).
        const nx = ((ptr.x * 2 - 1) * ar) / FOCAL
        const ny = ((1 - ptr.y) * 2 - 1) / FOCAL
        const cp = Math.cos(PITCH), sp = Math.sin(PITCH)
        const dx = nx
        const dy = ny * cp - sp
        const dz = -ny * sp - cp
        let pushX = 0, pushZ = -999, amt = 0
        if (dy < -1e-3) {
            const s = -EYE_Y / dy
            if (s > 0 && s < 42) {
                pushX = s * dx
                pushZ = s * dz
                amt = Math.min(1, ptr.on) * v.hover * 0.6
            }
        }

        gl.enable(gl.DEPTH_TEST)
        gl.depthFunc(gl.LEQUAL)
        gl.depthMask(true)

        const bind = (loc, bufr) => {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufr)
            gl.enableVertexAttribArray(loc)
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
        }

        gl.useProgram(this.groundProg)
        bind(this.aXZ, this.gBuf)
        gl.uniform1f(this.gu("uAspect"), ar)
        gl.uniform1f(this.gu("uSpread"), spread)
        gl.uniform1f(this.gu("uF"), FOCAL)
        gl.uniform3f(this.gu("uEye"), 0, EYE_Y, 0)
        gl.uniform1f(this.gu("uPitch"), PITCH)
        gl.uniform1f(this.gu("uTerrain"), v.terrain)
        gl.uniform3f(this.gu("uBase"), baseC[0], baseC[1], baseC[2])
        gl.uniform3f(this.gu("uHaze"), haze[0], haze[1], haze[2])
        gl.drawArrays(gl.TRIANGLES, 0, this.groundCount)

        gl.useProgram(this.bladeProg)
        bind(this.aBase, this.bBase)
        bind(this.aParam, this.bParam)
        bind(this.aRand, this.bRand)
        gl.uniform1f(this.bu("uTime"), this.clock)
        gl.uniform1f(this.bu("uAspect"), ar)
        gl.uniform1f(this.bu("uSpread"), spread)
        gl.uniform1f(this.bu("uF"), FOCAL)
        gl.uniform3f(this.bu("uEye"), 0, EYE_Y, 0)
        gl.uniform1f(this.bu("uPitch"), PITCH)
        gl.uniform2f(this.bu("uPush"), pushX, pushZ)
        gl.uniform1f(this.bu("uPushAmt"), amt)
        gl.uniform1f(this.bu("uReach"), v.reach)
        gl.uniform1f(this.bu("uHeight"), v.bladeHeight)
        gl.uniform1f(this.bu("uWind"), v.strength)
        gl.uniform1f(this.bu("uGust"), v.gust)
        gl.uniform2f(this.bu("uWindDir"), v.dir[0], v.dir[1])
        gl.uniform1f(this.bu("uTerrain"), v.terrain)
        gl.uniform3f(this.bu("uBase"), baseC[0], baseC[1], baseC[2])
        gl.uniform3f(this.bu("uTip"), tipC[0], tipC[1], tipC[2])
        gl.uniform3f(this.bu("uHaze"), haze[0], haze[1], haze[2])
        gl.drawArrays(gl.TRIANGLES, 0, v.count * VERTS_PER_BLADE)
    }

    resume(now) { this.last = now }

    dispose() {
        window.removeEventListener("pointermove", this._track)
        window.removeEventListener("pointerleave", this._leave)
    }
}
