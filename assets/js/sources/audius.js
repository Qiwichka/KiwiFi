/*
 * audius.js — поиск и воспроизведение через Audius.
 *
 * Почему он, а не SoundCloud: SoundCloud недоступен с сети, где живёт
 * приложение — блокируется и сайт, и API. Значит не работает ни виджет,
 * ни прокси, ни нативные запросы в APK, все они ходят на один домен.
 *
 * Audius при этом отдаёт всё, что нужно, и проще:
 *   — ключи не нужны вообще;
 *   — заголовок access-control-allow-origin: * , поэтому браузер ходит
 *     к нему НАПРЯМУЮ и никакой прокси не требуется;
 *   — поток это обычный audio/mpeg с поддержкой Range, то есть играет
 *     штатным <audio> и перематывается;
 *   — раз поток свой и с CORS, к нему потом можно будет прицепить
 *     визуализатор и кроссфейд. С SoundCloud это было невозможно в
 *     принципе: звук там внутри чужого iframe.
 *
 * Честный минус: каталог другой. Это независимая площадка — электроника,
 * хип-хоп, лоуфай. Свежего мейнстрима там нет, и обещать «найдётся любой
 * трек» нельзя.
 */

/* Audius это сеть узлов, а не один сервер. Список живых берётся у
   api.audius.co; если он не ответил, работаем по известному адресу —
   приложение не должно падать из-за недоступности справочника. */
const FALLBACK_HOST = "https://discoveryprovider.audius.co"
const REGISTRY = "https://api.audius.co"
const APP = "KiwiFi"

let host = null
let hostPromise = null

async function getHost() {
    if (host) return host
    if (hostPromise) return hostPromise
    hostPromise = (async () => {
        try {
            const r = await fetch(REGISTRY, { signal: AbortSignal.timeout(4000) })
            const d = await r.json()
            const list = Array.isArray(d.data) ? d.data : []
            host = list.length ? list[Math.floor(Math.random() * list.length)] : FALLBACK_HOST
        } catch (e) {
            host = FALLBACK_HOST
        }
        return host
    })()
    return hostPromise
}

async function api(path, params = {}) {
    const h = await getHost()
    const q = new URLSearchParams({ ...params, app_name: APP })
    const r = await fetch(`${h}/v1${path}?${q}`, { signal: AbortSignal.timeout(12000) })
    if (!r.ok) throw new Error("Audius ответил " + r.status)
    const d = await r.json()
    return d.data
}

/** Приводим ответ Audius к нашей модели трека. */
function toTrack(t) {
    const art = t.artwork || {}
    return {
        key: "aud:" + t.id,
        source: "audius",
        audiusId: t.id,
        // Поток отдаётся по прямой ссылке, поэтому обычный <audio>
        // играет его без всякой обёртки.
        url: null,               // проставляется лениво, см. attachUrl
        title: t.title || "Без названия",
        artist: (t.user && (t.user.name || t.user.handle)) || "Неизвестный исполнитель",
        album: t.genre || "",
        durationS: t.duration || 0,
        artwork: art["480x480"] || art["150x150"] || null,
        permalink: t.permalink ? "https://audius.co" + t.permalink : null,
        // На прямом адресе узла CORS открыт, поэтому элементу можно
        // ставить crossOrigin — а значит позже заведётся визуализатор.
        cors: true,
        playable: !!t.is_streamable && !t.is_stream_gated
    }
}

/**
 * Прямая ссылка на поток.
 *
 * Просить сам /stream нельзя: он отвечает редиректом на узел хранения, а
 * браузер по редиректу в режиме CORS не ходит — получается «format
 * error» на обычном mp3 и полная невозможность скачать файл.
 *
 * no_redirect=true отдаёт конечный адрес строкой в JSON, и вот на НЁМ
 * заголовок access-control-allow-origin: * уже есть. С таким адресом
 * работает и воспроизведение, и скачивание, и (позже) визуализатор.
 *
 * Ссылка подписана и со временем протухает, поэтому спрашивается
 * непосредственно перед воспроизведением, а не заготавливается впрок.
 */
export async function streamUrl(audiusId) {
    const h = await getHost()
    const u = `${h}/v1/tracks/${audiusId}/stream?app_name=${APP}&no_redirect=true`
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) })
    if (!r.ok) throw new Error("Audius не отдал ссылку: " + r.status)
    const d = await r.json()
    if (!d || !d.data) throw new Error("Audius вернул пустую ссылку")
    return d.data
}

/** Дописать ссылку на поток перед воспроизведением. */
export async function attachUrl(track) {
    // Каждый раз заново: подпись в ссылке живёт недолго, и сохранённый
    // адрес через час отдаст ошибку вместо музыки.
    if (track.audiusId) track.url = await streamUrl(track.audiusId)
    return track
}

export async function search(query, limit = 25) {
    const data = await api("/tracks/search", { query, limit })
    // Незапускаемые прячем сразу: показать в списке трек, который не
    // играет, хуже, чем не показать его вовсе.
    return (data || []).map(toTrack).filter((t) => t.playable)
}

export async function trending(limit = 20) {
    const data = await api("/tracks/trending", { limit })
    return (data || []).map(toTrack).filter((t) => t.playable)
}

/**
 * Скачивание. Поток отдаётся с открытым CORS, поэтому файл можно забрать
 * прямо в браузере и сохранить — ни прокси, ни расширений не нужно.
 * onProgress получает долю 0..1, но только если сервер сообщил размер:
 * без Content-Length честного процента не существует, и рисовать
 * выдуманный хуже, чем показать неопределённость.
 */
export async function download(track, onProgress) {
    // Ссылку берём свежую, а не ту, что осталась с воспроизведения:
    // подпись в ней живёт недолго и к моменту скачивания может протухнуть.
    const url = await streamUrl(track.audiusId)
    const r = await fetch(url)
    if (!r.ok) throw new Error("не удалось скачать: " + r.status)

    const total = Number(r.headers.get("content-length")) || 0
    const chunks = []
    let got = 0

    const reader = r.body.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        got += value.length
        if (onProgress) onProgress(total ? got / total : null, got)
    }

    return {
        blob: new Blob(chunks, { type: r.headers.get("content-type") || "audio/mpeg" }),
        filename: safeName(track.artist + " - " + track.title) + ".mp3",
        bytes: got
    }
}

/* Имя файла: у названий треков бывает всё, вплоть до слэшей и двоеточий,
   а Windows такое не принимает. */
function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120)
}
