"use client";

import { useEffect } from "react";

/**
 * Full-resolution viewer. Loads the original only on demand, so the grid can
 * stay on thumbnails without hiding the real file from the curator.
 */
export function Lightbox({
  src,
  alt,
  caption,
  onClose,
  onPrevious,
  onNext,
}: {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const navigable = Boolean(onPrevious || onNext);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft") onPrevious?.();
      else if (event.key === "ArrowRight") onNext?.();
    };
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, onNext, onPrevious]);

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <button
        type="button"
        className="lightbox-close"
        aria-label="Close full-size view"
        onClick={onClose}
      >
        ×
      </button>
      {navigable && (
        <>
          <button
            type="button"
            className="lightbox-nav lightbox-previous"
            aria-label="View previous artwork"
            title="Previous artwork"
            disabled={!onPrevious}
            onClick={(event) => {
              event.stopPropagation();
              onPrevious?.();
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 4-8 8 8 8" />
            </svg>
          </button>
          <button
            type="button"
            className="lightbox-nav lightbox-next"
            aria-label="View next artwork"
            title="Next artwork"
            disabled={!onNext}
            onClick={(event) => {
              event.stopPropagation();
              onNext?.();
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m9 4 8 8-8 8" />
            </svg>
          </button>
        </>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        decoding="async"
        onClick={(event) => event.stopPropagation()}
      />
      {caption && (
        <div className="lightbox-caption" onClick={(event) => event.stopPropagation()}>
          <span>{caption}</span>
          <a href={src} target="_blank" rel="noreferrer">
            Open original
          </a>
        </div>
      )}
    </div>
  );
}

export function FullscreenButton({
  onClick,
  className = "",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`fullscreen-button ${className}`.trim()}
      aria-label="View full size"
      title="View full size"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onClick();
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M1.5 6V1.5H6M10 1.5h4.5V6M14.5 10v4.5H10M6 14.5H1.5V10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
