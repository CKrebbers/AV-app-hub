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
    open(naam) {
      const ii = namen(probeIn).indexOf(naam);
      const ui = namen(probeUit).findIndex((n) => kern(n) === kern(naam));
      if (ii < 0 || ui < 0) throw new Error(`poort niet gevonden: ${naam}`);
      const inn = new midi.Input(), uit = new midi.Output();
      inn.ignoreTypes(false, true, true); // SysEx wél, clock en active sensing niet
      inn.openPort(ii);
      uit.openPort(ui);
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

/** @param {string} naam @param {any} inn @param {any} uit @returns {Poort} */
function maakPoort(naam, inn, uit) {
  /** @type {Set<(b: number[]) => void>} */
  const luisteraars = new Set();
  inn.on('message', (/** @type {number} */ _dt, /** @type {number[]} */ b) => { for (const fn of luisteraars) fn(b); });
  return {
    naam,
    stuur: (b) => uit.sendMessage(b),
    bijBericht: (fn) => { luisteraars.add(fn); return () => luisteraars.delete(fn); },
    sluit: () => { try { inn.closePort(); } catch { /* al dicht */ } try { uit.closePort(); } catch { /* al dicht */ } luisteraars.clear(); },
  };
}
