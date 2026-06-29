import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const title = "gradient — turn your Claude Code habits into commands";
const description =
  "An open-source CLI that reads your own Claude Code history, finds what you repeat, and generates the slash-commands, hooks, and loops to automate it. You review and approve every one.";

export const metadata: Metadata = {
  metadataBase: new URL("https://gradient.md"),
  title,
  description,
  applicationName: "gradient",
  keywords: [
    "Claude Code",
    "CLI",
    "automation",
    "slash commands",
    "developer tools",
    "open source",
  ],
  authors: [{ name: "ylambda" }],
  openGraph: {
    title,
    description,
    url: "https://gradient.md",
    siteName: "gradient",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export const viewport = {
  themeColor: "#0a0b10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} antialiased`}
    >
      <body>{children}</body>
    </html>
  );
}
