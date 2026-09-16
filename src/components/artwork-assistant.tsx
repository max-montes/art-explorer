"use client";
import { CSSProperties, FormEvent, useState } from "react";
import { displayLabel, type MediaAsset, type ScriptAnalysis, type ScriptPassage } from "@/lib/catalog/types";
import { setMediaDragData } from "@/lib/media/drag-export";
import { mediaPreviewUrl } from "@/lib/media/preview-url";
import styles from "./artwork-assistant.module.css";

const SAMPLE_SCRIPT = "A quiet room after a long day. The light is fading, but there is still a sense that something might begin again.";
async function analyze(text: string): Promise<ScriptAnalysis> {
  const response = await fetch("/api/assistant/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const payload: ScriptAnalysis | { error: string } = await response.json();
  if (!response.ok || "error" in payload) throw new Error("error" in payload ? payload.error : "Script analysis failed.");
  return payload;
}
function MediaTile({ asset }: { asset: MediaAsset }) {
  const mediaUrl = asset.source.mediaUrl;
  return <article className={styles.mediaTile} draggable={Boolean(mediaUrl)} onDragStart={(event) => setMediaDragData(event, asset)}>
    <div className={styles.mediaVisual} style={{ backgroundColor: asset.dominantColor ?? "#343630" }}>
      {mediaUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaPreviewUrl(mediaUrl)} alt={`${asset.title} by ${asset.creator}`} decoding="async" />
      ) : <div>Artwork preview unavailable</div>}
      {mediaUrl && <span className={styles.dragCue}>Drag to collect</span>}
    </div>
    <div className={styles.mediaCaption}><strong>{asset.title}</strong><span>{asset.creator}</span></div>
  </article>;
}
function PassageSuggestions({ passage, offset }: { passage: ScriptPassage; offset: number }) {
  return <div className={styles.passageSuggestions} style={{ "--passage-offset": `${offset}px` } as CSSProperties}>
    <blockquote>{passage.text}</blockquote>
    <div className={styles.labels}><div><small>Associations</small>{passage.associations.map((label) => <span key={label}>{displayLabel(label)}</span>)}</div></div>
    <div className={styles.mediaGrid}>{passage.results.map(({ asset }) => <MediaTile key={asset.id} asset={asset} />)}</div>
  </div>;
}
export function ArtworkAssistant() {
  const [text, setText] = useState(SAMPLE_SCRIPT);
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
  const [activeId, setActiveId] = useState("");
  const [activeOffset, setActiveOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(null); try { const result = await analyze(text); setAnalysis(result); setActiveId(result.passages[0]?.id ?? ""); } catch (e) { setError(e instanceof Error ? e.message : "Script analysis failed."); } finally { setLoading(false); } };
  const active = analysis?.passages.find((p) => p.id === activeId) ?? analysis?.passages[0];
  return <main className={styles.shell}>
    <section className={styles.hero}><p>Artwork idea explorer</p><h1>Find the visual rhythm inside your words.</h1></section>
    <form className={styles.composer} onSubmit={submit}><label htmlFor="script">Writing or idea list</label><textarea id="script" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste writing, a scene outline, or a set of concepts..." rows={7} /><div><span>{text.length.toLocaleString()} / 12,000 characters</span><button type="submit" disabled={loading || !text.trim()}>{loading ? "Mapping ideas..." : "Explore ideas"}</button></div></form>
    {error && <div className={styles.error}>{error}</div>}
    {!analysis && !loading && !error && <section className={styles.empty}><span>01</span><h2>Your writing becomes a path through related artwork.</h2><p>Explore each passage to inspect its associations and related artwork.</p></section>}
    {loading && <section className={styles.loading}><div /><div /><div /></section>}
    {analysis && !loading && analysis.passages.length > 0 && <section className={styles.workspace}><div className={styles.scriptPanel}><div className={styles.panelHeading}><span>Annotated writing</span><small>{analysis.passages.length} passages</small></div><div className={styles.annotatedText}>{analysis.passages.map((passage) => <button type="button" key={passage.id} className={passage.id === activeId ? styles.activePassage : ""} onPointerEnter={(e) => { setActiveId(passage.id); setActiveOffset(e.currentTarget.offsetTop); }} onFocus={() => setActiveId(passage.id)}>{passage.text}</button>)}</div></div><aside className={styles.mediaPanel}><div className={styles.panelHeading}><span>Related artwork</span><small>Hover text · drag artwork</small></div>{active && <PassageSuggestions passage={active} offset={activeOffset} />}</aside></section>}
  </main>;
}
