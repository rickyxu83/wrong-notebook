"use client";

import { useEffect, useState } from "react";

/**
 * E-ink（墨水屏）学生版模式。
 *
 * 开关方式：
 * - URL 参数 `?eink=1` 开启 / `?eink=0` 关闭，并写入 localStorage 持久化
 *   （墨水屏设备上用带参数的书签即可常开）
 * - 无参数时读 localStorage
 *
 * 开启后在 <html> 上加 `eink` class，globals.css 中的黑白高对比样式生效。
 * layout.tsx 中另有内联脚本在首屏渲染前应用，避免闪烁。
 */

const STORAGE_KEY = "eink-mode";
const EINK_CLASS = "eink";
const CHANGE_EVENT = "eink-mode-change";

function applyClass(on: boolean) {
    if (typeof document !== "undefined") {
        document.documentElement.classList.toggle(EINK_CLASS, on);
    }
}

/** 解析 URL 参数 + localStorage，应用并返回当前状态 */
export function initEinkMode(): boolean {
    if (typeof window === "undefined") return false;
    try {
        const p = new URLSearchParams(window.location.search).get("eink");
        if (p === "1" || p === "0") {
            localStorage.setItem(STORAGE_KEY, p);
        }
        const on = localStorage.getItem(STORAGE_KEY) === "1";
        applyClass(on);
        return on;
    } catch {
        return false;
    }
}

/** 主动切换（设置开关等场景） */
export function setEinkMode(on: boolean) {
    try {
        localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
        /* localStorage 不可用时仅本次生效 */
    }
    applyClass(on);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }
}

export function useEinkMode(): boolean {
    const [eink, setEink] = useState(false);

    useEffect(() => {
        const refresh = () => setEink(initEinkMode());
        refresh();
        window.addEventListener(CHANGE_EVENT, refresh);
        window.addEventListener("storage", refresh);
        return () => {
            window.removeEventListener(CHANGE_EVENT, refresh);
            window.removeEventListener("storage", refresh);
        };
    }, []);

    return eink;
}
