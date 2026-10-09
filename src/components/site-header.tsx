"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Art Explorer home">
        <span className="brand-mark" aria-hidden="true">
          A
        </span>
        <span className="brand-copy">
          <strong>Art Explorer</strong>
          <small>Search for paintings in your own words</small>
        </span>
      </Link>
      <nav className="header-actions">
        <Link
          href="/"
          className="header-note"
          aria-current={pathname === "/" ? "page" : undefined}
        >
          Collection
        </Link>
        <Link
          href="/passages"
          aria-current={pathname === "/passages" ? "page" : undefined}
        >
          Passage Explorer
        </Link>
      </nav>
    </header>
  );
}
