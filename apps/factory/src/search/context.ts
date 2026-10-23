import type { ProjectIntakePayload } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
export const SEARCH_CONTEXT_POLICY = "search-context-v1";
const supportedLanguages = new Set(["en", "ru", "fr", "de", "es", "it", "pt", "nl", "pl", "uk", "tr", "ja", "ko", "zh", "ar", "hi"]);
const countries: Record<string, string> = { ru: "Russia", russia: "Russia", россия: "Russia", us: "United States", usa: "United States", "united states": "United States", gb: "United Kingdom", uk: "United Kingdom", "united kingdom": "United Kingdom", es: "Spain", spain: "Spain", it: "Italy", italy: "Italy", ch: "Switzerland", switzerland: "Switzerland", jp: "Japan", japan: "Japan", fr: "France", france: "France", de: "Germany", germany: "Germany", ca: "Canada", canada: "Canada", au: "Australia", australia: "Australia" };
export interface EffectiveSearchContext {
  policyVersion: typeof SEARCH_CONTEXT_POLICY;
  location: string;
  language: string;
  locationSource: "operator_override" | "accepted_input";
  languageSource: "operator_override" | "accepted_input";
}
/** Deliberately bounded support. Ambiguous market hints never become geography. */
export function resolveSearchContext(payload: Pick<ProjectIntakePayload, "siteIdentity" | "markets">, overrides: { location?: string; language?: string }): EffectiveSearchContext {
  const reject = (message: string): never => { throw new FactoryError("search_context_invalid", message); };
  let language = overrides.language?.trim() || payload.siteIdentity.language.trim();
  try { language = Intl.getCanonicalLocales(language)[0]!.split("-")[0]!.toLowerCase(); }
  catch { reject("Select a supported search language; accepted language is invalid or missing."); }
  if (!supportedLanguages.has(language)) reject(`Search language '${language}' is not supported by the configured targeting policy.`);
  const priorities = [...new Set(payload.markets.priorityLocations.map(s => s.trim()).filter(Boolean))];
  const geographies = [...new Set(payload.markets.geographies.map(s => s.trim()).filter(Boolean))];
  const accepted = priorities.length === 1 ? priorities[0] : priorities.length === 0 && geographies.length === 1 ? geographies[0] : undefined;
  const rawLocation = overrides.location?.trim() || accepted || reject("Select an explicit search location: accepted market is missing or ambiguous.");
  const legacyUsLocation = /^([^,]+),\s*([A-Za-z]{2})$/.exec(rawLocation);
  const states: Record<string, string> = { tx: "Texas", ca: "California", ny: "New York", fl: "Florida", il: "Illinois", wa: "Washington", co: "Colorado", az: "Arizona", ma: "Massachusetts", pa: "Pennsylvania", oh: "Ohio", ga: "Georgia", nc: "North Carolina", mi: "Michigan", va: "Virginia", nj: "New Jersey" };
  const normalizedLocation = legacyUsLocation && states[legacyUsLocation[2]!.toLowerCase()] ? `${legacyUsLocation[1]!.trim()},${states[legacyUsLocation[2]!.toLowerCase()]},United States` : rawLocation;
  const country = countries[normalizedLocation.toLowerCase()];
  // Provider location names require a canonical, country-qualified location.
  // No arbitrary bare city or marketing hypothesis is passed as a precise target.
  const tail = normalizedLocation.split(",").at(-1)!.trim().toLowerCase();
  const location = country ?? (normalizedLocation.includes(",") && countries[tail] ? normalizedLocation : reject("Unsupported location. Select a supported country or a canonical city,region,country location."));
  return { policyVersion: SEARCH_CONTEXT_POLICY, language, location,
    languageSource: overrides.language?.trim() ? "operator_override" : "accepted_input",
    locationSource: overrides.location?.trim() ? "operator_override" : "accepted_input" };
}
