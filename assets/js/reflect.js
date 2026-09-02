/*
 * reflect.js — сцена «глубина»: тёмная вода.
 *
 * Шейдер из saittest/src/components/ReflectBackground.tsx (Originkit),
 * вторая сцена того сайта. Здесь она не основная: основная — «луг»
 * (sky.js + grass.js). Эта пойдёт как альтернативный фон для плейлистов,
 * когда дойдём до них, — тёмная и спокойная, под неё нужно куда меньше
 * затемнения, чем под яркое небо.
 *
 * Интерфейс тот же, что у остальных сцен: frame(now) рисует один кадр,
 * кадры раздаёт bg.js.
 */

const VERTEX_SRC = `
attribute vec4 a_position;
void main() { gl_Position = a_position; }
`

const FRAGMENT_SRC = `
precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform float u_speed;
uniform vec3 u_tint;
uniform float u_scale;
uniform float u_contrast;
uniform float u_iterations;
uniform vec2 u_pointer;
uniform float u_pointerStrength;

#define TAU 6.28318530718
#define MAX_ITER 8

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float time = iTime * u_speed + 23.0;
    vec2 uv = fragCoord.xy / iResolution.xy;

    vec2 p = mod(uv * TAU * u_scale, TAU) - 250.0;

    vec2 pointerDelta = uv - u_pointer;
    pointerDelta.x *= iResolution.x / max(iResolution.y, 1.0);
    float pointerDist = length(pointerDelta);
    p += normalize(pointerDelta + 1e-4) * u_pointerStrength * exp(-pointerDist * 4.0) * TAU;

    vec2 i = vec2(p);
    float c = 1.0;
    float inten = 0.005;
    float used = 0.0;

    for (int n = 0; n < MAX_ITER; n++) {
        if (float(n) >= u_iterations) break;
        float t = time * (1.0 - (3.5 / float(n + 1)));
        i = p + vec2(
            cos(t - i.x) + sin(t + i.y),
            sin(t - i.y) + cos(t + i.x)
        );
        // Знаменатели не подпускаем к нулю: иначе выражение улетает за
        // предел точности float и на части видеокарт даёт NaN, то есть
        // чёрный экран вместо фона.
        float sx = sin(i.x + t) / inten;
        float sy = cos(i.y + t) / inten;
        sx = (sx >= 0.0 ? 1.0 : -1.0) * max(abs(sx), 0.05);
        sy = (sy >= 0.0 ? 1.0 : -1.0) * max(abs(sy), 0.05);
        c += 1.0 / length(vec2(p.x / sx, p.y / sy));
        used += 1.0;
    }

    c /= max(used, 1.0);
    c = 1.17 - pow(c, 1.4);

    float lum = pow(abs(c), u_contrast);
    vec3 colour = clamp(u_tint * lum * 2.0, 0.0, 1.0);

    fragColor = vec4(colour, 1.0);
}

void main() { mainImage(gl_FragColor, gl_FragCoord.xy); }
`

function parseColorR(input, fb) {
    if (!input) return fb
    const str = String(input).trim()
    if (str[0] === "#") {
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
    }
    return fb
}

function compileR(gl, type, src) {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("Reflect shader:", gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
    }
    return sh
}

export const REFLECT_PRESET = { tint: "#005980", speed: 80, contrast: 8, iterations: 5 }

export class ReflectScene {
    constructor(canvas, props = {}) {
        this.canvas = canvas
        this.ok = false
        this.t0 = performance.now()
        this.ptr = { x: 0.5, y: 0.5 }
        this.pAct = 0
        this.pTarget = 0

        const gl = canvas.getContext("webgl", {
            antialias: false, depth: false, stencil: false, powerPreference: "low-power"
        })
        if (!gl) return

        const vs = compileR(gl, gl.VERTEX_SHADER, VERTEX_SRC)
        const fs = compileR(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC)
        if (!vs || !fs) return
        const prog = gl.createProgram()
        gl.attachShader(prog, vs)
        gl.attachShader(prog, fs)
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error("Reflect link:", gl.getProgramInfoLog(prog))
            return
        }
        gl.useProgram(prog)

        const buf = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
        const pos = gl.getAttribLocation(prog, "a_position")
        gl.enableVertexAttribArray(pos)
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)

        this.gl = gl
        this.u = {
            res: gl.getUniformLocation(prog, "iResolution"),
            time: gl.getUniformLocation(prog, "iTime"),
            spd: gl.getUniformLocation(prog, "u_speed"),
            tint: gl.getUniformLocation(prog, "u_tint"),
            scl: gl.getUniformLocation(prog, "u_scale"),
            ctr: gl.getUniformLocation(prog, "u_contrast"),
            itr: gl.getUniformLocation(prog, "u_iterations"),
            ptr: gl.getUniformLocation(prog, "u_pointer"),
            pstr: gl.getUniformLocation(prog, "u_pointerStrength")
        }
        this.ok = true
        this.setProps({ ...REFLECT_PRESET, ...props })

        this._track = (e) => {
            const r = canvas.getBoundingClientRect()
            if (!r.width || !r.height) return
            this.ptr.x = (e.clientX - r.left) / r.width
            this.ptr.y = 1 - (e.clientY - r.top) / r.height
            this.pTarget = 1
        }
        this._leave = () => { this.pTarget = 0 }
        window.addEventListener("pointermove", this._track, { passive: true })
        window.addEventListener("pointerleave", this._leave)
    }

    setProps(p) {
        this.v = {
            tint: parseColorR(p.tint, [0, 0.35, 0.5]),
            speed: (p.speed / 100) * 0.5,
            contrast: p.contrast,
            iterations: Math.round(p.iterations)
        }
    }

    frame(now) {
        if (!this.ok) return
        const gl = this.gl
        const c = this.canvas
        const v = this.v

        const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
        const bw = Math.max(1, Math.round((c.clientWidth || 300) * dpr))
        const bh = Math.max(1, Math.round((c.clientHeight || 300) * dpr))
        if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh }
        gl.viewport(0, 0, bw, bh)

        gl.uniform2f(this.u.res, bw, bh)
        gl.uniform1f(this.u.time, (now - this.t0) / 1000)
        gl.uniform1f(this.u.spd, v.speed)
        gl.uniform3f(this.u.tint, v.tint[0], v.tint[1], v.tint[2])
        gl.uniform1f(this.u.scl, 1)
        gl.uniform1f(this.u.ctr, v.contrast)
        gl.uniform1f(this.u.itr, v.iterations)

        this.pAct += (this.pTarget - this.pAct) * 0.08
        gl.uniform2f(this.u.ptr, this.ptr.x, this.ptr.y)
        gl.uniform1f(this.u.pstr, 0.4 * this.pAct)

        gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    resume() {}

    dispose() {
        window.removeEventListener("pointermove", this._track)
        window.removeEventListener("pointerleave", this._leave)
    }
}
