/*
 * serve.js — крошечный сервер для проверки на своей машине.
 *   node tools/serve.js
 * потом открыть http://localhost:5180/
 *
 * Нужен потому, что app.html подключает скрипты как модули, а модули по
 * протоколу file:// браузер запрещает. То есть двойным кликом приложение
 * не открыть — только через http.
 *
 * Взят из Qiwigram и дополнен двумя вещами, без которых плееру плохо:
 *   1. типы аудиофайлов,
 *   2. поддержка Range — см. длинный комментарий у sendRange.
 *
 * Без единой зависимости: ставить пакеты ради сотни строк незачем.
 */

const http = require("http")
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const PORT = 5180

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".mjs":  "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",

    // Аудио. Без правильного типа браузер отказывается играть файл,
    // даже если сам файл в полном порядке.
    ".mp3":  "audio/mpeg",
    ".m4a":  "audio/mp4",
    ".aac":  "audio/aac",
    ".ogg":  "audio/ogg",
    ".opus": "audio/ogg",
    ".oga":  "audio/ogg",
    ".flac": "audio/flac",
    ".wav":  "audio/wav",
    ".webm": "audio/webm"
}

const LOG_FILE = path.join(__dirname, "_client.log")

/*
 * Отдача куска файла по заголовку Range.
 *
 * Зачем: без этого <audio> вынужден скачать весь файл целиком, прежде чем
 * позволит перемотать хоть куда-нибудь. На часовом миксе это секунды
 * ожидания на каждый клик по полосе прогресса, и легко решить, что тормозит
 * плеер, хотя тормозит сервер. Настоящий хостинг Range умеет всегда,
 * так что без этого локальная проверка врала бы.
 */
function sendRange(req, res, file, stat, type) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "")
    if (!m) return false

    const size = stat.size
    let start = m[1] === "" ? null : parseInt(m[1], 10)
    let end   = m[2] === "" ? null : parseInt(m[2], 10)

    // "bytes=-500" — последние 500 байт, а не «от нуля до 500»
    if (start === null) {
        if (end === null) return false
        start = Math.max(0, size - end)
        end = size - 1
    } else if (end === null) {
        end = size - 1
    }

    if (isNaN(start) || isNaN(end) || start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end()
        return true
    }
    end = Math.min(end, size - 1)

    res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store"
    })
    fs.createReadStream(file, { start, end }).pipe(res)
    return true
}

const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0])
    if (rel === "/") rel = "/index.html"   // витрина; плеер живёт в /app.html

    /* Приёмник сообщений со страницы. Нужен для отладки в браузере, который
     * нельзя расспросить напрямую: страница шлёт сюда, что с ней происходит,
     * и это ложится в файл, который можно прочитать когда угодно. */
    if (rel === "/__log") {
        const msg = new URL(req.url, "http://x").searchParams.get("m") || ""
        fs.appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 23) + "  " + msg + "\n")
        res.writeHead(204).end()
        return
    }
    if (rel === "/__log/clear") {
        fs.writeFileSync(LOG_FILE, "")
        res.writeHead(204).end()
        return
    }

    const file = path.join(ROOT, rel)

    // Выход за пределы папки проекта: «/../../Windows/...» не должно
    // отдаваться даже на локальном сервере
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end("nope")
        return
    }

    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
            res.end("не найдено: " + rel)
            return
        }

        const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"

        if (sendRange(req, res, file, stat, type)) return

        res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": stat.size,
            // Заявляем поддержку кусков даже когда отдаём файл целиком:
            // по этому заголовку <audio> понимает, что перемотка возможна.
            "Accept-Ranges": "bytes",
            // при разработке кэш только мешает: правишь файл, а браузер
            // показывает вчерашний
            "Cache-Control": "no-store"
        })
        fs.createReadStream(file).pipe(res)
    })
})

/* Занятый порт — самая частая осечка при запуске, и голый стектрейс на
 * тридцать строк про EADDRINUSE ничего не объясняет. Почти всегда причина
 * одна: сервер уже запущен в другом окне, и открывать надо просто ссылку. */
server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`\n  Порт ${PORT} уже занят.`)
        console.error("  Скорее всего сервер уже запущен в другом окне —")
        console.error(`  тогда просто открой http://localhost:${PORT}/app.html\n`)
        console.error("  Если нужно освободить порт, найди и закрой процесс:")
        console.error(`    netstat -ano | findstr :${PORT}`)
        console.error("    taskkill /PID <номер> /F\n")
        process.exit(1)
    }
    throw err
})

server.listen(PORT, () => {
    console.log(`KiwiFi:  http://localhost:${PORT}/`)
    console.log(`плеер:   http://localhost:${PORT}/app.html`)
    console.log("остановить — Ctrl+C")
})
