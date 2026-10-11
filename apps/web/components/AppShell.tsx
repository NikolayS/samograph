"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { AppApiClient } from "../lib/appApiClient.ts";
import { AccountEmail } from "./AccountEmail.tsx";
import { LogoutButton } from "./LogoutButton.tsx";
import { ThemeSwitcher } from "./ThemeSwitcher.tsx";
import { ShortcutHint } from "./ShortcutHint.tsx";
import { useShortcuts } from "./useShortcuts.tsx";

export interface AppShellProps {
  client?: AppApiClient;
  redirect?: (path: string) => void;
  variant?: "app" | "public";
  pageClassName?: string;
  children: ReactNode;
}

export function AppShell({
  client,
  redirect,
  variant = "app",
  pageClassName,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  useShortcuts({
    navigate: (path) => {
      if (variant !== "app") return;
      if (redirect) redirect(path);
      else window.location.assign(path);
    },
    onHelp: () => { if (variant === "app") setShowShortcuts(true); },
  });

  // The disclosure is a MOBILE affordance only: at >= 768px the panel is
  // `display: contents`, so these links ARE the desktop row and this state is
  // inert. That is also why the collapse is `data-open` + a media query and
  // never the `hidden` attribute — `hidden` would take the visible desktop nav
  // out of the accessibility tree, since React cannot see the viewport.
  // Closing on a route change keeps a panel from surviving a client transition.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    if (variant !== "app" || !client) return;
    let active = true;
    client.getSettings().then(
      (snapshot) => { if (active) setAccountEmail(snapshot.signin.email || null); },
      () => { if (active) setAccountEmail(null); },
    );
    return () => { active = false; };
  }, [client, variant]);

  if (variant === "app" && !client) {
    throw new Error("AppShell requires a client for the app variant");
  }

  return (
    <>
      <a className="samograph-skip-link" href="#main">Skip to content</a>
      <header className="samograph-app-nav">
        <div className="samograph-app-nav-inner">
          <a className="samograph-app-brand" href={variant === "public" ? "/" : "/dashboard"}>samograph</a>
          {/* The public shell has nothing to disclose — no links, no account
              line, no Log out — so it renders no hamburger and no panel: the
              theme control sits inline in the bar (mobile audit M8, from the
              #284 review). A disclosure over one control is not a menu. */}
          {variant === "app" ? (
            <>
              <button
                type="button"
                className="samograph-app-nav-toggle"
                aria-label="Menu"
                aria-expanded={menuOpen}
                aria-controls="app-nav-menu"
                ref={toggleRef}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span className="samograph-app-nav-toggle-bars" aria-hidden="true" />
              </button>
              <div className="samograph-app-nav-menu" id="app-nav-menu" data-open={menuOpen ? "true" : "false"}>
                <nav className="samograph-app-nav-links" aria-label="Primary">
                  <a href="/dashboard" aria-current={pathname === "/dashboard" ? "page" : undefined}>Dashboard</a>
                  <a href="/settings" aria-current={pathname === "/settings" ? "page" : undefined}>Settings</a>
                </nav>
                <div className="samograph-app-nav-right">
                  <AccountEmail email={accountEmail} />
                  <ThemeSwitcher />
                  <LogoutButton client={client!} redirect={redirect ?? (() => {})} />
                </div>
              </div>
            </>
          ) : (
            <div className="samograph-app-nav-right">
              <ThemeSwitcher />
            </div>
          )}
        </div>
      </header>
      <main id="main" className={`samograph-page${pageClassName ? ` ${pageClassName}` : ""}`} tabIndex={-1}>
        {children}
      </main>
      {showShortcuts ? <ShortcutHint onClose={() => setShowShortcuts(false)} /> : null}
    </>
  );
}
