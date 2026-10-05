// @ts-check
// Echte MIDI via @julusian/midi (RtMidi). Pas geladen als het nodig is: zonder ALSA/CoreMIDI
// (zoals in de cloud) of zonder de module start de hub gewoon, dan zonder hardware.
import { kern } from './poort.js';

/** @typedef {import('./poort.js').Poort} Poort @typedef {import('./poort.js').Systeem} Systeem */

/**
 * @returns {Promise<{ systeem: Systeem|null, reden?: string }>}
 */
export async function laadRtMidi() {
  let midi;
  try {
    midi = (await import('@julusian/midi')).default;
  } catch (e) {
    return { systeem: null, reden: `@julusian/midi niet geïnstalleerd (${/** @type {Error} */ (e).message.split('\n')[0]})` };
  }
  let probeIn, probeUit;
  try {
    probeIn = new midi.Input();
    probeUit = new midi.Output();
  } catch (e) {
    return { systeem: null, reden: `MIDI-systeem niet beschikbaar (${/** @type {Error} */ (e).message})` };
  }
  /** @param {any} io */
  const namen = (io) => Array.from({ length: io.getPortCount() }, (_, i) => io.getPortName(i));

  /** @type {Systeem} */
  const systeem = {
    soort: 'rtmidi',
    lijst: () => ({ ingangen: namen(probeIn), uitgangen: namen(probeUit) }),
    open(naam, { alleenIngang = false } = {}) {
      const ii = namen(probeIn).indexOf(naam);
      const ui = alleenIngang ? -1 : namen(probeUit).findIndex((n) => kern(n) === kern(naam));
      if (ii < 0 || (!alleenIngang && ui < 0)) throw new Error(`poort niet gevonden: ${naam}`);
      const inn = new midi.Input(), uit = alleenIngang ? null : new midi.Output();
      inn.ignoreTypes(false, true, true); // SysEx wél, clock en active sensing niet
      inn.openPort(ii);
      uit?.openPort(ui);
      return maakPoort(naam, inn, uit);
    },
    virtueel(naam) {
      const inn = new midi.Input(), uit = new midi.Output();
      inn.ignoreTypes(false, true, true);
      inn.openVirtualPort(naam);
      uit.openVirtualPort(naam);
      return maakPoort(naam, inn, uit);
    },
  };
  return { systeem };
}

/**
 * Uittrekken, gelezen in @julusian/midi 3.8 (RtMidi 6.0, vendor/rtmidi/RtMidi.cpp): de poort blijft "open"
 * (`isPortOpen()` is alleen een vlag van RtMidi zelf) en er komt geen melding (geen notify-proc bij MIDIClientCreate).
 * `sendMessage` gooit op macOS niet: MIDISend faalt hooguit, en dat is een RtMidiError::WARNING, die alleen op stderr
 * komt (de binding zet geen error-callback); ALSA idem. De lijst werkt wel bij (getPortCount pompt de run-loop), en
 * daar verdwijnt het apparaat (te bevestigen op de hardware-avond); een poortindex geldt alleen op het moment van
 * openen (open() zoekt hem op naam). Er is dus geen `levend()`: met RtMidi ziet alleen de poortlijst dat het
 * apparaat weg is geweest. Daarom kijkt aansluiting.js elke LIJST_MS (250 ms) in de lijst, los van het openen (elke
 * `hotplug_ms`); een kabel die korter los is dan dat, blijft onzichtbaar (de APC blijft dan donker in modus 0x40).
 * Of het apparaat bij kort uittrekken echt uit de lijst verdwijnt, en hoe lang, meten we op de hardware-avond.
 * @param {string} naam @param {any} inn @param {any} uit null = alleen een ingang @returns {Poort}
 */
function maakPoort(naam, inn, uit) {
  /** @type {Set<(b: number[]) => void>} */
  const luisteraars = new Set();
  inn.on('message', (/** @type {number} */ _dt, /** @type {number[]} */ b) => { for (const fn of luisteraars) fn(b); });
  return {
    naam,
    // Alleen een ingang (alleenIngang): sturen kan niet; de sessie van zo'n apparaat stuurt ook niets.
    stuur: (b) => { if (!uit) throw new Error(`${naam}: alleen een ingang geopend`); uit.sendMessage(b); },
    bijBericht: (fn) => { luisteraars.add(fn); return () => luisteraars.delete(fn); },
    sluit: () => { try { inn.closePort(); } catch { /* al dicht */ } try { uit?.closePort(); } catch { /* al dicht */ } luisteraars.clear(); },
  };
}
