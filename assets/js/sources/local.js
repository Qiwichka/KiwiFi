/*
 * local.js — свои файлы с диска, так чтобы они пережили перезагрузку.
 *
 * Уровней два, и разница между ними принципиальная.
 *
 * УРОВЕНЬ 1 — File System Access API (Chrome и Edge на компьютере).
 * Браузер отдаёт «хэндл» — ссылку на файл или папку на диске. Хэндл
 * кладётся в IndexedDB и работает после перезагрузки: сам файл никуда
 * не копируется, на диске он один. Можно указать папку целиком, и при
 * каждом запуске она пересканируется — новые треки подхватятся сами,
 * как в настоящем плеере.
 *
 * УРОВЕНЬ 2 — обычный <input type="file"> (всё остальное).
 * В Android Chrome showDirectoryPicker отсутствует, в Firefox и Safari
 * File System Access API нет вовсе. Оттуда приходят File-объекты, чьи
 * ссылки умирают при перезагрузке. Поэтому файл приходится КОПИРОВАТЬ
 * в IndexedDB — место занимается второй раз, и об этом надо спрашивать,
 * а не делать молча.
 *
 * Перед копированием обязателен navigator.storage.persist(): без него
 * браузер вправе вычистить IndexedDB при нехватке места. Молча потерять
 * чужую фонотеку — недопустимо.
 */

import * as idb from "../idb.js"

export const hasHandles = typeof window.showOpenFilePicker === "function"
export const hasFolder = typeof window.showDirectoryPicker === "function"

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm)$/i
const isAudio = (name) => AUDIO_RE.test(name)

/* ── Выбор файлов ─────────────────────────────────────────────────── */

/** Выбрать отдельные файлы. Возвращает записи вида { file, handle }. */
export async function pickFiles() {
    if (hasHandles) {
        const handles = await window.showOpenFilePicker({
            multiple: true,
            types: [{
                description: "Музыка",
                accept: { "audio/*": [".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav", ".webm"] }
            }]
        })
        const out = []
        for (const h of handles) out.push({ file: await h.getFile(), handle: h })
        return out
    }
    return null   // выше вызовут обычный <input>
}

/** Выбрать папку целиком. Только там, где есть File System Access API. */
export async function pickFolder() {
    if (!hasFolder) return null
    const dir = await window.showDirectoryPicker({ id: "kiwifi-music" })
    const files = await readFolder(dir)
    return { dir, files }
}

/** Пройти по папке и собрать всё аудио, включая вложенные папки. */
async function readFolder(dir, depth = 0) {
    const out = []
    // Ограничение глубины: на случайно выбранном диске C: обход без
    // предела уходит в бесконечность и вешает вкладку.
    if (depth > 4) return out
    for await (const entry of dir.values()) {
        if (entry.kind === "file" && isAudio(entry.name)) {
            out.push({ file: await entry.getFile(), handle: entry })
        } else if (entry.kind === "directory") {
            out.push(...await readFolder(entry, depth + 1))
        }
    }
    return out
}

/* ── Права доступа ────────────────────────────────────────────────── */

/**
 * Проверить и при необходимости запросить доступ к хэндлу.
 *
 * ВАЖНО: requestPermission обязан вызываться из обработчика клика.
 * Поэтому при запуске мы только СПРАШИВАЕМ состояние, а сам запрос
 * вешаем на кнопку — иначе браузер откажет, а пользователь увидит
 * библиотеку, которая молча не играет.
 */
export async function permission(handle, ask = false) {
    if (!handle || !handle.queryPermission) return "granted"
    const opts = { mode: "read" }
    let st = await handle.queryPermission(opts)
    if (st === "granted") return st
    if (ask) st = await handle.requestPermission(opts)
    return st
}

/* ── Достать файл для воспроизведения ─────────────────────────────── */

/**
 * Вернуть File для трека. Хэндл спрашивается заново каждый раз: файл
 * могли переименовать, удалить или отобрать доступ, и узнать об этом
 * лучше здесь, чем получить тишину.
 */
export async function fileFor(track) {
    if (track.handle) {
        const st = await permission(track.handle)
        if (st !== "granted") {
            const e = new Error("нет доступа к файлу")
            e.code = "no-permission"
            throw e
        }
        return await track.handle.getFile()
    }
    if (track.kind === "local-blob") {
        const blob = await idb.get("blobs", track.key)
        if (!blob) {
            const e = new Error("файл не найден в памяти приложения")
            e.code = "blob-missing"
            throw e
        }
        return blob
    }
    if (track.file) return track.file
    const e = new Error("нечего играть")
    e.code = "no-source"
    throw e
}

/* ── Пересканирование папки ───────────────────────────────────────── */

/**
 * Перечитать сохранённую папку. Вызывается при запуске: добавленные в
 * неё файлы появятся в библиотеке сами, удалённые — исчезнут.
 * Возвращает null, если доступ не выдан — тогда наверху покажут плашку.
 */
export async function rescan(dirHandle) {
    if (!dirHandle) return null
    const st = await permission(dirHandle)
    if (st !== "granted") return null
    try {
        return await readFolder(dirHandle)
    } catch (e) {
        return null
    }
}

/* ── Копирование в память приложения (уровень 2) ──────────────────── */

/** Прикинуть, сколько места займёт копирование. */
export const totalBytes = (files) => files.reduce((s, f) => s + (f.size || 0), 0)

export function fmtBytes(n) {
    if (n < 1024) return n + " Б"
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " КБ"
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " МБ"
    return (n / 1024 / 1024 / 1024).toFixed(2) + " ГБ"
}

/** Скопировать файлы в IndexedDB, чтобы пережили перезагрузку. */
export async function storeBlobs(entries) {
    await idb.persist()
    await idb.bulkPut("blobs", entries.map(([key, file]) => [key, file]))
}
