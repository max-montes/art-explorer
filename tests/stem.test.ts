import { describe, expect, it } from "vitest";
import { sameStem } from "@/lib/retrieval/stem";

describe("query-variant stemming", () => {
  it("recognises inflectional variants of a query", () => {
    expect(sameStem("Divine", "Divinity")).toBe(true);
    expect(sameStem("Collapse", "Collapsing")).toBe(true);
    expect(sameStem("Gods", "God")).toBe(true);
    expect(sameStem("societal decay", "Societal Decay")).toBe(true);
  });

  it("never merges derivational forms that name different concepts", () => {
    expect(sameStem("Humanism", "Humanity")).toBe(false);
    expect(sameStem("Realism", "Reality")).toBe(false);
    expect(sameStem("Art", "Artist")).toBe(false);
    expect(sameStem("Idealism", "Ideal")).toBe(false);
    expect(sameStem("Moral", "Moralism")).toBe(false);
    expect(sameStem("Decay", "Decadence")).toBe(false);
    expect(sameStem("Mentor", "Mentorship")).toBe(false);
  });
});
