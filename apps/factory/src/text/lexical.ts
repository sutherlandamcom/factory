/** Deterministic lexical evidence only; never a semantic/factual truth verdict. */
export function normalizeLexicalText(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function significantTerms(text: string): string[] {
  return [...new Set(normalizeLexicalText(text).split(" ").filter(term => [...term].length >= 4))];
}
