/*
 * app.js — оболочка приложения и плеер.
 *
 * Экраны: Главная, Поиск, Библиотека, Плейлисты, сам плейлист, Очередь.
 * Всё в одной странице, содержимое собирается кодом в #view — разметка у
 * экранов разная и меняется часто, держать пять готовых кусков в HTML
 * значит обречь их на рассинхрон.
 *
 * Данные пока живут в памяти: ни IndexedDB, ни облака. Это фаза 1 — после
 * перезагрузки список пуст, и так задумано. Хранилище придёт в фазе 3.
 *
 * Три решения соблюдаются уже сейчас, потому что переделывать их потом
 * дороже, чем заложить сразу:
 *
 *   1. Элемент <audio> создаётся ОДИН раз и живёт вечно, меняется только
 *      .src. Причина в фазе 2: createMediaElementSource можно вызвать на
 *      элементе единственный раз за всю его жизнь, и если плодить <audio>
 *      на каждый трек, визуализатор с кроссфейдом потом не к чему будет
 *      прицепить.
 *
 *   2. Полоса прогресса не привязана к timeupdate — событие приходит рвано,
 *      около четырёх раз в секунду, и полоса дёргается. Вместо этого свой
 *      цикл досчитывает время между событиями. В фазе 4 то же самое
 *      понадобится для SoundCloud, который шлёт события ещё реже.
 *
 *   3. Очередь — это отдельный список, а не «весь список треков». Играть
 *      можно из библиотеки, из плейлиста, из результатов поиска, и очередь
 *      обязана помнить, откуда её набрали.
 */

import { Background, SCENES } from "./bg.js"
import { Engine } from "./player/engine.js"
import * as audius from "./sources/audius.js"
import { Viz } from "./viz.js"

kiwiStep("модуль запущен")

/* ── Мелочи ───────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id)

/* Сборка узлов. Текст всегда идёт через textContent, поэтому название
   трека с угловыми скобками — это просто название, а не разметка. */
function el(tag, attrs, ...kids) {
    const n = document.createElement(tag)
    for (const k in attrs || {}) {
        const v = attrs[k]
        if (v == null || v === false) continue
        if (k === "class") n.className = v
        else if (k === "text") n.textContent = v
        else if (k === "html") n.innerHTML = v          // только свои шаблоны
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v)
        else if (k === "dataset") Object.assign(n.dataset, v)
        else n.setAttribute(k, v === true ? "" : v)
    }
    for (const c of kids.flat()) {
        if (c == null || c === false) continue
        n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
    }
    return n
}

const svg = (d, extra) => el("span", { class: "ico" + (extra ? " " + extra : ""), html: d })

function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return m + ":" + (s < 10 ? "0" : "") + s
}

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100
    if (m10 === 1 && m100 !== 11) return one
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
    return many
}

const nTracks = (n) => n + " " + plural(n, "трек", "трека", "треков")

function toast(text, isErr = false) {
    const t = el("div", { class: "toast" + (isErr ? " toast--err" : ""), text })
    $("toasts").appendChild(t)
    setTimeout(() => t.remove(), isErr ? 5200 : 2800)
}

/* Имя файла вместо тегов. Разбор ID3 отложен до фазы 6 намеренно:
   метаданные не должны задерживать момент, когда пойдёт звук. */
function fromFilename(name) {
    const base = name.replace(/\.[^.]+$/, "")
    const m = base.match(/^\s*(.+?)\s+[-–—]\s+(.+?)\s*$/)
    if (m) return { artist: m[1], title: m[2] }
    return { artist: "Неизвестный исполнитель", title: base }
}

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)$/i

/* ── Значки ───────────────────────────────────────────────────────── */

const I = {
    note:   '<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
    play:   '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/></svg>',
    shuf:   '<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6M4 4l5 5"/></svg>',
    plus:   '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    disk:   '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
    cloud:  '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 000-8 6 6 0 00-11.6 1.5A3.5 3.5 0 006.5 18"/></svg>',
    sc:     '<svg viewBox="0 0 24 24"><path d="M3 16v-4M6 17v-6M9 18V9M12 18V7M15 18h4a3 3 0 000-6 5 5 0 00-7-4"/></svg>',
    trash:  '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    list:   '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>',
    wave:   '<svg viewBox="0 0 24 24"><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h1"/></svg>',
    dl:     '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>'
}

const SRC_ICON = { local: I.disk, cloud: I.cloud, soundcloud: I.sc, audius: I.wave }
const SRC_NAME = { local: "С диска", cloud: "Из облака", soundcloud: "SoundCloud", audius: "Audius" }

/* ── Состояние ────────────────────────────────────────────────────── */

const state = {
    tracks: [],        // вся библиотека
    playlists: [],     // { id, title, scene, keys: [ключи треков] }

    view: "home",
    arg: null,
    query: "",
    hist: [],          // для стрелок назад-вперёд
    fwd: []
}

/* Всё воспроизведение — через движок. Он держит очередь и сам выбирает,
   каким адаптером играть трек: свои файлы обычным <audio>, SoundCloud
   через виджет. Интерфейс про адаптеры не знает вовсе. */
const engine = new Engine()

/* Ссылку на поток Audius выдаёт узел сети, и получать её надо
   непосредственно перед воспроизведением: узел может смениться. */
engine.resolve = async (t) => {
    if (t.source === "audius") await audius.attachUrl(t)
}

let bg = null

const byKey = (k) => state.tracks.find((t) => t.key === k)
const curTrack = () => engine.track
const plTracks = (p) => p.keys.map(byKey).filter(Boolean)

/* ══ Экраны ═══════════════════════════════════════════════════════ */

function go(view, arg = null, push = true) {
    if (push && (state.view !== view || state.arg !== arg)) {
        state.hist.push({ view: state.view, arg: state.arg })
        state.fwd.length = 0
    }
    state.view = view
    state.arg = arg
    render()
}

function back() {
    const h = state.hist.pop()
    if (!h) return
    state.fwd.push({ view: state.view, arg: state.arg })
    state.view = h.view; state.arg = h.arg
    render()
}

function forward() {
    const f = state.fwd.pop()
    if (!f) return
    state.hist.push({ view: state.view, arg: state.arg })
    state.view = f.view; state.arg = f.arg
    render()
}

function render() {
    const v = $("view")
    v.innerHTML = ""
    v.scrollTop = 0

    $("searchbox").hidden = state.view !== "search"
    $("btn-back").disabled = !state.hist.length
    $("btn-fwd").disabled = !state.fwd.length

    for (const b of document.querySelectorAll("[data-go]")) {
        b.classList.toggle("is-active", b.dataset.go === state.view)
    }
    renderSidePlaylists()

    const draw = {
        home: viewHome, search: viewSearch, library: viewLibrary,
        playlists: viewPlaylists, playlist: viewPlaylist, queue: viewQueue
    }[state.view] || viewHome

    v.appendChild(draw())

    if (state.view === "search") requestAnimationFrame(() => $("q").focus())

    // Фон плейлиста. На остальных экранах — набор по умолчанию.
    const pl = state.view === "playlist" ? state.playlists.find((p) => p.id === state.arg) : null
    bg && bg.setScene(pl ? pl.scene : "meadow")
}

/* ── Общие куски ─────────────────────────────────────────────────── */

function hero({ kind, title, meta, art, scene, onTitle }) {
    const cover = el("div", { class: "hero__art", html: I.note })
    if (art) cover.classList.add("hero__art--" + art)
    const h1 = el("h1", { class: "hero__title", text: title })
    if (onTitle) {
        h1.contentEditable = "true"
        h1.spellcheck = false
        h1.title = "Нажми, чтобы переименовать"
        h1.addEventListener("blur", () => onTitle(h1.textContent.trim() || title))
        h1.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); h1.blur() }
        })
    }
    return el("header", { class: "hero" }, cover,
        el("div", { class: "hero__body" },
            el("div", { class: "hero__kind", text: kind }),
            h1,
            el("div", { class: "hero__meta", text: meta }),
            scene || null))
}

function toolbar(tracks, from) {
    if (!tracks.length) return el("div")
    return el("div", { class: "toolbar" },
        el("button", { class: "btn btn--play", onclick: () => playList(tracks, 0, from) },
            svg(I.play), "Слушать"),
        el("button", { class: "btn btn--ghost", onclick: () => {
            engine.setShuffle(true)
            $("btn-shuffle").classList.add("is-on")
            playList(tracks, 0, from)
        } }, svg(I.shuf), "Вперемешку"))
}

function emptyBox(title, text, btnText) {
    return el("div", { class: "empty", id: "empty" },
        el("span", { class: "empty__icon", html: I.note }),
        el("p", { class: "empty__title", text: title }),
        el("p", { class: "empty__text", text }),
        btnText ? el("button", { class: "btn btn--play", onclick: pickFiles }, svg(I.plus), btnText) : null)
}

/* Одна строка трека. Контекст нужен, чтобы клик запускал именно тот
   список, в котором строка показана: из плейлиста — плейлист, из поиска —
   найденное, а не всю библиотеку скопом. */
function trackRow(t, i, list, from) {
    const cur = curTrack()
    return el("div", {
        class: "row" + (cur && cur.key === t.key ? " is-current" : ""),
        dataset: { key: t.key },
        onclick: (e) => { if (!e.target.closest("[data-stop]")) playList(list, i, from) }
    },
        el("div", { class: "row__num", text: String(i + 1) }),
        el("div", { class: "row__main" },
            el("div", { class: "row__art", html: I.note }),
            el("div", { class: "row__text" },
                el("div", { class: "row__title", text: t.title }),
                el("div", { class: "row__artist", text: t.artist }))),
        el("div", { class: "row__album", text: t.album || "—" }),
        el("div", { class: "row__end" },
            t.source === "audius" ? el("button", {
                class: "iconbtn iconbtn--row", title: "Скачать", "data-stop": true,
                onclick: (e) => { e.stopPropagation(); downloadTrack(t) }
            }, svg(I.dl)) : null,
            el("button", {
                class: "iconbtn iconbtn--row", title: "В плейлист", "data-stop": true,
                onclick: (e) => { e.stopPropagation(); menuAddTo(e.currentTarget, t) }
            }, svg(I.plus)),
            el("span", { class: "src", title: SRC_NAME[t.source] || "", html: SRC_ICON[t.source] || I.disk }),
            el("span", { class: "row__time", text: t.durationS ? fmt(t.durationS) : "—" })))
}

function trackTable(list, from) {
    if (!list.length) return emptyBox("Пусто", "Здесь пока нет треков", null)
    return el("section", { class: "tracks" },
        el("div", { class: "tracks__head" },
            el("span", { style: "text-align:right", text: "#" }),
            el("span", { text: "Название" }),
            el("span", { text: "Альбом" }),
            el("span", { style: "text-align:right", text: "Время" })),
        el("div", { id: "rows" }, list.map((t, i) => trackRow(t, i, list, from))))
}

function plCard(p) {
    const list = plTracks(p)
    return el("button", { class: "card", onclick: () => go("playlist", p.id) },
        el("div", { class: "card__art card__art--" + p.scene }, el("span", { html: I.note })),
        el("div", { class: "card__title", text: p.title }),
        el("div", { class: "card__meta", text: nTracks(list.length) }))
}

/* ── Экран: Главная ──────────────────────────────────────────────── */

function viewHome() {
    const hour = new Date().getHours()
    const hi = hour < 5 ? "Доброй ночи" : hour < 12 ? "Доброе утро" : hour < 18 ? "Добрый день" : "Добрый вечер"
    const recent = state.tracks.slice(-6).reverse()

    const box = el("div", { class: "page" }, el("h1", { class: "page__title", text: hi }))

    // Плитки быстрого доступа — как верхний ряд у Спотифая
    const tiles = el("div", { class: "tiles" },
        el("button", { class: "tile", onclick: () => go("library") },
            el("span", { class: "tile__art tile__art--meadow", html: I.note }),
            el("span", { class: "tile__t", text: "Все треки" })),
        ...state.playlists.slice(0, 5).map((p) =>
            el("button", { class: "tile", onclick: () => go("playlist", p.id) },
                el("span", { class: "tile__art tile__art--" + p.scene, html: I.list }),
                el("span", { class: "tile__t", text: p.title }))))
    box.appendChild(tiles)

    if (!state.tracks.length) {
        box.appendChild(emptyBox("Пока тихо",
            "Перетащи сюда музыку или нажми «Добавить файлы»", "Выбрать файлы"))
        return box
    }

    box.appendChild(el("div", { class: "sec" },
        el("h2", { class: "sec__t", text: "Недавно добавленные" }),
        el("button", { class: "sec__more", text: "Вся библиотека", onclick: () => go("library") })))
    box.appendChild(trackTable(recent, "Недавно добавленные"))

    if (state.playlists.length) {
        box.appendChild(el("div", { class: "sec" },
            el("h2", { class: "sec__t", text: "Плейлисты" }),
            el("button", { class: "sec__more", text: "Все", onclick: () => go("playlists") })))
        box.appendChild(el("div", { class: "cards" }, state.playlists.map(plCard)))
    }
    return box
}

/* ── Экран: Поиск ────────────────────────────────────────────────── */

function viewSearch() {
    const raw = state.query.trim()
    const q = raw.toLowerCase()
    const box = el("div", { class: "page" })

    if (!raw) {
        box.appendChild(el("h1", { class: "page__title", text: "Поиск" }))
        box.appendChild(el("p", { class: "page__sub",
            text: "Ищет в твоей библиотеке и на Audius — там открытый каталог, играет и скачивается прямо отсюда." }))

        box.appendChild(el("h2", { class: "sec__t sec__t--solo", text: "Сейчас слушают на Audius" }))
        const slot = el("div")
        box.appendChild(slot)
        fillOnline(slot, () => audius.trending(18), "Audius")

        box.appendChild(scBox())
        return box
    }

    const hit = state.tracks.filter((t) =>
        (t.title + " " + t.artist + " " + (t.album || "")).toLowerCase().includes(q))

    box.appendChild(el("h1", { class: "page__title", text: "Поиск: " + raw }))

    if (hit.length) {
        box.appendChild(el("h2", { class: "sec__t sec__t--solo", text: "В библиотеке — " + nTracks(hit.length) }))
        box.appendChild(trackTable(hit, "Поиск: " + raw))
    }

    box.appendChild(el("h2", { class: "sec__t sec__t--solo", text: "На Audius" }))
    const slot = el("div")
    box.appendChild(slot)
    fillOnline(slot, () => audius.search(raw, 25), "Audius: " + raw)

    box.appendChild(scBox())
    return box
}

/* Онлайн-раздел заполняется асинхронно: сеть может думать секунду, а
   держать из-за неё весь экран пустым незачем. Пока ждём — строка о
   загрузке, упало — понятная причина, а не тишина. */
async function fillOnline(slot, fetcher, from) {
    slot.appendChild(el("div", { class: "loading", text: "Ищу…" }))
    try {
        const list = await fetcher()
        slot.innerHTML = ""
        if (!list.length) {
            slot.appendChild(el("p", { class: "page__sub", text: "Ничего не нашлось" }))
            return
        }
        slot.appendChild(toolbar(list, from))
        slot.appendChild(trackTable(list, from))
    } catch (e) {
        slot.innerHTML = ""
        slot.appendChild(el("div", { class: "note" },
            el("span", { class: "note__ico", html: I.wave }),
            el("div", null,
                el("div", { class: "note__t", text: "Audius не отвечает" }),
                el("div", { class: "note__d", text: e.message || "Проверь подключение к интернету" }))))
    }
}

/* Скачивание. Поток отдаётся с открытым CORS, поэтому файл забирается
   прямо в браузере: ни прокси, ни расширений. Сохранение — обычная
   ссылка с download, как если бы пользователь щёлкнул по файлу сам. */
async function downloadTrack(t) {
    toast("Качаю: " + t.title)
    try {
        const { blob, filename } = await audius.download(t)
        const url = URL.createObjectURL(blob)
        const a = el("a", { href: url, download: filename })
        document.body.appendChild(a)
        a.click()
        a.remove()
        // Отзыв не сразу: браузеру нужен ещё миг, чтобы начать сохранение
        setTimeout(() => URL.revokeObjectURL(url), 20000)
        toast("Готово: " + filename)
        kiwiStep("скачан трек audius")
    } catch (e) {
        toast("Не удалось скачать: " + (e.message || "ошибка"), true)
    }
}

/* Вставка ссылки на SoundCloud.
 *
 * Это ЕДИНСТВЕННЫЙ способ добавить трек оттуда, который работает на
 * обычном сайте: поиск требует запросов к их внутреннему API, а браузер
 * их не пустит — режет CORS. Поиск появится, когда будет запущена
 * локальная служба (фаза 8) или в APK, где нативные запросы идут мимо
 * браузерных ограничений.
 *
 * Само проигрывание при этом полноценное: играет официальный виджет в
 * спрятанном iframe, а кнопки, полоса и очередь — наши. */
function scBox() {
    const input = el("input", {
        type: "url", class: "sc__input", id: "sc-url",
        placeholder: "https://soundcloud.com/artist/track",
        autocomplete: "off", spellcheck: "false"
    })
    const go = el("button", { class: "btn btn--play", onclick: () => submit() },
        svg(I.plus), "Добавить")

    const submit = () => {
        const url = input.value.trim()
        if (!url) return
        if (!/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(url)) {
            toast("Это не похоже на ссылку SoundCloud", true)
            return
        }
        input.value = ""
        addSoundCloud(url)
    }
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit() })

    return el("div", { class: "sc" },
        el("div", { class: "sc__head" },
            el("span", { class: "sc__ico", html: I.sc }),
            el("div", null,
                el("div", { class: "note__t", text: "Трек или плейлист с SoundCloud" }),
                el("div", { class: "note__d",
                    text: "Вставь ссылку — трек встанет в общую очередь вместе со своими. Играет официальный виджет, кнопки и перемотка наши." }))),
        el("div", { class: "sc__row" }, input, go),
        el("div", { class: "note__d sc__hint",
            text: "Поиска по SoundCloud здесь нет: браузер не пускает запросы к их API. Он появится вместе с локальной службой и в приложении для Android." }))
}

function addSoundCloud(url) {
    if (state.tracks.some((t) => t.scUrl === url)) {
        toast("Такой трек уже добавлен")
        return
    }
    const t = {
        key: "sc:" + crypto.randomUUID(),
        source: "soundcloud",
        scUrl: url,
        // Настоящие название и автор придут от виджета после загрузки —
        // до этого показываем заглушку, иначе строка будет пустой.
        title: "Трек SoundCloud",
        artist: "Загружается…",
        album: "", durationS: 0, artwork: null
    }
    state.tracks.push(t)
    kiwiStep("добавлен трек SoundCloud")
    render()
    playList([t], 0, "SoundCloud")
}

/* ── Экран: Библиотека ───────────────────────────────────────────── */

function viewLibrary() {
    const box = el("div", { class: "page page--flush" })
    box.appendChild(hero({
        kind: "Библиотека", title: "Все треки",
        meta: state.tracks.length ? nTracks(state.tracks.length) : "пока пусто"
    }))
    if (!state.tracks.length) {
        box.appendChild(emptyBox("Пока тихо",
            "Перетащи сюда музыку или нажми «Добавить файлы»", "Выбрать файлы"))
        return box
    }
    box.appendChild(toolbar(state.tracks, "Библиотека"))
    box.appendChild(trackTable(state.tracks, "Библиотека"))
    return box
}

/* ── Экран: Плейлисты ────────────────────────────────────────────── */

function viewPlaylists() {
    const box = el("div", { class: "page" },
        el("div", { class: "sec sec--top" },
            el("h1", { class: "page__title", text: "Плейлисты" }),
            el("button", { class: "btn btn--sm", onclick: newPlaylist }, svg(I.plus), "Создать")))

    if (!state.playlists.length) {
        box.appendChild(el("div", { class: "empty" },
            el("span", { class: "empty__icon", html: I.list }),
            el("p", { class: "empty__title", text: "Плейлистов пока нет" }),
            el("p", { class: "empty__text", text: "Создай первый — у каждого будет свой живой фон" }),
            el("button", { class: "btn btn--play", onclick: newPlaylist }, svg(I.plus), "Создать плейлист")))
        return box
    }
    box.appendChild(el("div", { class: "cards" }, state.playlists.map(plCard)))
    return box
}

/* ── Экран: один плейлист ────────────────────────────────────────── */

function viewPlaylist() {
    const p = state.playlists.find((x) => x.id === state.arg)
    if (!p) return el("div", { class: "page" }, el("h1", { class: "page__title", text: "Плейлист не найден" }))

    const list = plTracks(p)

    /* Выбор фона прямо в шапке плейлиста. Ради этого вся возня со сценами
       и затевалась: у каждого плейлиста своя картинка, а не одна на всех. */
    const picker = el("div", { class: "scenes" },
        ...Object.keys(SCENES).map((name) =>
            el("button", {
                class: "scene scene--" + name + (p.scene === name ? " is-on" : ""),
                title: { meadow: "Луг", sunset: "Закат", night: "Ночь", deep: "Глубина" }[name],
                onclick: () => {
                    p.scene = name
                    bg && bg.setScene(name)
                    render()
                }
            })))

    const box = el("div", { class: "page page--flush" })
    box.appendChild(hero({
        kind: "Плейлист", title: p.title, art: p.scene,
        meta: list.length ? nTracks(list.length) : "пока пусто",
        scene: picker,
        onTitle: (v) => { p.title = v; renderSidePlaylists() }
    }))

    const bar = el("div", { class: "toolbar" })
    if (list.length) {
        bar.appendChild(el("button", { class: "btn btn--play", onclick: () => playList(list, 0, p.title) },
            svg(I.play), "Слушать"))
        bar.appendChild(el("button", { class: "btn btn--ghost", onclick: () => {
            engine.setShuffle(true)
            $("btn-shuffle").classList.add("is-on")
            playList(list, 0, p.title)
        } }, svg(I.shuf), "Вперемешку"))
    }
    bar.appendChild(el("button", { class: "btn btn--ghost", onclick: () => go("library") },
        svg(I.plus), "Добавить треки"))
    bar.appendChild(el("button", {
        class: "btn btn--ghost btn--danger",
        onclick: () => {
            state.playlists = state.playlists.filter((x) => x.id !== p.id)
            toast("Плейлист удалён")
            go("playlists")
        }
    }, svg(I.trash), "Удалить"))
    box.appendChild(bar)

    box.appendChild(list.length
        ? trackTable(list, p.title)
        : emptyBox("Плейлист пуст",
            "Открой библиотеку и добавь треки кнопкой «+» в строке", null))
    return box
}

/* ── Экран: Очередь ──────────────────────────────────────────────── */

function viewQueue() {
    const box = el("div", { class: "page" })
    box.appendChild(el("h1", { class: "page__title", text: "Очередь" }))

    if (!engine.queue.length) {
        box.appendChild(el("p", { class: "page__sub", text: "Очередь пуста — включи что-нибудь" }))
        return box
    }
    box.appendChild(el("p", { class: "page__sub", text: "Играет из: " + engine.from }))

    const now = engine.queue.slice(engine.pos, engine.pos + 1)
    const rest = engine.queue.slice(engine.pos + 1)

    if (now.length) {
        box.appendChild(el("h2", { class: "sec__t sec__t--solo", text: "Сейчас играет" }))
        box.appendChild(trackTable(now, engine.from))
    }
    box.appendChild(el("h2", { class: "sec__t sec__t--solo",
        text: rest.length ? "Далее — " + nTracks(rest.length) : "Дальше ничего" }))
    if (rest.length) {
        // Нумерация в этой таблице своя, с единицы, а играть надо ту же
        // позицию очереди — отсюда смещение.
        const off = engine.pos + 1
        const rows = rest.map((t, i) => queueRow(t, i, () => playAt(off + i)))
        box.appendChild(el("section", { class: "tracks" }, el("div", { id: "rows" }, rows)))
    }
    return box
}

/* Строка очереди. Отличается от строки библиотеки тем, что не умеет
   добавлять в плейлист и не открывает список — только перескакивает. */
function queueRow(t, i, onclick) {
    return el("div", { class: "row", dataset: { key: t.key }, onclick },
        el("div", { class: "row__num", text: String(i + 1) }),
        el("div", { class: "row__main" },
            el("div", { class: "row__art", html: I.note }),
            el("div", { class: "row__text" },
                el("div", { class: "row__title", text: t.title }),
                el("div", { class: "row__artist", text: t.artist }))),
        el("div", { class: "row__album", text: t.album || "—" }),
        el("div", { class: "row__end" },
            el("span", { class: "src", html: SRC_ICON[t.source] || I.disk }),
            el("span", { class: "row__time", text: t.durationS ? fmt(t.durationS) : "—" })))
}

/* ── Боковая колонка ─────────────────────────────────────────────── */

function renderSidePlaylists() {
    const box = $("side-playlists")
    box.innerHTML = ""
    box.appendChild(el("button", {
        class: "navlink" + (state.view === "library" ? " is-active" : ""),
        onclick: () => go("library")
    }, svg(I.note), "Все треки"))

    for (const p of state.playlists) {
        box.appendChild(el("button", {
            class: "navlink" + (state.view === "playlist" && state.arg === p.id ? " is-active" : ""),
            onclick: () => go("playlist", p.id)
        }, svg(I.list), p.title))
    }
}

function newPlaylist() {
    const n = state.playlists.length + 1
    const p = {
        id: "pl" + crypto.randomUUID().slice(0, 8),
        title: "Мой плейлист " + n,
        scene: Object.keys(SCENES)[(n - 1) % 4],
        keys: []
    }
    state.playlists.push(p)
    toast("Плейлист создан — название можно менять прямо в заголовке")
    go("playlist", p.id)
}

/* Меню «в какой плейлист». Появляется у нажатой кнопки и закрывается от
   любого следующего клика — отдельного крестика такой мелочи не нужно. */
function menuAddTo(anchor, track) {
    document.querySelector(".menu")?.remove()
    if (!state.playlists.length) {
        toast("Сначала создай плейлист", true)
        return
    }
    const r = anchor.getBoundingClientRect()
    const m = el("div", { class: "menu" },
        el("div", { class: "menu__label", text: "Добавить в плейлист" }),
        ...state.playlists.map((p) =>
            el("button", {
                class: "menu__item",
                onclick: () => {
                    if (p.keys.includes(track.key)) { toast("Уже в «" + p.title + "»"); return }
                    p.keys.push(track.key)
                    toast("Добавлено в «" + p.title + "»")
                    if (state.view === "playlist" && state.arg === p.id) render()
                    m.remove()
                }
            }, svg(I.list), p.title)))
    document.body.appendChild(m)
    // Прижимаем к кнопке, но не даём вылезти за нижний край экрана
    const h = m.offsetHeight
    m.style.left = Math.max(8, Math.min(r.left - 180, innerWidth - m.offsetWidth - 8)) + "px"
    m.style.top = (r.bottom + h > innerHeight ? r.top - h - 6 : r.bottom + 6) + "px"
    setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0)
}

/* ══ Плеер ════════════════════════════════════════════════════════ */

function paintCurrent() {
    const cur = curTrack()
    for (const row of document.querySelectorAll(".row")) {
        row.classList.toggle("is-current", !!cur && row.dataset.key === cur.key)
    }
}

function paintDurations() {
    for (const row of document.querySelectorAll(".row")) {
        const t = byKey(row.dataset.key)
        if (!t) continue
        const cell = row.querySelector(".row__time")
        const want = t.durationS ? fmt(t.durationS) : "—"
        if (cell && cell.textContent !== want) cell.textContent = want
    }
}

/* Тонкие обёртки над движком: очередь, порядок и переключение адаптеров
   он держит сам, интерфейсу остаётся только попросить. */

const playList = (list, i = 0, from = "Библиотека") => engine.playList(list, i, from)
const playAt = (i) => engine.playAt(i)

function toggle() {
    if (!engine.queue.length) {
        if (state.tracks.length) playList(state.tracks, 0, "Библиотека")
        else pickFiles()
        return
    }
    engine.toggle()
}

function setMediaSession(t) {
    if (!("mediaSession" in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: t.album || "KiwiFi",
        artwork: t.artwork ? [{ src: t.artwork }] : []
    })
    const h = {
        play: () => engine.toggle(), pause: () => engine.toggle(),
        previoustrack: () => engine.prev(), nexttrack: () => engine.next(false)
    }
    for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]) } catch (e) {} }
}

/* ── Добавление файлов ───────────────────────────────────────────── */

function pickFiles() { $("file-input").click() }

function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => AUDIO_RE.test(f.name) || f.type.startsWith("audio/"))
    const skipped = fileList.length - files.length
    if (!files.length) {
        toast(skipped ? "Это не аудиофайлы" : "Файлы не выбраны", true)
        return
    }

    for (const file of files) {
        const meta = fromFilename(file.name)
        state.tracks.push({
            key: "loc:" + crypto.randomUUID(),
            file, title: meta.title, artist: meta.artist,
            album: "", durationS: 0, source: "local"
        })
    }

    // Если открыт плейлист, положим новое сразу в него — иначе после
    // «добавить треки» из плейлиста файлы уезжали бы неизвестно куда.
    if (state.view === "playlist") {
        const p = state.playlists.find((x) => x.id === state.arg)
        if (p) for (const t of state.tracks.slice(-files.length)) p.keys.push(t.key)
    }

    render()
    readDurations()
    toast("Добавлено: " + files.length + (skipped ? " (пропущено " + skipped + ")" : ""))
    kiwiStep("добавлено файлов: " + files.length)
}

/* Длительность читается отдельным элементом, а не основным: если занять
   основной, оборвётся то, что сейчас играет. Файлы обрабатываются по
   очереди — сотня параллельных декодеров кладёт слабую машину. */
function readDurations() {
    const probe = new Audio()
    probe.preload = "metadata"
    const queue = state.tracks.filter((t) => !t.durationS)
    let i = 0
    const step = () => {
        if (i >= queue.length) { paintDurations(); return }
        const t = queue[i++]
        const url = URL.createObjectURL(t.file)
        const done = (ok) => {
            if (ok) t.durationS = probe.duration
            URL.revokeObjectURL(url)
            probe.onloadedmetadata = probe.onerror = null
            if (i % 12 === 0) paintDurations()
            step()
        }
        probe.onloadedmetadata = () => done(true)
        probe.onerror = () => done(false)
        probe.src = url
    }
    step()
}

/* ── Полосы: перемотка и громкость ───────────────────────────────── */

/* Общий обработчик для обеих полос. На pointer-событиях, поэтому
   одинаково работает мышью и пальцем и держит захват, когда курсор
   уходит за пределы полосы. */
function makeBar(elm, fill, knob, onChange, getValue) {
    let grabbing = false
    const ratio = (e) => {
        const r = elm.getBoundingClientRect()
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    }
    const paint = (v) => {
        fill.style.width = v * 100 + "%"
        knob.style.left = v * 100 + "%"
    }
    elm.addEventListener("pointerdown", (e) => {
        grabbing = true
        elm.classList.add("is-grabbing")
        elm.setPointerCapture(e.pointerId)
        const v = ratio(e); paint(v); onChange(v)
    })
    elm.addEventListener("pointermove", (e) => {
        if (!grabbing) return
        const v = ratio(e); paint(v); onChange(v)
    })
    elm.addEventListener("pointerup", (e) => {
        if (!grabbing) return
        grabbing = false
        elm.classList.remove("is-grabbing")
        const v = ratio(e); paint(v); onChange(v)
    })
    elm.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 0.1 : 0.02
        let v = getValue()
        if (e.key === "ArrowRight") v += step
        else if (e.key === "ArrowLeft") v -= step
        else return
        e.preventDefault()
        v = Math.min(1, Math.max(0, v))
        paint(v); onChange(v)
    })
    return { paint, isGrabbing: () => grabbing }
}

const seekBar = makeBar($("seek"), $("seek-fill"), $("seek-knob"),
    (v) => { const d = engine.state.duration; if (d) engine.seek(v * d) },
    () => { const d = engine.state.duration; return d ? engine.state.position / d : 0 })

const volBar = makeBar($("vol"), $("vol-fill"), $("vol-knob"),
    (v) => { engine.setVolume(v); paintMute() },
    () => engine.volume)

volBar.paint(engine.volume)
function paintMute() { $("btn-mute").classList.toggle("is-on", engine.muted) }

/* ── Плавная полоса прогресса ────────────────────────────────────── */

/* События времени приходят рвано — около четырёх раз в секунду у <audio>
   и ещё реже у SoundCloud. Если вешать полосу прямо на них, она заметно
   дёргается. Поэтому свой цикл досчитывает время между событиями и
   защёлкивается на каждом настоящем. Одна реализация на оба движка. */
let lastTime = 0, lastAt = 0

engine.addEventListener("time", (e) => {
    lastTime = e.detail.position
    lastAt = performance.now()
})

engine.addEventListener("ready", (e) => {
    $("t-dur").textContent = fmt(e.detail.duration)
    lastTime = 0
    lastAt = performance.now()
})

function tick() {
    requestAnimationFrame(tick)
    const d = engine.state.duration
    if (!d || !isFinite(d)) return
    let cur = lastTime
    if (engine.playing) cur += (performance.now() - lastAt) / 1000
    cur = Math.min(cur, d)
    $("t-cur").textContent = fmt(cur)
    if (!seekBar.isGrabbing()) seekBar.paint(cur / d)
}
requestAnimationFrame(tick)

/* ── События движка ──────────────────────────────────────────────── */

engine.addEventListener("play", () => {
    $("icon-play").hidden = true
    $("icon-pause").hidden = false
    $("btn-play").title = "Пауза"
    bg && bg.setPlaying(true)
})

engine.addEventListener("pause", () => {
    $("icon-play").hidden = false
    $("icon-pause").hidden = true
    $("btn-play").title = "Играть"
    bg && bg.setPlaying(false)
})

engine.addEventListener("track", (e) => {
    const t = e.detail.track
    $("np-title").textContent = t.title
    $("np-artist").textContent = t.artist
    document.title = t.artist + " — " + t.title + " · KiwiFi"
    paintCurrent()
    setMediaSession(t)
    if (state.view === "queue") render()
})

/* SoundCloud отдаёт настоящие название и автора только после загрузки —
   до этого в списке стоит заглушка, поэтому перерисовываем. */
engine.addEventListener("meta", (e) => {
    const t = e.detail.track
    $("np-title").textContent = t.title
    $("np-artist").textContent = t.artist
    document.title = t.artist + " — " + t.title + " · KiwiFi"
    setMediaSession(t)
    render()
})

engine.addEventListener("error", (e) => {
    const d = e.detail || {}
    // Запрет автозапуска — не поломка: браузер ждёт нажатия.
    toast(d.message || "Не удалось воспроизвести", true)
    kiwiStep("ошибка движка: " + d.code)
})

/* ── Кнопки ──────────────────────────────────────────────────────── */

$("file-input").addEventListener("change", (e) => {
    addFiles(e.target.files)
    e.target.value = ""     // иначе выбор тех же файлов второй раз не сработает
})

for (const b of document.querySelectorAll("[data-add]")) b.addEventListener("click", pickFiles)
for (const b of document.querySelectorAll("[data-go]")) {
    b.addEventListener("click", () => go(b.dataset.go))
}

$("btn-back").addEventListener("click", back)
$("btn-fwd").addEventListener("click", forward)
$("btn-new-playlist").addEventListener("click", newPlaylist)

$("btn-play").addEventListener("click", toggle)
$("btn-next").addEventListener("click", () => engine.next(false))
$("btn-prev").addEventListener("click", () => engine.prev())

$("btn-shuffle").addEventListener("click", () => {
    engine.setShuffle(!engine.shuffle)
    $("btn-shuffle").classList.toggle("is-on", engine.shuffle)
    toast(engine.shuffle ? "Вперемешку" : "По порядку")
})

$("btn-repeat").addEventListener("click", () => {
    const mode = engine.cycleRepeat()
    const b = $("btn-repeat")
    b.classList.toggle("is-on", mode !== "off")
    b.title = { off: "Повтор выключен", all: "Повторять список", one: "Повторять трек" }[mode]
    toast(b.title)
})

$("btn-mute").addEventListener("click", () => {
    engine.setMuted(!engine.muted)
    volBar.paint(engine.muted ? 0 : engine.volume)
    paintMute()
})

$("np-art").addEventListener("click", () => {
    if (engine.track) toast("Полноэкранный режим будет в фазе 6")
})

const q = $("q")
/* Задержка перед запросом. Без неё каждая набранная буква улетала бы в
   сеть, и ответы возвращались бы вперемешку: на «lo» позже, чем на
   «lofi», затирая более свежий результат. */
let qTimer = 0
q.addEventListener("input", () => {
    $("q-clear").hidden = !q.value
    clearTimeout(qTimer)
    qTimer = setTimeout(() => {
        state.query = q.value
        const box = $("view")
        box.innerHTML = ""
        box.appendChild(viewSearch())
    }, 350)
})
$("q-clear").addEventListener("click", () => {
    q.value = ""; state.query = ""; $("q-clear").hidden = true
    render()
})

/* ── Перетаскивание файлов ───────────────────────────────────────── */

let dragDepth = 0
window.addEventListener("dragover", (e) => e.preventDefault())
window.addEventListener("dragenter", (e) => {
    e.preventDefault()
    // Считаем вход и выход: без счётчика подсветка мигает каждый раз,
    // когда курсор пересекает границу вложенного элемента.
    if (++dragDepth === 1) document.body.classList.add("is-dragging")
})
window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("is-dragging") }
})
window.addEventListener("drop", (e) => {
    e.preventDefault()
    dragDepth = 0
    document.body.classList.remove("is-dragging")
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
})

/* ── Клавиши ─────────────────────────────────────────────────────── */

window.addEventListener("keydown", (e) => {
    if (e.target.matches("input,textarea") || e.target.isContentEditable) return
    if (e.code === "Space") { e.preventDefault(); toggle() }
    else if (e.code === "ArrowRight" && e.ctrlKey) engine.next(false)
    else if (e.code === "ArrowLeft" && e.ctrlKey) engine.prev()
    else if (e.key === "/") { e.preventDefault(); go("search") }
})

/* ── Запуск ──────────────────────────────────────────────────────── */

bg = new Background({
    wrap: $("bg"), sky: $("bg-sky"), grass: $("bg-grass"), reflect: $("bg-reflect")
}, "on")

render()
paintMute()

/* Визуализатор. Спектр берёт у движка сам, а для источников без анализа
   рисует спокойную волну — см. комментарий в viz.js. */
new Viz($("viz"), engine).start()

/* Отладочный доступ. Модуль наружу ничего не отдаёт, а без бандлера и
   sourcemap заглянуть в него из консоли больше нечем: элемент <audio>
   создан кодом и в разметке его нет, так что даже через DOM не найти. */
window.__kiwi = { state, engine, bg, go, playList, playAt }

window.kiwiReady = true
kiwiStep("готово")
