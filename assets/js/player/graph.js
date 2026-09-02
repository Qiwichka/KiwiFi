/*
 * graph.js — звуковой граф для анализа: <audio> → усиление → анализатор →
 * колонки.
 *
 * Нужен ради визуализатора, а позже — кроссфейда и эквалайзера.
 *
 * ТРИ ПРАВИЛА, КОТОРЫЕ НЕЛЬЗЯ НАРУШАТЬ.
 *
 * 1. createMediaElementSource можно вызвать на элементе ОДИН РАЗ за всю
 *    его жизнь. Второй вызов бросает исключение. Поэтому граф собирается
 *    единожды, а дальше живёт вместе с элементом.
 *
 * 2. После подключения ВЕСЬ звук элемента идёт через Web Audio. И если
 *    подсунуть туда чужой файл без CORS, браузер отдаст «отравленный»
 *    узел: воспроизведение будет идти, а из колонок — тишина. Молча.
 *    Поэтому граф собирается только когда играет трек, у которого анализ
 *    разрешён: свой файл с диска или источник с открытым CORS. Проверять
 *    это надо ДО первого подключения — потом уже поздно.
 *
 * 3. AudioContext создаётся лениво, по первому жесту пользователя, и его
 *    надо resume(). Созданный до жеста контекст останется навсегда
 *    в состоянии suspended, и звука не будет вообще.
 */

export class Graph {
    constructor(el) {
        this.el = el
        this.ctx = null
        this.analyser = null
        this.bins = null
        this.failed = false
    }

    /** Собрать граф. Безопасно звать сколько угодно раз. */
    ensure() {
        if (this.ctx || this.failed) return !!this.ctx
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) { this.failed = true; return false }
        try {
            this.ctx = new Ctx()
            this.src = this.ctx.createMediaElementSource(this.el)
            this.gain = this.ctx.createGain()
            this.analyser = this.ctx.createAnalyser()
            // 128 полос: на узкой строке в панели плеера больше не разглядеть,
            // а считать их каждый кадр дешевле.
            this.analyser.fftSize = 256
            // Сглаживание: без него столбики трясутся как припадочные
            this.analyser.smoothingTimeConstant = 0.8
            this.src.connect(this.gain)
            this.gain.connect(this.analyser)
            this.analyser.connect(this.ctx.destination)
            this.bins = new Uint8Array(this.analyser.frequencyBinCount)
            return true
        } catch (e) {
            // Не смогли — не беда: элемент продолжит играть сам по себе,
            // просто без визуализатора.
            console.warn("KiwiFi: звуковой граф не собрался,", e.message)
            this.failed = true
            this.ctx = null
            return false
        }
    }

    resume() {
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {})
    }

    get ready() { return !!this.analyser }

    /** Текущий спектр, 0..255 по полосам. */
    read() {
        if (!this.analyser) return null
        this.analyser.getByteFrequencyData(this.bins)
        return this.bins
    }
}
