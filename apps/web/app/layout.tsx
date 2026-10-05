import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eumon — Organic growth, connected to your code",
  description: "Understand your website, find valuable organic opportunities, and turn evidence into a site-specific growth plan.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
