import type { Metadata } from "next";
import { GlobalMediaDrop } from "@/components/global-media-drop";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Art Explorer",
  description:
    "Find art by describing what you're looking for.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <GlobalMediaDrop>
          <SiteHeader />
          {children}
        </GlobalMediaDrop>
      </body>
    </html>
  );
}
