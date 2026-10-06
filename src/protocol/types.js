// @ts-check
// Gedeelde types voor het protocol (PROTOCOL.md). Alleen JSDoc — geen code.

/**
 * @typedef {'waarde'|'schakelaar'|'trigger'|'keuze'} ParamSoort
 * @typedef {{
 *   id: string, naam: string, soort: ParamSoort, standaard: number,
 *   keuzes?: string[], hint?: 'fader'|'knop'|'pad'|'kolom', groep?: string,
 *   rol?: string, slew_s?: number, takeover?: 'pickup'|'direct'|'schaal',
 *   eenheid?: string, min?: number, max?: number, centre?: number,
 * }} Param
 * @typedef {{
 *   v: 1, app: string, naam: string, kleur?: string, truth: 'app'|'hub', hb_s: number,
 *   lease: boolean, rings?: 'host'|'auto', speelt?: ('xboard49'|'maschine-mk2')[], levert?: 'sectie'[], scenes: string[], params: Param[],
 * }} Manifest
 *
 * Berichten app → hub
 * @typedef {{ t: 'hallo', app: string, inst: string, v: 1, token?: string }} Hallo
 * @typedef {{ t: 'manifest', manifest: Manifest }} ManifestBericht
 * @typedef {{ t: 'staat', waarden: Record<string, number> }} Staat
 * @typedef {{ t: 'zet', id: string, v: number }} AppZet
 * @typedef {{ t: 'hb' }} Hartslag
 * @typedef {{ t: 'led', dev?: 'apc40'|'xboard49'|'maschine-mk2', bytes: number[][] }} Led
 * @typedef {{ t: 'scherm', dev: 'maschine-mk2', nr: 0|1, data: Uint8Array }} Scherm  (op de draad: data in base64, 2048 bytes; §17)
 * @typedef {{ t: 'globaal', waarden: { 'sectie.energie'?: number, 'sectie.label'?: string, 'sectie.nieuw'?: true } }} GlobaalVanApp  (§18; alleen met de groep in `levert`)
 * @typedef {Hallo|ManifestBericht|Staat|AppZet|Hartslag|Led|Scherm|GlobaalVanApp} VanApp
 *
 * Berichten hub → app
 * @typedef {{ t: 'welkom', hub: 'varve-hub', v: 1 }} Welkom
 * @typedef {{ t: 'zet', id: string, v: number, bron?: string }} HubZet
 * @typedef {{ t: 'trig', id: string, aan: boolean }} Trig
 * @typedef {{ t: 'scene', i: number }} Scene
 * @typedef {{ t: 'focus', aan: boolean }} Focus
 * @typedef {{ t: 'globaal', waarden: Record<string, number|string> }} Globaal
 * @typedef {{ t: 'midi', dev: 'apc40'|'xboard49'|'maschine-mk2', bytes: number[] }} Midi
 * @typedef {{ t: 'fout', reden: string }} Fout
 * @typedef {Welkom|HubZet|Trig|Scene|Focus|Globaal|Midi|Fout} NaarApp
 *
 * Binnen de hub
 * @typedef {{ app: string|null, stuur: (b: NaarApp) => void, sluit?: () => void }} Verbinding
 * @typedef {{ zet: (id: string, s: import('../devices/apc40mk2.js').LedStaat) => void, teken: () => number }} Oppervlak
 * @typedef {'nieuw'|'actief'|'stil'|'weg'} AppStatus
 */
export {};
