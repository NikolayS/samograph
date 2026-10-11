import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Inter } from "next/font/google";
import "./globals.css";

const jetBrainsMono = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/jetbrains-mono-500-latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/jetbrains-mono-700-latin.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-jetbrains",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const themeBootScript = `(function(){try{var t=localStorage.getItem("samograph-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else document.documentElement.removeAttribute("data-theme")}catch(e){}})()`;

export const metadata: Metadata = {
  title: "samograph — live transcripts for your calls",
  description:
    "An agent that joins your Zoom or Google Meet call and transcribes it live.",
  icons: { icon: "/robot-mark.png" },
  openGraph: {
    title: "samograph — live transcripts for your calls",
    description:
      "An agent that joins your Zoom or Google Meet call and transcribes it live.",
    type: "website",
  },
};

/*
 * Mobile audit M6. Next's default viewport tag is
 * `width=device-width, initial-scale=1` with no `viewport-fit`, and iOS reports
 * `env(safe-area-inset-*)` as 0 unless the document opts in with
 * `viewport-fit=cover`. Without this export the `--safe-*` tokens in
 * globals.css are inert and the sticky settings savebar and the jump-to-live
 * pill sit under the home indicator. Width and scale are restated because
 * declaring `viewport` replaces the default entirely.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${jetBrainsMono.variable} ${inter.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      {/*
        Issue #70: browser extensions (Grammarly, ColorZilla, password managers)
        stamp attributes onto <body> before React hydrates, which trips the
        "attributes of the server rendered HTML didn't match" warning. The body
        suppression stays narrow; the html element is also suppressed because
        the no-flash theme script intentionally sets its data-theme before React
        hydrates. Real mismatches inside the app still surface.
      */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
