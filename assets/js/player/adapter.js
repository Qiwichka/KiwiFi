/*
 * adapter.js — контракт движка воспроизведения.
 *
 * Треки приходят из трёх мест и играть одинаково не могут: свои файлы —
 * обычный <audio> с полным контролем, SoundCloud — чужой iframe, где до
 * самого звука не добраться никогда. Общий интерфейс поверх этих двух
 * миров и есть смысл файла.
 *
 * ГЛАВНОЕ ПРАВИЛО: интерфейс СОБЫТИЙНЫЙ, а не опросный.
 *
 * Это не вкус, это вынужденно. Все геттеры виджета SoundCloud колбэчные:
 * widget.getPosition(cb). Синхронно спросить «какая сейчас секунда» у него
 * нельзя в принципе. Если бы интерфейс опрашивал адаптеры, пришлось бы
 * делать асинхронными все геттеры и в html5-адаптере — ради движка,
 * которому это не нужно. Поэтому наоборот: адаптер сам держит state
 * свежим и кричит о переменах, а интерфейс читает готовый объект.
 *
 * ЕДИНИЦЫ. Наружу всё в СЕКУНДАХ, громкость 0..1. SoundCloud внутри себя
 * живёт в миллисекундах и громкости 0..100 — это забота его адаптера,
 * выше она не поднимается.
 */

export class Adapter extends EventTarget {
    /** Только чтение. Всегда актуален — интерфейс берёт данные отсюда. */
    state = {
        status: "idle",   // idle | loading | ready | playing | paused | ended | error
        position: 0,      // секунды
        duration: 0,      // секунды, 0 пока неизвестна
        error: null       // { code, message } | null
    }

    /* Что этот движок умеет. Движок-владелец (engine) на это смотрит,
       прежде чем предлагать кроссфейд, предзагрузку или визуализатор. */
    static caps = {
        analyse: false,    // можно ли снять сигнал: визуализатор, кроссфейд
        crossfade: false,
        preload: false,
        rate: false,       // скорость воспроизведения
        volume: true
    }

    get caps() { return this.constructor.caps }

    async load(track) { throw new Error("не реализовано") }
    async play() { throw new Error("не реализовано") }
    pause() {}
    seek(seconds) {}
    setVolume(v) {}
    async unload() {}

    /* ── Служебное для наследников ──────────────────────────────── */

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }))
    }

    _set(patch) {
        Object.assign(this.state, patch)
    }

    /** Дождаться своего же события или сдаться по времени.
     *  Нужно там, где движок не умеет сообщать об ошибке сам — см. scwidget. */
    _await(type, ms) {
        return new Promise((resolve) => {
            let done = false
            const on = () => { if (!done) { done = true; clearTimeout(t); resolve(true) } }
            const t = setTimeout(() => { if (!done) { done = true; this.removeEventListener(type, on); resolve(false) } }, ms)
            this.addEventListener(type, on, { once: true })
        })
    }
}

/* События, которые обязан слать любой адаптер, и ничего сверх:
 *
 *   ready     длительность стала известна
 *   play      пошёл звук
 *   pause     встал
 *   time      { position, duration } — примерно 4 раза в секунду
 *   ended     трек кончился сам
 *   error     { code, message }
 *   stall     буферизация, звука нет, но это не ошибка
 */
