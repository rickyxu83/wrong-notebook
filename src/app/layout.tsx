import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: '#f97316',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "AI智能错题本",
  description: "基于AI的智能错题管理系统，帮助学生高效整理、分析和复习错题",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: '智能错题本',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: '/icons/icon.png',
    apple: '/icons/icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        suppressHydrationWarning={true}
      >
        {/* E-ink 模式：首屏渲染前应用，避免闪烁（与 src/lib/use-eink.ts 保持一致） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var p=new URLSearchParams(location.search).get('eink');if(p==='1'||p==='0'){localStorage.setItem('eink-mode',p)}if(localStorage.getItem('eink-mode')==='1'){document.documentElement.classList.add('eink')}}catch(e){}`,
          }}
        />
        {/*
          opencv：必须是经典同步标签（React 会提升到 head 保持顺序执行）。
          血泪教训：这个构建的 window.cv 是 Emscripten thenable，一旦被原生 Promise 收养
          （resolve(cv)/async return cv/dynamic import）就触发内部死循环 100% CPU 假死，
          所以：① 绝不动态注入/async/defer；② 就绪后 res(true) 布尔值，cv 存 window.__cvModule。
          就绪回调必须在解析期同步挂好，迟挂不触发。
        */}
        <script src="/vendor/opencv.js" async={false} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__cvModule=null;window.__cvReady=new Promise(function(res){var cv=window.cv;var done=function(){window.__cvModule=cv;res(true);};if(cv&&cv.Mat){done();}else if(cv){cv.onRuntimeInitialized=done;}else{res(false);}});`,
          }}
        />
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
