import type { Metadata } from "next";
import { ArtworkAssistant } from "@/components/artwork-assistant";

export const metadata: Metadata = {
  title: "Passage Explorer - Art Explorer",
  description: "Find artwork that resonates with passages of poetry and prose.",
};

export default function PassageExplorerPage() { return <ArtworkAssistant />; }
