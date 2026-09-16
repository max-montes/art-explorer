"use client";

import { type ReactNode, useEffect, useState } from "react";

/**
 * Row-major masonry. CSS columns fill top-to-bottom, which for ranked results
 * puts #2 under #1 at the bottom-left where the eye skips it. Here items are
 * placed in rank order into whichever column is currently shortest, so
 * reading left-to-right along the top always follows the ranking.
 *
 * Column count follows the container width and a minimum column width (the
 * same rule browser zoom obeys). Heights are estimated from each item's
 * aspect ratio plus a fixed caption allowance, so layout is a pure function
 * of the data and never flickers from DOM measurement.
 */
export function Masonry<T>({
  items,
  keyOf,
  aspectRatioOf,
  columns: requestedColumns,
  minColumnWidth,
  onFitsChange,
  gap = 18,
  captionHeight = 96,
  render,
  className,
  ...rest
}: {
  items: T[];
  keyOf: (item: T) => string;
  aspectRatioOf: (item: T) => number;
  /** Desired columns; reduced when they would fall below minColumnWidth. */
  columns: number;
  minColumnWidth: number;
  /** Reports how many columns actually fit, so controls can disable at the limit. */
  onFitsChange?: (fits: number) => void;
  gap?: number;
  /** Estimated vertical space below the image (title, creator, tags). */
  captionHeight?: number;
  render: (item: T) => ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const [width, setWidth] = useState<number | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [node]);

  // The requested count, capped by how many columns of at least
  // minColumnWidth fit. Browser zoom shrinks CSS px, so zooming in lowers the
  // cap and zooming out raises it, as a zoom gesture should.
  const fits = width
    ? Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
    : 1;
  const columnCount = Math.max(1, Math.min(requestedColumns, fits));

  useEffect(() => {
    if (width !== null) onFitsChange?.(fits);
  }, [fits, width, onFitsChange]);
  const columnWidth = width
    ? (width - gap * (columnCount - 1)) / columnCount
    : 0;

  // Greedy shortest-column placement in rank order.
  const columns: T[][] = Array.from({ length: columnCount }, () => []);
  const heights = new Array<number>(columnCount).fill(0);
  for (const item of items) {
    let target = 0;
    for (let i = 1; i < columnCount; i++) {
      if (heights[i] < heights[target] - 0.5) target = i;
    }
    columns[target].push(item);
    const ratio = aspectRatioOf(item) || 1.2;
    heights[target] += columnWidth / ratio + captionHeight + gap;
  }

  return (
    <div
      ref={setNode}
      className={className}
      style={{ display: "flex", gap, alignItems: "flex-start" }}
      {...rest}
    >
      {columns.map((column, index) => (
        <div
          key={index}
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            gap,
            minWidth: 0,
          }}
        >
          {width !== null && column.map((item) => (
            <div key={keyOf(item)}>{render(item)}</div>
          ))}
        </div>
      ))}
    </div>
  );
}
