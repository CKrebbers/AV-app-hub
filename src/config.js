// @ts-check
// Leest config.json (één bron van waarheid) en het optionele geleerde LPD8-profiel.
import { readFileSync, existsSync } from 'node:fs';
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
