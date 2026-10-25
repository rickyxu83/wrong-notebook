"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, Camera, ChartNoAxesColumnIncreasing, Clock3, House } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";

/** 手机主导航：中央录题保持拇指易达；桌面、登录页、打印与墨水屏不显示。 */
export function MobileNav() {
    const pathname = usePathname();
    const { language } = useLanguage();
    const zh = language === "zh";

    const [reviewHref, setReviewHref] = useState("/notebooks");
    const isAuthPage = pathname === "/login" || pathname === "/register";

    useEffect(() => {
        if (isAuthPage) return;
        let active = true;
        apiClient.get<{ ids: string[] }>("/api/review/due")
            .then((data) => {
                if (active && data.ids.length > 0) setReviewHref(`/practice?id=${data.ids[0]}`);
            })
            .catch(() => { /* 未登录或暂无复习计划时回退错题本 */ });
        return () => { active = false; };
    }, [isAuthPage, pathname]);

    if (isAuthPage) return null;

    const items = [
        { href: "/", label: zh ? "首页" : "Home", icon: House, active: pathname === "/" },
        { href: "/notebooks", label: zh ? "错题本" : "Notebook", icon: BookOpen, active: pathname.startsWith("/notebooks") || pathname.startsWith("/error-items") },
        { href: "/", label: zh ? "录题" : "Scan", icon: Camera, active: false, primary: true },
        { href: reviewHref, label: zh ? "复习" : "Review", icon: Clock3, active: pathname.startsWith("/practice") || pathname.startsWith("/review") },
        { href: "/stats", label: zh ? "统计" : "Stats", icon: ChartNoAxesColumnIncreasing, active: pathname.startsWith("/stats") },
    ];

    return (
        <nav className="handbook-mobile-nav eink-hide print:hidden" aria-label={zh ? "手机导航" : "Mobile navigation"}>
            {items.map(({ href, label, icon: Icon, active, primary }) => (
                <Link
                    key={label}
                    href={href}
                    className={`handbook-mobile-nav__item${active ? " active" : ""}${primary ? " handbook-mobile-nav__primary" : ""}`}
                    aria-current={active ? "page" : undefined}
                    aria-label={label}
                >
                    <span className="handbook-mobile-nav__icon"><Icon /></span>
                    <span>{label}</span>
                </Link>
            ))}
        </nav>
    );
}
