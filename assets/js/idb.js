/*
 * idb.js — хранилище на IndexedDB. Своё, без библиотек.
 *
 * Почему не localStorage: туда влезает только текст, а нам надо хранить
 * FileSystemFileHandle — ссылку на файл на диске. Она клонируется
 * структурно, но в JSON не превращается, поэтому localStorage отпадает
 * в принципе, а не по соображениям объёма.
 *
 * Почему не Dexie: ради этих ста строк тянуть зависимость незачем, и
 * бандлера, который бы её собрал, у нас всё равно нет.
 *
 * Хранилища:
 *   tracks     метаданные треков + хэндлы файлов
 *   blobs      сами аудиофайлы там, где хэндлы не работают (см. local.js)
 *   playlists  плейлисты
 *   art        обложки
 */

const NAME = "kiwifi"
const VERSION = 1
const STORES = ["tracks", "blobs", "playlists", "art"]

let dbPromise = null

function open() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            for (const s of STORES) {
                if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
            }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        // База может быть заблокирована другой вкладкой с более старой
        // версией. Молчать нельзя: снаружи это выглядит как зависание.
        req.onblocked = () => reject(new Error("база занята другой вкладкой"))
    })
    return dbPromise
}

function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req ? req.result : undefined)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
    }))
}

export const get = (store, key) => tx(store, "readonly", (s) => s.get(key))
export const put = (store, key, val) => tx(store, "readwrite", (s) => s.put(val, key))
export const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key))
export const clear = (store) => tx(store, "readwrite", (s) => s.clear())
export const keys = (store) => tx(store, "readonly", (s) => s.getAllKeys())
export const all = (store) => tx(store, "readonly", (s) => s.getAll())

/** Записать пачку за одну транзакцию: по одной сотня треков пишется
 *  заметно дольше, и каждая запись это отдельный поход на диск. */
export function bulkPut(store, entries) {
    return tx(store, "readwrite", (s) => {
        for (const [k, v] of entries) s.put(v, k)
    })
}

/**
 * Попросить браузер не выкидывать наши данные.
 *
 * Без этого IndexedDB считается «лучшим усилием»: при нехватке места на
 * диске браузер вправе очистить её молча. Потерять чужую фонотеку так —
 * непростительно, поэтому просим постоянное хранение. Отказ не страшен,
 * просто риск остаётся.
 */
export async function persist() {
    if (!navigator.storage || !navigator.storage.persist) return false
    try {
        if (await navigator.storage.persisted()) return true
        return await navigator.storage.persist()
    } catch (e) { return false }
}

/** Сколько занято и сколько доступно — показываем в настройках. */
export async function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null
    try {
        const e = await navigator.storage.estimate()
        return { used: e.usage || 0, quota: e.quota || 0 }
    } catch (e) { return null }
}
