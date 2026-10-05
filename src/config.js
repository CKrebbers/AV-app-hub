// @ts-check
// Leest config.json (één bron van waarheid) en het optionele geleerde LPD8-profiel.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HUB_MAP = join(dirname(fileURLToPath(import.meta.url)), '..');

export function laadConfig(pad = process.env.VARVE_HUB_CONFIG || join(HUB_MAP, 'config.json')) {
  const cfg = JSON.parse(readFileSync(pad, 'utf8'));
  delete cfg._doc;
  return cfg;
}

export const LPD8_PROFIEL_PAD = join(HUB_MAP, 'lpd8-profiel.json');
export function laadLpd8Profiel(pad = LPD8_PROFIEL_PAD) {
  return existsSync(pad) ? JSON.parse(readFileSync(pad, 'utf8')) : null;
}

/** Wat de proef "speelapparaten" van de Xboard49 leerde (welke CC per knop); null als dat er nog niet is. */
export const XBOARD_PROFIEL_PAD = join(HUB_MAP, 'xboard49-profiel.json');
export function laadXboardProfiel(pad = XBOARD_PROFIEL_PAD) {
  return existsSync(pad) ? JSON.parse(readFileSync(pad, 'utf8')) : null;
}

/** Kaarten per app (maps/<app>.json): { <control-id>: { id, takeover? } } — PROTOCOL.md §7. */
export function laadKaarten(map = join(HUB_MAP, 'maps')) {
  if (!existsSync(map)) return {};
  /** @type {Record<string, any>} */
  const uit = {};
  for (const f of readdirSync(map).filter((x) => x.endsWith('.json'))) uit[f.slice(0, -5)] = JSON.parse(readFileSync(join(map, f), 'utf8'));
  return uit;
}
