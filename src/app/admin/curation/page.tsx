import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CuratorWorkbench } from "@/components/curator-workbench";

export const metadata: Metadata = {
  title: "Add artwork — Art Explorer",
  description: "Review and publish artwork for Art Explorer.",
};

export const dynamic = "force-dynamic";

export default function CurationPage() {
  if (
    process.env.NODE_ENV !== "development" &&
    process.env.ALLOW_REMOTE_CURATION !== "true"
  ) {
    notFound();
  }
  return <CuratorWorkbench />;
}
