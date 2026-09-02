/*
 * scwidget.js — движок SoundCloud поверх официального виджета.
 *
 * Почему именно виджет, а не внутреннее API:
 *   — ключи для API SoundCloud давно не выдают, а те, что достают из их
 *     же веб-плеера, протухают при каждой ротации;
 *   — из браузера во внутреннее API не попасть вообще, режет CORS;
 *   — виджет работает без ключей, легален и не ломается.
 *
 * Что он умеет: play, pause, seekTo, setVolume, getCurrentSound (название,
 * автор, обложка, длительность) и события. Этого хватает на ПОЛНОСТЬЮ свой
 * интерфейс — сам iframe спрятан, пользователь его не видит.
 *
 * Чего не будет никогда: визуализатора, кроссфейда и эквалайзера. Звук
 * лежит в чужом cross-origin iframe, Web Audio до него не дотянется. Это
 * не обходится, поэтому caps.analyse = false, и движок-владелец про это
 * знает заранее.
 *
 * iframe создаётся ОДИН на всё время жизни, трек меняется через
 * widget.load(). Пересоздавать iframe на каждый трек — это и медленно,
 * и течёт.
 */

import { Adapter } from "./adapter.js"

const API_SRC = "https://w.soundcloud.com/player/api.js"
const PLAY_TIMEOUT = 1500   // сколько ждать подтверждения запуска

let apiLoading = null

/** Скрипт виджета грузится один раз и лениво: на странице без треков
 *  SoundCloud незачем ходить в сеть вообще. */
function loadApi() {
    if (window.SC && window.SC.Widget) return Promise.resolve()
    if (apiLoading) return apiLoading
    apiLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script")
        s.src = API_SRC
        s.async = true
        s.onload = () => resolve()
        s.onerror = () => reject(new Error("не загрузился виджет SoundCloud"))
        document.head.appendChild(s)
    })
    return apiLoading
}

export class SoundCloudAdapter extends Adapter {
    static caps = {
        analyse: false,     // до звука в чужом iframe не добраться
        crossfade: false,
        preload: false,     // второй iframe поднимать не будем
        rate: false,
        volume: true
    }

    constructor() {
        super()
        this.widget = null
        this.iframe = null
        this._vol = 1
        this._ready = null
    }

    async _ensure() {
        if (this.widget) return
        await loadApi()

        const f = document.createElement("iframe")
        f.id = "sc-widget"
        f.allow = "autoplay"
        f.title = "SoundCloud"
        // display:none в некоторых движках мешает виджету стартовать,
        // поэтому не прячем, а уводим за край экрана.
        f.style.cssText =
            "position:fixed;left:-9999px;top:0;width:1px;height:1px;" +
            "opacity:0;pointer-events:none;border:0"
        f.src = "https://w.soundcloud.com/player/?url="
        document.body.appendChild(f)
        this.iframe = f

        this.widget = window.SC.Widget(f)
        const E = window.SC.Widget.Events

        await new Promise((res) => this.widget.bind(E.READY, res))

        this.widget.bind(E.PLAY, () => { this._set({ status: "playing" }); this._emit("play") })
        this.widget.bind(E.PAUSE, () => {
            if (this.state.status === "ended") return
            this._set({ status: "paused" }); this._emit("pause")
        })
        this.widget.bind(E.FINISH, () => { this._set({ status: "ended" }); this._emit("ended") })
        this.widget.bind(E.PLAY_PROGRESS, (d) => {
            // Виджет живёт в миллисекундах — наружу отдаём секунды
            const pos = (d.currentPosition || 0) / 1000
            this._set({ position: pos })
            this._emit("time", { position: pos, duration: this.state.duration })
        })
        this.widget.bind(E.ERROR, () => {
            const err = {
                code: "sc-error",
                message: "Этот трек нельзя проиграть встроенным плеером"
            }
            this._set({ status: "error", error: err })
            this._emit("error", err)
        })
    }

    async load(track) {
        this._set({ status: "loading", position: 0, duration: 0, error: null })
        await this._ensure()

        const url = track.scUrl || track.url
        if (!url) throw new Error("нет ссылки на трек")

        await new Promise((res) => {
            this.widget.load(url, {
                auto_play: false,
                show_artwork: false,
                callback: res
            })
        })

        // Метаданные берём у самого виджета: это postMessage внутри
        // страницы, без единого сетевого запроса с нашего origin.
        // Поэтому oEmbed не нужен вовсе.
        const sound = await new Promise((res) => this.widget.getCurrentSound(res))
        if (sound) {
            const d = (sound.duration || 0) / 1000
            this._set({ duration: d, status: "ready" })
            this._meta = {
                title: sound.title || track.title,
                artist: (sound.user && sound.user.username) || track.artist,
                artwork: sound.artwork_url || null,
                durationS: d
            }
            this._emit("ready", { duration: d, meta: this._meta })
        } else {
            // Виджет молча не открыл трек — обычно это запрет встраивания
            // у автора, геоблок или Go+.
            const err = {
                code: "sc-not-embeddable",
                message: "Автор запретил встраивание этого трека"
            }
            this._set({ status: "error", error: err })
            this._emit("error", err)
            throw Object.assign(new Error(err.message), { code: err.code })
        }

        this.widget.setVolume(this._vol * 100)
    }

    async play() {
        if (!this.widget) throw new Error("виджет не готов")
        this.widget.play()

        /* Виджет не возвращает ничего и молчит, если браузер запретил
           автозапуск. Поэтому ждём собственного события PLAY; не пришло
           за полторы секунды — считаем, что не поехало. Иначе интерфейс
           вечно показывает «играет» при полной тишине. */
        const ok = await this._await("play", PLAY_TIMEOUT)
        if (!ok) {
            const err = { code: "autoplay-blocked", message: "Нажми ещё раз — браузер ждёт нажатия" }
            this._emit("error", err)
            throw Object.assign(new Error(err.message), { code: err.code })
        }
    }

    pause() { this.widget && this.widget.pause() }

    seek(sec) {
        if (!this.widget) return
        this.widget.seekTo(Math.max(0, sec) * 1000)   // виджету — миллисекунды
        this._set({ position: sec })
    }

    setVolume(v) {
        this._vol = Math.max(0, Math.min(1, v))
        this.widget && this.widget.setVolume(this._vol * 100)   // виджету — 0..100
    }

    setMuted(m) {
        this.widget && this.widget.setVolume(m ? 0 : this._vol * 100)
    }

    async unload() {
        if (this.widget) this.widget.pause()
        this._set({ status: "idle", position: 0, duration: 0 })
    }

    /** Метаданные, вытянутые при загрузке: движок-владелец дописывает их
     *  в трек, чтобы в списке появились название и исполнитель. */
    get meta() { return this._meta || null }
}
