/*
 * viz.js — визуализатор в панели плеера.
 *
 * Рисует спектр столбиками по всей ширине панели. Смотрит на движок сам:
 * есть анализ — рисует настоящий звук, нет — ровную волну, которая просто
 * дышит в такт воспроизведению.
 *
 * Запасной вариант нужен не для красоты. Треки SoundCloud играют внутри
 * чужого iframe, и до их звука Web Audio не дотянется НИКОГДА. Показывать
 * на них замерший в нуле визуализатор — значит выглядеть сломанным;
 * поэтому рисуется заведомо другая, спокойная волна, и это читается как
 * задумка.
 *
 * Цикл общий с фоном по тем же соображениям: кадры режутся, при скрытой
 * вкладке всё встаёт. Полноэкранный шейдер и спектр разом на слабой
 * машине — это уже заметно.
 */

const FPS_CAP = 30
const BARS = 56          // столько столбиков помещается, не сливаясь
const FLOOR = 0.06       // минимальная высота: пустая полоса выглядит поломкой

export class Viz {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {import("./player/engine.js").Engine} engine
     */
    constructor(canvas, engine) {
        this.c = canvas
        this.engine = engine
        this.ctx = canvas.getContext("2d")
        this.raf = 0
        this.last = 0
        this.t = 0
        // Сглаживание своё, поверх аналайзерного: столбик падает медленнее,
        // чем растёт, иначе на резких звуках картинка мерцает.
        this.vals = new Float32Array(BARS)

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) this.stop(); else this.start()
        })
    }

    start() {
        if (this.raf) return
        const loop = (now) => {
            this.raf = requestAnimationFrame(loop)
            if (now - this.last < 1000 / FPS_CAP) return
            this.last = now
            this.draw(now)
        }
        this.raf = requestAnimationFrame(loop)
    }

    stop() {
        if (this.raf) cancelAnimationFrame(this.raf)
        this.raf = 0
    }

    draw(now) {
        const c = this.c
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const w = Math.max(1, Math.round(c.clientWidth * dpr))
        const h = Math.max(1, Math.round(c.clientHeight * dpr))
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h }

        const g = this.ctx
        g.clearRect(0, 0, w, h)

        const playing = this.engine.playing
        const graph = this.engine.graph
        const bins = playing && graph && graph.ready ? graph.read() : null

        // Затухание, когда музыка стоит: резко гасить некрасиво
        const idle = !playing

        this.t += 1 / FPS_CAP

        for (let i = 0; i < BARS; i++) {
            let target
            if (bins) {
                // Полосы спектра распределены линейно, а слух — логарифмически:
                // без сжатия почти вся картинка жила бы в левой четверти.
                const p = Math.pow(i / BARS, 1.7)
                const idx = Math.min(bins.length - 1, Math.floor(p * bins.length))
                target = bins[idx] / 255
            } else if (idle) {
                target = 0
            } else {
                // Запасная волна для источников без анализа: спокойная,
                // явно непохожая на спектр, чтобы не принять за поломку.
                target = 0.18 + 0.12 * Math.sin(this.t * 2 + i * 0.35)
                       + 0.06 * Math.sin(this.t * 3.7 + i * 0.11)
            }
            const v = this.vals[i]
            // Вверх быстро, вниз медленно
            this.vals[i] = target > v ? target : v + (target - v) * 0.18
        }

        const bw = w / BARS
        const gap = Math.max(1, bw * 0.28)
        const style = getComputedStyle(document.documentElement)
        const accent = style.getPropertyValue("--accent").trim() || "#D97757"

        g.fillStyle = accent
        for (let i = 0; i < BARS; i++) {
            const v = Math.max(FLOOR, Math.min(1, this.vals[i]))
            const bh = v * h
            const x = i * bw + gap / 2
            const bwid = bw - gap
            // Скруглённые столбики: на тонкой полосе прямые углы выглядят
            // грязно, особенно при высоком dpr
            const r = Math.min(bwid / 2, 3 * dpr)
            g.beginPath()
            g.roundRect ? g.roundRect(x, h - bh, bwid, bh, r)
                        : g.rect(x, h - bh, bwid, bh)
            g.fill()
        }
    }
}
