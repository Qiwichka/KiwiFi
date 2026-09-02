/*
 * html5.js — движок для всего, что играет обычным <audio>:
 * свои файлы с диска, скачанное в оффлайн, позже — облако.
 *
 * Элемент создаётся ОДИН раз и живёт вечно, меняется только .src.
 * Причина не в экономии: createMediaElementSource можно вызвать на
 * элементе единственный раз за всю его жизнь, и если плодить <audio>
 * на каждый трек, визуализатор с кроссфейдом потом не к чему будет
 * прицепить.
 */

import { Adapter } from "./adapter.js"

export class HtmlAudioAdapter extends Adapter {
    static caps = {
        analyse: true,
        crossfade: true,
        preload: true,
        rate: true,
        volume: true
    }

    constructor() {
        super()
        const a = new Audio()
        a.preload = "metadata"
        this.el = a
        this._url = null

        a.addEventListener("loadedmetadata", () => {
            const d = isFinite(a.duration) ? a.duration : 0
            // Статус трогаем ТОЛЬКО пока не пошёл звук. Это событие часто
            // прилетает уже после play(), и безусловное "ready" затирало бы
            // "playing": элемент играет, а движок считает, что стоит — и
            // кнопка паузы вместе со всем, что смотрит на playing, врёт.
            const keep = a.paused ? "ready" : this.state.status
            this._set({ duration: d, status: keep })
            this._emit("ready", { duration: d })
        })
        a.addEventListener("timeupdate", () => {
            this._set({ position: a.currentTime })
            this._emit("time", { position: a.currentTime, duration: this.state.duration })
        })
        a.addEventListener("play", () => { this._set({ status: "playing" }); this._emit("play") })
        a.addEventListener("pause", () => {
            if (this.state.status === "ended") return
            this._set({ status: "paused" }); this._emit("pause")
        })
        a.addEventListener("ended", () => { this._set({ status: "ended" }); this._emit("ended") })
        a.addEventListener("waiting", () => this._emit("stall"))
        a.addEventListener("error", () => {
            // Пустой src — это не сбой, а состояние «ничего не выбрано»:
            // браузер всё равно шлёт error.
            if (!a.src || a.src === location.href) return
            const code = a.error ? a.error.code : 0
            const msg = code === 4
                ? "Браузер не умеет этот формат"
                : "Не удалось прочитать файл"
            this._set({ status: "error", error: { code, message: msg } })
            this._emit("error", this.state.error)
        })
    }

    async load(track) {
        this._set({ status: "loading", position: 0, duration: 0, error: null })
        this._revoke()

        /* crossOrigin ставится ПОТРЕКОВО и обязательно ДО .src.
         *
         * Он нужен только чтобы потом АНАЛИЗИРОВАТЬ звук — визуализатор и
         * кроссфейд через Web Audio. Само воспроизведение чужого файла
         * его не требует: медиа-элементу можно играть cross-origin без
         * всякого CORS, как картинке.
         *
         * И ставить его всем подряд нельзя. Поток Audius уезжает
         * редиректом на узел сети, а редирект CORS-заголовков не несёт —
         * с этим атрибутом браузер отказывается открывать файл с ошибкой
         * «формат не поддерживается», хотя формат обычный mp3. Проверено:
         * без атрибута тот же трек грузится, с ним — код 4.
         *
         * Поэтому флаг несёт сам трек: у своих файлов и облака CORS есть,
         * у Audius нет. Цена — визуализатор для Audius пока не заведётся.
         */
        if (track.cors) this.el.crossOrigin = "anonymous"
        else this.el.removeAttribute("crossorigin")

        if (track.file) {
            this._url = URL.createObjectURL(track.file)
            this.el.src = this._url
        } else if (track.url) {
            this.el.src = track.url
        } else {
            throw new Error("нечего играть")
        }
        this.el.load()
    }

    async play() {
        try {
            await this.el.play()
        } catch (e) {
            const name = e && e.name
            // Прерывание сменой src при быстром переключении треков —
            // норма, а не поломка. Ругаться на неё нельзя, иначе двойное
            // нажатие «следующий» выдаёт ошибку на ровном месте.
            if (name === "AbortError") return
            const err = name === "NotAllowedError"
                ? { code: "autoplay-blocked", message: "Браузер ждёт нажатия" }
                : { code: "play-failed", message: "Не удалось запустить" }
            this._set({ status: "error", error: err })
            this._emit("error", err)
            throw Object.assign(new Error(err.message), { code: err.code })
        }
    }

    pause() { this.el.pause() }

    seek(sec) {
        if (!this.state.duration) return
        this.el.currentTime = Math.max(0, Math.min(sec, this.state.duration))
        this._set({ position: this.el.currentTime })
    }

    setVolume(v) { this.el.volume = Math.max(0, Math.min(1, v)) }

    setMuted(m) { this.el.muted = !!m }

    async unload() {
        this.el.pause()
        this.el.removeAttribute("src")
        this.el.load()
        this._revoke()
        this._set({ status: "idle", position: 0, duration: 0 })
    }

    /* Забытые objectURL — это то, как плеер незаметно начинает держать
       в памяти всю фонотеку. Отзыв обязателен при каждой смене. */
    _revoke() {
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null }
    }
}
