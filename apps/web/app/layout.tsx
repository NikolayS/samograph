import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "samograph — live transcripts for your calls",
  description:
    "Zero-setup live transcripts for your Zoom and Google Meet calls. Sign in, add a meeting link, watch it stream live, then share read-only or download.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/*
        Issue #70: browser extensions (Grammarly, ColorZilla, password managers)
        stamp attributes onto <body> before React hydrates, which trips the
        "attributes of the server rendered HTML didn't match" warning. This is
        not a SSR↔client divergence in our code (the page is static and clean in
        a fresh headless browser). `suppressHydrationWarning` here is the
        standard, narrow mitigation: it applies to <body> ONLY (one level deep),
        so real mismatches inside the app still surface.
      */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
