"use client";

import { useState, useEffect } from "react";

import { useLanguage } from "@/contexts/LanguageContext";
import { useSession } from "next-auth/react";
import { BookOpen } from "lucide-react";

export function UserWelcome() {
    const { t, language } = useLanguage();
    const { data: session } = useSession();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Server always renders 'User' (no session). Client matches this initially.
    // After mount, we show the real name.
    const userName = mounted && session?.user ? (session.user.name || session.user.email) : 'User';

    return (
        <div className="flex min-w-0 items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-700">
            <div className="handbook-brand-mark">
                <BookOpen className="h-5 w-5" />
            </div>
            <div className="min-w-0">
                <span className="handbook-brand-name">错题本</span>
                <span className="handbook-brand-sub">WRONG NOTEBOOK</span>
                <span className="sr-only">
                    {t.common.welcome || 'Welcome back, '}
                    {userName}
                </span>
            </div>
        </div>
    );
}
