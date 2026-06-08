import type { Metadata } from "next";
import { Fraunces, Spline_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Display serif for headlines and the hero net figure — distinctive, editorial,
// and deliberately NOT Inter/Roboto/Arial.
const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
});

// Body / UI sans — humanist, highly legible at small sizes for dense tables.
const splineSans = Spline_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Mono for money — inherently tabular so columns of dollars line up cleanly.
const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Family Finance Tracker",
  description: "Household spending awareness dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${splineSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
