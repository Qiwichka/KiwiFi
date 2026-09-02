/*
 * bg.js — живой фон приложения.
 *
 * Сам ничего не рисует: держит сцены и раздаёт им кадры. Сцены живут в
 * sky.js, grass.js, reflect.js — каждая умеет ровно одно, frame(now).
 *
 * Почему цикл здесь, а не в каждой сцене. «Луг» — это ДВЕ сцены сразу,
 * небо и трава, на двух канвасах. Заведи каждая свой requestAnimationFrame,
 * они разошлись бы по времени (кадры чередуются, а не идут парами), и
 * трава колыхалась бы не в такт облакам. Плюс два независимых цикла греют
 * машину вдвое усерднее одного.
 *
 * Про батарею — три ограничителя, снимать их не стоит:
 *   1. кадры режутся до FPS_CAP: на плавном фоне 30 от 60 не отличить;
 *   2. вкладка скрыта или окно свёрнуто — цикл встаёт совсем;
 *   3. режим "off" рисует один кадр и замирает статичной картинкой.
 *
 * Отдельно: WebGL-контекстов у браузера считанные единицы (обычно около
 * шестнадцати), после чего он молча убивает самые старые. Поэтому канвасы
 * создаются один раз на всё приложение и переиспользуются, а смена сцены —
 * это показать один и спрятать другой, не пересоздавая.
 */

import { CloudSky, SKY_PRESET } from "./sky.js"
import { GrassField, GRASS_PRESET } from "./grass.js"
import { ReflectScene, REFLECT_PRESET } from "./reflect.js"

const FPS_CAP = 30

/* Наборы фонов. Плейлист хранит только имя набора и, если надо, поправку
   к затемнению — так фон плейлиста весит несколько байт, а не картинку.
   dim — сила вуали поверх: у яркого луга она обязана быть высокой, иначе
   белый текст на белых облаках просто пропадёт. */
export const SCENES = {
    meadow: {
        kind: "meadow",
        dim: 0.40,
        sky: SKY_PRESET,
        grass: GRASS_PRESET
    },
    sunset: {
        kind: "meadow",
        dim: 0.42,
        sky: { ...SKY_PRESET, background: "#E86A3C", baseColor: "#F5C89E", speed: 45 },
        grass: { ...GRASS_PRESET, background: "#E8916A", horizon: "#F7D8BE", bladeTip: "#8E7A2B" }
    },
    night: {
        kind: "meadow",
        dim: 0.24,
        sky: { ...SKY_PRESET, background: "#0E1A38", baseColor: "#22345C", accentColor: "#95A8CC", speed: 30 },
        grass: { ...GRASS_PRESET, background: "#16244A", horizon: "#2A3A63", bladeTip: "#2E5E44" }
    },
    deep: {
        kind: "reflect",
        dim: 0.45,
        reflect: REFLECT_PRESET
    }
}

export class Background {
    /**
     * @param {{sky:HTMLCanvasElement, grass:HTMLCanvasElement, reflect:HTMLCanvasElement}} canvases
     * @param {"on"|"paused-only"|"off"} mode
     */
    constructor(canvases, mode = "on") {
        this.el = canvases
        this.mode = mode
        this.raf = 0
        this.last = 0
        this.playing = false
        this.kind = null

        this.sky = new CloudSky(canvases.sky, SCENES.meadow.sky)
        this.grass = new GrassField(canvases.grass, SCENES.meadow.grass)
        this.reflect = new ReflectScene(canvases.reflect, REFLECT_PRESET)

        // Хоть одна сцена не поднялась — значит WebGL нет или он отвалился.
        // Не беда: под канвасами лежит статичный градиент, он и останется.
        // Приложение обязано работать без фона.
        this.ok = this.sky.ok && this.grass.ok
        if (!this.ok) {
            console.warn("KiwiFi: WebGL недоступен, остаётся статичный фон")
            return
        }

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) this.stop()
            else this.start()
        })

        this.setScene("meadow")
        this.start()
    }

    /** Переключить набор фона. Позже сюда будет ходить выбор плейлиста. */
    setScene(name) {
        const s = SCENES[name] || SCENES.meadow
        if (!this.ok) return
        this.scene = s

        if (s.kind === "meadow") {
            this.sky.setProps(s.sky)
            this.grass.setProps(s.grass)
        } else {
            this.reflect.setProps(s.reflect)
        }

        this.kind = s.kind
        this.el.sky.hidden = s.kind !== "meadow"
        this.el.grass.hidden = s.kind !== "meadow"
        this.el.reflect.hidden = s.kind !== "reflect"

        // Вуаль — обычная CSS-переменная, поэтому переход между наборами
        // получается плавным сам собой, без единой строчки кода.
        document.documentElement.style.setProperty("--dim", s.dim)

        this._frame(performance.now())
        requestAnimationFrame(() => this.el.wrap && this.el.wrap.classList.add("is-live"))
    }

    setMode(mode) { this.mode = mode; this._sync() }

    /** Движок сообщает, играет ли музыка — от этого зависит "paused-only". */
    setPlaying(v) { this.playing = v; this._sync() }

    _sync() {
        const live = this.mode === "on" || (this.mode === "paused-only" && !this.playing)
        if (live) this.start()
        else { this.stop(); this._frame(performance.now()) }
    }

    start() {
        if (!this.ok || this.raf) return
        if (this.mode === "off") return
        if (this.mode === "paused-only" && this.playing) return

        // Пауза могла длиться минуты, и накопленное «now - last» дало бы
        // сценам один гигантский шаг: облака прыгнули бы через полнеба.
        const now = performance.now()
        this.sky.resume(now)
        this.grass.resume(now)
        this.reflect.resume(now)

        const loop = (t) => {
            this.raf = requestAnimationFrame(loop)
            if (t - this.last < 1000 / FPS_CAP) return
            this.last = t
            this._frame(t)
        }
        this.raf = requestAnimationFrame(loop)
    }

    stop() {
        if (this.raf) cancelAnimationFrame(this.raf)
        this.raf = 0
    }

    _frame(t) {
        if (!this.ok) return
        if (this.kind === "meadow") {
            this.sky.frame(t)
            this.grass.frame(t)
        } else {
            this.reflect.frame(t)
        }
    }
}
