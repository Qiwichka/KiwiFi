/*
 * prefs.js — мелкие настройки в localStorage.
 *
 * Почему не в IndexedDB вместе с остальным: эти значения нужны ДО первой
 * отрисовки — громкость, последний экран, где остановился трек. IndexedDB
 * асинхронна, и ради неё пришлось бы либо ждать с пустым экраном, либо
 * рисовать дважды. localStorage читается синхронно, и всё это ставится
 * сразу.
 *
 * Приём с blank() взят из finan: сохранённое накладывается поверх
 * заготовки, поэтому новые поля появляются у старых сохранений сами и
 * не приходится писать миграции на каждое добавление.
 */

const KEY = "kiwi.v1"

const blank = () => ({
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: "off",      // off | all | one
    view: "home",       // последний экран
    arg: null,          // и что на нём было открыто (id плейлиста)
    scene: "meadow",    // фон по умолчанию
    bgMode: "on",       // on | paused-only | off
    lastKey: null,      // ключ последнего трека
    lastPos: 0,         // и секунда, на которой остановились
    lastFrom: null      // откуда была набрана очередь
})

let cache = null

export function load() {
    if (cache) return cache
    let saved = {}
    try {
        const raw = localStorage.getItem(KEY)
        if (raw) saved = JSON.parse(raw) || {}
    } catch (e) {
        // Испорченный JSON или запрет хранилища в приватном окне —
        // не повод падать, просто начинаем с чистого листа.
    }
    cache = Object.assign(blank(), saved)
    return cache
}

let timer = 0

/** Сохранить. Пишется не сразу: позиция трека меняется по нескольку раз
 *  в секунду, и дёргать диск на каждое изменение незачем. */
export function save(patch) {
    const p = load()
    if (patch) Object.assign(p, patch)
    clearTimeout(timer)
    timer = setTimeout(flush, 400)
}

export function flush() {
    clearTimeout(timer)
    try {
        localStorage.setItem(KEY, JSON.stringify(load()))
    } catch (e) {
        // Переполнение или запрет — молча, но приложение работает дальше
    }
}

/* Уход со страницы это последний шанс записать позицию трека:
   отложенная запись может не успеть. visibilitychange надёжнее, чем
   beforeunload — на телефонах второе часто не приходит вовсе. */
document.addEventListener("visibilitychange", () => { if (document.hidden) flush() })
window.addEventListener("pagehide", flush)
