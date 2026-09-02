/*
 * engine.js — очередь и переключение движков.
 *
 * Единственное, с чем говорит интерфейс. Про адаптеры он не знает вовсе:
 * подписан на события engine и читает его состояние.
 *
 * Оба адаптера живут постоянно, а не создаются на трек. У html5 причина
 * жёсткая (createMediaElementSource — один раз на элемент за всю жизнь),
 * у SoundCloud мягче, но тоже весомая: поднять iframe и дождаться его
 * готовности заметно дольше, чем сменить в нём трек.
 *
 * При смене движка предыдущий ОБЯЗАН остановиться. Иначе получаются два
 * играющих одновременно источника — и это ровно тот баг, который в чужих
 * плеерах вылезает при быстром переключении между своим треком и
 * стримингом.
 */

import { HtmlAudioAdapter } from "./html5.js"
import { SoundCloudAdapter } from "./scwidget.js"
import { Graph } from "./graph.js"

export class Engine extends EventTarget {
    constructor() {
        super()
        this.queue = []
        this.pos = -1
        this.from = "Библиотека"
        this.shuffle = false
        this.repeat = "off"     // off | all | one
        this.volume = 0.8
        this.muted = false

        this.html = new HtmlAudioAdapter()
        /* Анализ звука. Граф собирается не сразу, а при первом же треке,
           который анализировать МОЖНО: свой файл или источник с открытым
           CORS. Собрать его заранее нельзя — после подключения весь звук
           элемента идёт через Web Audio, и чужой файл без CORS замолчал бы
           молча, без единой ошибки. */
        this.graph = new Graph(this.html.el)
        this.sc = null          // поднимаем лениво: без треков SoundCloud
                                // незачем грузить их скрипт вообще
        this.current = this.html

        this._wire(this.html)
    }

    /* ── Наружу ──────────────────────────────────────────────────── */

    get track() { return this.pos >= 0 ? this.queue[this.pos] : null }
    get state() { return this.current.state }
    get caps() { return this.current.caps }
    get playing() { return this.current.state.status === "playing" }

    /** Набрать очередь из списка и начать с позиции i. */
    async playList(list, i = 0, from = "Библиотека") {
        this.queue = list.slice()
        this.from = from
        if (this.shuffle) {
            const first = this.queue[i]
            for (let j = this.queue.length - 1; j > 0; j--) {
                const k = Math.floor(Math.random() * (j + 1))
                ;[this.queue[j], this.queue[k]] = [this.queue[k], this.queue[j]]
            }
            // Трек, по которому щёлкнули, обязан заиграть первым —
            // перемешивание касается того, что идёт ПОСЛЕ него.
            const at = this.queue.indexOf(first)
            if (at > 0) [this.queue[0], this.queue[at]] = [this.queue[at], this.queue[0]]
            i = 0
        }
        await this.playAt(i)
    }

    async playAt(i) {
        if (!this.queue.length) return
        this.pos = ((i % this.queue.length) + this.queue.length) % this.queue.length
        const track = this.queue[this.pos]
        if (!track) return

        const next = this._adapterFor(track)

        // Предыдущий движок глушим ДО загрузки нового, иначе на время
        // загрузки играют оба.
        if (next !== this.current) {
            try { this.current.pause() } catch (e) {}
            try { await this.current.unload() } catch (e) {}
            this.current = next
        }

        this._emit("track", { track, pos: this.pos })

        try {
            /* Некоторым источникам ссылку надо получить перед самой
               загрузкой: у Audius адрес потока выдаёт узел сети, и
               склеивать его заранее нельзя — узел может смениться.
               Кто именно дорешивает трек, движок не знает: это
               подставляет приложение. */
            if (this.resolve) await this.resolve(track)

            /* Граф собирается ДО load, а не после.
             *
             * createMediaElementSource перенаправляет вывод элемента, и
             * если сделать это, когда элемент уже тянет файл, загрузка
             * рвётся — браузер отвечает «формат не поддерживается» на
             * обычном mp3. Проверено: с этим порядком трек играет, с
             * обратным падает.
             *
             * И только на безопасном треке: свой файл или источник с
             * открытым CORS. После подключения весь звук идёт через Web
             * Audio, и чужой файл без CORS замолчал бы молча. */
            if (next === this.html && (track.cors || track.file)) {
                this.graph.ensure()
            }
            this.graph.resume()

            await next.load(track)
            // SoundCloud отдаёт настоящие название и автора только после
            // загрузки — дописываем их в трек, иначе в списке останется
            // «Трек SoundCloud».
            if (next.meta) {
                Object.assign(track, {
                    title: next.meta.title || track.title,
                    artist: next.meta.artist || track.artist,
                    artwork: next.meta.artwork || track.artwork,
                    durationS: next.meta.durationS || track.durationS
                })
                this._emit("meta", { track })
            }
            next.setVolume(this.volume)
            if (next.setMuted) next.setMuted(this.muted)
            await next.play()
        } catch (e) {
            this._emit("error", { code: e.code, message: e.message, track })
        }
    }

    async toggle() {
        if (!this.queue.length) return
        if (this.playing) this.current.pause()
        else {
            try { await this.current.play() } catch (e) {
                this._emit("error", { code: e.code, message: e.message, track: this.track })
            }
        }
    }

    async next(auto = false) {
        if (!this.queue.length) return
        if (auto && this.repeat === "one") { this.seek(0); await this.current.play(); return }
        if (auto && this.pos + 1 >= this.queue.length && this.repeat === "off") {
            this.current.pause()
            this.seek(0)
            return
        }
        await this.playAt(this.pos + 1)
    }

    async prev() {
        // Как у всех: первые три секунды кнопка возвращает к началу трека
        if (this.state.position > 3) { this.seek(0); return }
        await this.playAt(this.pos - 1)
    }

    seek(sec) { this.current.seek(sec) }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v))
        this.muted = false
        this.html.setMuted(false)
        if (this.sc) this.sc.setMuted(false)
        this.current.setVolume(this.volume)
    }

    setMuted(m) {
        this.muted = !!m
        this.html.setMuted(this.muted)
        if (this.sc) this.sc.setMuted(this.muted)
    }

    setShuffle(on) { this.shuffle = !!on }

    cycleRepeat() {
        this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off"
        return this.repeat
    }

    /* ── Внутреннее ──────────────────────────────────────────────── */

    _adapterFor(track) {
        if (track.source === "soundcloud") {
            if (!this.sc) {
                this.sc = new SoundCloudAdapter()
                this._wire(this.sc)
            }
            return this.sc
        }
        return this.html
    }

    /** Пробрасываем события адаптера наружу, но только если он сейчас
     *  главный: остановленный движок иногда договаривает свои события,
     *  и без проверки интерфейс дёргался бы от чужого трека. */
    _wire(ad) {
        for (const type of ["ready", "play", "pause", "time", "ended", "error", "stall"]) {
            ad.addEventListener(type, (e) => {
                if (ad !== this.current) return
                if (type === "ended") { this.next(true); return }
                this._emit(type, e.detail)
            })
        }
    }

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }))
    }
}
