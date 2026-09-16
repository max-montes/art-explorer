/**
 * Conservative stemmer used only to recognise that a suggested search is a
 * morphological variant of the query ("divine" -> "Divinity", "god" -> "Gods").
 *
 * Only inflectional suffixes are stripped. Derivational suffixes (-ism, -ist,
 * -al, -ous, ...) are deliberately left alone because in this catalog they
 * mark different concepts: Humanism is not Humanity, Realism is not Reality.
 * This is never used to delete curator labels.
 */

const SUFFIXES = ["ities", "ity", "ing", "ies", "ed", "es", "s", "e"];

const MIN_STEM = 3;

export const stemWord = (word: string): string => {
  let current = word.toLowerCase();
  for (const suffix of SUFFIXES) {
    if (
      current.length - suffix.length >= MIN_STEM &&
      current.endsWith(suffix)
    ) {
      current = current.slice(0, -suffix.length);
      break;
    }
  }
  // "divin" from "divine"/"divinity"; "collaps" from "collapse"/"collapsing".
  return current.replace(/([^aeiou])\1$/, "$1");
};

/** Stem every word of a label and join, so phrases compare as wholes. */
export const stemLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(stemWord)
    .join(" ");

export const sameStem = (left: string, right: string) =>
  stemLabel(left) === stemLabel(right);
