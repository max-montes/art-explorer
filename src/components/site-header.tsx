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
          <small>Find art by mood and idea</small>
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
          href="/assistant"
          aria-current={pathname === "/assistant" ? "page" : undefined}
        >
          Explore by idea
        </Link>
        <Link
          href="/admin/curation"
          aria-current={pathname.startsWith("/admin/curation") ? "page" : undefined}
        >
          Add artwork
        </Link>
      </nav>
    </header>
  );
}
