// @ts-check
// Virtuele LPD8 (mk2-fabrieksstand): 8 pads (note 36-43) en 8 knoppen (CC 70-77), kanaal 10.
// Opschriften volgen PROTOCOL.md §6; de knoppen tonen de globale macro's uit `beeld`.

import { ROLLEN } from '../src/protocol/manifest.js';
import { lpdDruk, lpdLos, lpdKnop } from './midi.js';

/** Korte namen voor K1..K8 (zelfde volgorde als ROLLEN) en P1..P8. */
export const KNOP_NAMEN = ['intensiteit', 'helderheid', 'ruimte', 'beweging', 'kleur', 'dichtheid', 'adem', 'balans'];
export const PAD_NAMEN = ['paniek', 'tap', 'adem 0', 'gebaren', 'snap 1', 'snap 2', 'snap 3', 'snap 4'];
const KNOP_BEREIK = 160;

/**
 * @param {HTMLElement} root
 * @param {{ stuur: (bytes: number[]) => void }} o
 */
export function maakLpd8(root, { stuur }) {
  root.classList.add('lpd8');
  const knoppen = document.createElement('div');
  knoppen.className = 'lpd-knoppen';
  const pads = document.createElement('div');
  pads.className = 'lpd-pads';
  root.append(knoppen, pads);

  /** @type {Map<string, HTMLElement>} */
  const el = new Map();
  /** @type {Map<string, number>} */
  const stand = new Map();
  /** @type {Set<string>} */
  const bezig = new Set();

  // Zoals op het apparaat: bovenste rij 1-4, onderste rij 5-8 voor knoppen; pads 5-8 boven, 1-4 onder.
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const id = `k${i + 1}`;
    const d = document.createElement('div');
    d.className = 'lpd-knop'; d.dataset.id = id; d.tabIndex = 0;
    d.setAttribute('role', 'slider'); d.setAttribute('aria-label', `LPD8 knop ${i + 1}: ${KNOP_NAMEN[i]}`);
    d.title = `K${i + 1} · ${ROLLEN[i]} · CC ${70 + i} kanaal 10`;
    d.innerHTML = `<i class="ring"></i><i class="dop"><b></b></i><span class="kort">K${i + 1}</span><span class="naam">${KNOP_NAMEN[i]}</span>`;
    knoppen.appendChild(d); el.set(id, d);
    zetStand(id, 0);
    let start = 0, v0 = 0, laatste = -1;
    /** @param {number} v */
    const stuurWaarde = (v) => {
      zetStand(id, v);
      const b = lpdKnop(i, stand.get(id) ?? 0);
      if (b[2] !== laatste) { laatste = b[2]; stuur(b); }
    };
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { d.setPointerCapture(e.pointerId); } catch { /* synthetisch */ }
      bezig.add(id); start = e.clientY; v0 = stand.get(id) ?? 0; laatste = Math.round(v0 * 127);
    });
    d.addEventListener('pointermove', (e) => { if (bezig.has(id)) stuurWaarde(v0 + (start - e.clientY) / KNOP_BEREIK); });
    const klaar = () => bezig.delete(id);
    d.addEventListener('pointerup', klaar);
    d.addEventListener('pointercancel', klaar);
    d.addEventListener('wheel', (e) => { e.preventDefault(); laatste = -1; stuurWaarde((stand.get(id) ?? 0) + (e.deltaY < 0 ? 2 : -2) / 127); }, { passive: false });
    d.addEventListener('keydown', (e) => {
      const op = e.key === 'ArrowUp' || e.key === 'ArrowRight', neer = e.key === 'ArrowDown' || e.key === 'ArrowLeft';
      if (!op && !neer) return;
      e.preventDefault(); laatste = -1; stuurWaarde((stand.get(id) ?? 0) + (op ? 4 : -4) / 127);
    });
  }
  for (const i of [4, 5, 6, 7, 0, 1, 2, 3]) {
    const id = `p${i + 1}`;
    const d = document.createElement('div');
    d.className = 'lpd-pad'; d.dataset.id = id; d.tabIndex = 0;
    d.setAttribute('role', 'button'); d.setAttribute('aria-label', `LPD8 pad ${i + 1}: ${PAD_NAMEN[i]}`);
    d.title = `P${i + 1} · ${PAD_NAMEN[i]} · note ${36 + i} kanaal 10${i >= 4 ? ' · lang drukken = bewaren' : i === 0 ? ' · 1 s vasthouden' : ''}`;
    d.innerHTML = `<span class="kort">P${i + 1}</span><span class="naam">${PAD_NAMEN[i]}</span>`;
    pads.appendChild(d); el.set(id, d);
    let in_ = false, vast = false;
    /** Velocity uit waar je de pad raakt: bovenkant hard, onderkant zacht. @param {PointerEvent|null} e */
    const velocity = (e) => {
      if (!e) return 127;
      const r = d.getBoundingClientRect();
      const t = r.height ? 1 - (e.clientY - r.top) / r.height : 1;
      return Math.round(40 + Math.max(0, Math.min(1, t * 1.25)) * 87);
    };
    /** @param {PointerEvent|null} e */
    const druk = (e) => { if (in_) return; in_ = true; bezig.add(id); d.classList.add('in'); stuur(lpdDruk(i, velocity(e))); };
    const los = () => { if (!in_) return; in_ = false; vast = false; bezig.delete(id); d.classList.remove('in', 'vast'); stuur(lpdLos(i)); };
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (vast) { los(); return; }
      try { d.setPointerCapture(e.pointerId); } catch { /* synthetisch */ }
      druk(e);
      if (e.shiftKey) { vast = true; d.classList.add('vast'); }
    });
    const op = () => { if (!vast) los(); };
    d.addEventListener('pointerup', op);
    d.addEventListener('pointercancel', op);
    d.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); druk(null); } });
    d.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') op(); });
  }

  /** @param {string} id @param {number} v */
  function zetStand(id, v) {
    const x = Math.max(0, Math.min(1, v));
    stand.set(id, x);
    el.get(id)?.style.setProperty('--v', String(x));
    el.get(id)?.setAttribute('aria-valuenow', String(Math.round(x * 127)));
  }

  return {
    el,
    /** Globale macro's uit `beeld` op de knoppen zetten (alleen als je er niet net aan draait). @param {Record<string, unknown>} globaal */
    zetGlobaal(globaal) {
      ROLLEN.forEach((rol, i) => {
        const v = globaal?.[rol];
        if (typeof v === 'number' && !bezig.has(`k${i + 1}`)) zetStand(`k${i + 1}`, v);
      });
    },
    /** @param {any} g */
    invoer(g) {
      if (!g || g.dev !== 'lpd8' || !g.el) return;
      const d = el.get(g.el);
      if (!d || bezig.has(g.el)) return;
      if (g.kind === 'druk') d.classList.add('hw');
      else if (g.kind === 'los') d.classList.remove('hw');
      else if (g.kind === 'waarde' && typeof g.v === 'number') zetStand(g.el, g.v);
    },
  };
}
