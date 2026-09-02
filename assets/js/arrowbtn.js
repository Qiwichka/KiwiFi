/*
 * arrowbtn.js — кнопка с разъезжающимся кружком.
 *
 * Перенос эффекта ArrowRevealButton (Originkit). Оригинал написан на
 * motion/react, то есть на React, которого у нас нет. Но вся суть там —
 * геометрия и два трансформа, так что React не нужен вовсе.
 *
 * Как это работает:
 *   в покое      — белая таблетка, слева кружок со стрелкой;
 *   при наведении— кружок разрастается ровно настолько, чтобы накрыть
 *                  самый дальний угол кнопки, стрелка едет в центр и
 *                  доворачивается, текст уходит под кружок.
 *
 * Ключевой расчёт — во сколько раз растить кружок. Это НЕ круглое число:
 * нужно накрыть дальний угол от того места, где кружок стоит, иначе на
 * широкой кнопке в противоположном углу остаётся белый серп. Отсюда
 * гипотенуза до дальнего угла и запас в 2%.
 *
 * Размеры считаются из настоящей вёрстки, а не из констант: кнопка
 * растягивается под длину надписи, и на другом языке или размере шрифта
 * зашитые числа развалились бы. Пересчёт висит на ResizeObserver.
 */

const EASE = "cubic-bezier(.44,0,.56,1)"
const DUR = 460          // мс, как в оригинале
const HOVER_ANGLE = 45   // доворот стрелки при наведении
const TEXT_SHIFT = 8     // на сколько уезжает надпись

export function initArrowButtons(root = document) {
    for (const btn of root.querySelectorAll(".abtn")) setup(btn)
}

function setup(btn) {
    const badge = btn.querySelector(".abtn__badge")
    const icon = btn.querySelector(".abtn__icon")
    const label = btn.querySelector(".abtn__label")
    const slot = btn.querySelector(".abtn__slot")
    if (!badge || !icon || !label || !slot) return

    let hoverScale = 1
    let hoverX = 0
    let hovered = false

    const measure = () => {
        const w = btn.offsetWidth
        const h = btn.offsetHeight
        if (!w || !h) return

        // Место кружка берём у пустой распорки в потоке. Сам кружок лежит
        // абсолютно (он должен уметь разрастаться поверх всего), а абсолютный
        // элемент не занимает места — без распорки кнопка не знала бы, какой
        // ширины ей быть.
        const size = slot.offsetWidth
        const r = size / 2
        const cx = slot.offsetLeft + size / 2
        const cy = slot.offsetTop + slot.offsetHeight / 2

        const far = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
        hoverScale = size > 0 ? (2 * far * 1.02) / size : 1
        hoverX = w / 2 - cx

        for (const el of [badge, icon]) {
            el.style.left = cx + "px"
            el.style.top = cy + "px"
        }
        badge.style.width = badge.style.height = size + "px"
        badge.style.marginLeft = badge.style.marginTop = -r + "px"

        if (!hovered) paint(false)
    }

    const paint = (on) => {
        badge.style.transform = `translate(0,0) scale(${on ? hoverScale : 1})`
        icon.style.transform =
            `translate(${on ? hoverX : 0}px, 0) rotate(${on ? HOVER_ANGLE : 0}deg)`
        label.style.transform = `translateX(${on ? TEXT_SHIFT : 0}px)`
    }

    btn.style.setProperty("--abtn-dur", DUR + "ms")
    btn.style.setProperty("--abtn-ease", EASE)

    btn.addEventListener("pointerenter", () => { hovered = true; paint(true) })
    btn.addEventListener("pointerleave", () => { hovered = false; paint(false); press(1) })
    btn.addEventListener("pointerdown", () => press(0.97))
    btn.addEventListener("pointerup", () => press(1))

    // Клавиатура: без этого кнопка, до которой дошли табом, выглядит мёртвой
    btn.addEventListener("focus", () => { hovered = true; paint(true) })
    btn.addEventListener("blur", () => { hovered = false; paint(false) })

    const press = (s) => { btn.style.transform = `scale(${s})` }

    measure()
    // Кнопка растягивается под надпись, а надпись может доехать позже
    // вместе со шрифтом — поэтому пересчёт, а не разовый замер.
    new ResizeObserver(measure).observe(btn)
    if (document.fonts) document.fonts.ready.then(measure).catch(() => {})
}
