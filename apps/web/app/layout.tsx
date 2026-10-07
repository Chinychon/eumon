import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eumon — Organic growth, connected to your code",
  description: "Understand your website, find valuable organic opportunities, and turn evidence into a site-specific growth plan.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme before the first paint: the saved choice, or the device's. */}
        <script dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('eumon-theme');document.documentElement.dataset.theme=t==='dark'||t==='light'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){}" }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
