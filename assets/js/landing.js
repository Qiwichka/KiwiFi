/*
 * landing.js — небо на главной странице.
 *
 * Сцена одна, поэтому дирижёр из bg.js здесь не нужен: там он нужен, чтобы
 * небо и трава шли кадр в кадр, а тут травы нет.
 *
 * Ограничители те же, что и в приложении, и по той же причине —
 * полноэкранный шейдер иначе греет машину просто так:
 *   1. кадры режутся до 30;
 *   2. вкладка скрыта — цикл встаёт совсем;
 *   3. WebGL не поднялся — под канвасом лежит градиент, страница цела.
 */

import { CloudSky, SKY_PRESET } from "./sky.js"
import { initArrowButtons } from "./arrowbtn.js"

const FPS_CAP = 30

initArrowButtons()

const canvas = document.getElementById("sky")
const sky = new CloudSky(canvas, SKY_PRESET)

if (!sky.ok) {
    console.warn("KiwiFi: WebGL недоступен, остаётся статичный фон")
} else {
    document.getElementById("bg").classList.add("is-live")

    let raf = 0
    let last = 0

    const loop = (t) => {
        raf = requestAnimationFrame(loop)
        if (t - last < 1000 / FPS_CAP) return
        last = t
        sky.frame(t)
    }

    const start = () => {
        if (raf) return
        // Пауза могла длиться минуты, и накопленное «now - last» дало бы
        // один гигантский шаг: облака прыгнули бы через полнеба.
        sky.resume(performance.now())
        raf = requestAnimationFrame(loop)
    }
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0 }

    document.addEventListener("visibilitychange", () => document.hidden ? stop() : start())

    sky.frame(performance.now())
    start()
}
