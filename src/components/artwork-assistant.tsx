"use client";
import { CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import { type MediaAsset, type ScriptAnalysis, type ScriptPassage } from "@/lib/catalog/types";
import { setMediaDragData } from "@/lib/media/drag-export";
import { mediaPreviewUrl } from "@/lib/media/preview-url";
import styles from "./artwork-assistant.module.css";

const SAMPLE_SCRIPT = `To see a World in a Grain of Sand
And a Heaven in a Wild Flower,
Hold Infinity in the palm of your hand
And Eternity in an hour.`;
const PASSAGE_SNAPSHOT_KEY = "art-explorer:passages:snapshot";

interface PassageSnapshot {
  text: string;
  analysis: ScriptAnalysis | null;
  activeId: string;
  activeOffset: number;
  scrollY: number;
}

function readPassageSnapshot(): PassageSnapshot | null {
  try {
    const raw = sessionStorage.getItem(PASSAGE_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot: unknown = JSON.parse(raw);
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !("text" in snapshot) ||
      typeof snapshot.text !== "string" ||
      !("activeId" in snapshot) ||
      typeof snapshot.activeId !== "string" ||
      !("activeOffset" in snapshot) ||
      typeof snapshot.activeOffset !== "number" ||
      !("scrollY" in snapshot) ||
      typeof snapshot.scrollY !== "number" ||
      !("analysis" in snapshot)
    ) {
      console.warn("[Passages] Ignoring an invalid saved page snapshot.");
      return null;
    }
    return snapshot as PassageSnapshot;
  } catch (error) {
    console.warn("[Passages] Could not read the saved page snapshot.", error);
    return null;
  }
}

function savePassageSnapshot(snapshot: PassageSnapshot) {
  try {
    sessionStorage.setItem(PASSAGE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("[Passages] Could not save the page snapshot.", error);
  }
}

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
    <div className={styles.mediaGrid}>{passage.results.map(({ asset }) => <MediaTile key={asset.id} asset={asset} />)}</div>
  </div>;
}
export function ArtworkAssistant() {
  const [text, setText] = useState(SAMPLE_SCRIPT);
  const [analysis, setAnalysis] = useState<ScriptAnalysis | null>(null);
  const [activeId, setActiveId] = useState("");
  const [activeOffset, setActiveOffset] = useState(0);
  const [restored, setRestored] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<PassageSnapshot | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const snapshot = readPassageSnapshot();
    if (snapshot) {
      setText(snapshot.text);
      setAnalysis(snapshot.analysis);
      setActiveId(snapshot.activeId);
      setActiveOffset(snapshot.activeOffset);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo(0, snapshot.scrollY));
      });
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored || loading) return;
    const snapshot: PassageSnapshot = {
      text: textRef.current,
      analysis,
      activeId,
      activeOffset,
      scrollY: window.scrollY,
    };
    snapshotRef.current = snapshot;
    savePassageSnapshot(snapshot);
  }, [activeId, activeOffset, analysis, loading, restored]);
  useEffect(
    () => () => {
      const snapshot = snapshotRef.current;
      if (snapshot) {
        savePassageSnapshot({
          ...snapshot,
          text: textRef.current,
          scrollY: window.scrollY,
        });
      }
    },
    [],
  );
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(null); try { const result = await analyze(text); setAnalysis(result); setActiveId(result.passages[0]?.id ?? ""); setActiveOffset(0); } catch (e) { setError(e instanceof Error ? e.message : "Script analysis failed."); } finally { setLoading(false); } };
  const activatePassage = (id: string, button: HTMLButtonElement) => {
    setActiveId(id);
    setActiveOffset(button.offsetTop);
  };
  const active = analysis?.passages.find((p) => p.id === activeId) ?? analysis?.passages[0];
  return <main className={styles.shell}>
    <section className={styles.hero}><p>Passage Explorer</p><h1>Find the visual rhythm inside your words.</h1></section>
    <form className={styles.composer} onSubmit={submit}><label htmlFor="script">Your writing</label><textarea id="script" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste poetry, prose, or a passage of writing..." rows={7} />{text === SAMPLE_SCRIPT && <p>William Blake, <cite>Auguries of Innocence</cite> (opening lines)</p>}<div><span>{text.length.toLocaleString()} / 12,000 characters</span><button type="submit" disabled={loading || !text.trim()}>{loading ? "Finding artwork..." : "Explore passages"}</button></div></form>
    {error && <div className={styles.error}>{error}</div>}
    {!analysis && !loading && !error && <section className={styles.empty}><span>01</span><h2>Your writing becomes a path through related artwork.</h2><p>Explore each passage to inspect its associations and related artwork.</p></section>}
    {loading && <section className={styles.loading}><div /><div /><div /></section>}
    {analysis && !loading && analysis.passages.length > 0 && <section className={styles.workspace}><div className={styles.scriptPanel}><div className={styles.panelHeading}><span>Annotated writing</span><small>{analysis.passages.length} passages</small></div><div className={styles.annotatedText}>{analysis.passages.map((passage) => <button type="button" key={passage.id} className={passage.id === activeId ? styles.activePassage : ""} onPointerEnter={(e) => activatePassage(passage.id, e.currentTarget)} onFocus={(e) => activatePassage(passage.id, e.currentTarget)}>{passage.text}</button>)}</div></div><aside className={styles.mediaPanel}><div className={styles.panelHeading}><span>Related artwork</span><small>Hover text · drag artwork</small></div>{active && <PassageSuggestions passage={active} offset={activeOffset} />}</aside></section>}
  </main>;
}
