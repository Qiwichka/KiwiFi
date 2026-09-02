/*
 * make-www.js — готовит папку www/, из которой Capacitor собирает APK.
 *   node tools/make-www.js
 *
 * Зачем отдельный шаг, а не «взять папку проекта целиком»:
 *
 *   1. app.html внутри приложения обязан называться index.html — Capacitor
 *      открывает именно его.
 *   2. В APK НЕ должно попасть лишнее: tools/, .github/, node_modules/,
 *      android/. Это мегабайты, которые никто внутри телефона не откроет.
 *   3. Отдельно про service worker: внутри APK он приносит только вред —
 *      начинает отдавать закэшированные файлы поверх свежей сборки, и
 *      обновление приложения перестаёт быть заметным. Поэтому sw.js в www
 *      не переносится намеренно (когда он появится в фазе 7).
 *
 * В конце печатает, сколько файлов и мегабайт вышло, и падает, если файлов
 * подозрительно мало: пустой www собирается в APK без единой ошибки, и
 * обнаруживается это уже на телефоне белым экраном.
 */

const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const WWW = path.join(ROOT, "www")

/* Что переносим. Всё, чего здесь нет, в APK не попадёт. */
const FILES = [
    ["app.html", "index.html"]      // из чего → во что
]
const DIRS = ["assets", "icons"]

const MIN_FILES = 5

function rmrf(p) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
}

function copyDir(from, to) {
    if (!fs.existsSync(from)) return
    fs.mkdirSync(to, { recursive: true })
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, e.name)
        const b = path.join(to, e.name)
        if (e.isDirectory()) copyDir(a, b)
        else fs.copyFileSync(a, b)
    }
}

function walk(dir) {
    let out = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) out = out.concat(walk(p))
        else out.push(p)
    }
    return out
}

// Чистим начисто: иначе файл, удалённый из проекта, остался бы жить в APK
rmrf(WWW)
fs.mkdirSync(WWW, { recursive: true })

for (const [src, dst] of FILES) {
    const from = path.join(ROOT, src)
    if (!fs.existsSync(from)) {
        console.error(`нет файла ${src} — собирать нечего`)
        process.exit(1)
    }
    fs.copyFileSync(from, path.join(WWW, dst))
}

for (const d of DIRS) copyDir(path.join(ROOT, d), path.join(WWW, d))

const all = walk(WWW)
const mb = all.reduce((s, f) => s + fs.statSync(f).size, 0) / 1024 / 1024

console.log(`www: ${all.length} файлов, ${mb.toFixed(2)} МБ`)

if (all.length < MIN_FILES) {
    console.error(`Файлов подозрительно мало (меньше ${MIN_FILES}).`)
    console.error("Скорее всего что-то не скопировалось. Пустой www соберётся")
    console.error("в APK молча, а белый экран обнаружится уже на телефоне.")
    process.exit(1)
}
