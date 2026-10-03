// @ts-check
// Virtuele APC40 mkII: alle 148 controls uit src/devices/apc40mk2.js, geplaatst volgens indeling.js.
// Stuurt exact de bytes die de echte zou sturen en toont de LedStaat die de hub tekent.
//   pads/knoppen: note-on bij indrukken, note-off bij loslaten (kanaal = strip). Shift-klik = vasthouden.
//   faders, crossfader, ringknoppen: CC 0..127. Tempo en cue: relatief (two's complement).

import { CONTROLS, OP_ID, PALET } from '../src/devices/apc40mk2.js';
import { INDELING, OPSCHRIFTEN } from './indeling.js';
import { drukBytes, losBytes, ccBytes, relBytes, vanCC } from './midi.js';
import { weergave } from './led.js';

/** @typedef {import('../src/devices/apc40mk2.js').Control} Control @typedef {import('../src/devices/apc40mk2.js').LedStaat} LedStaat */

/** Pixels slepen voor het volle bereik van een ringknop, en per stap van een relatieve knop. */
const KNOP_BEREIK = 160, REL_STAP = 8;

/**
 * @param {HTMLElement} root
 * @param {{ stuur: (bytes: number[]) => void, bpm?: () => number }} o
 */
export function maakApc(root, { stuur, bpm = () => 120 }) {
  root.classList.add('apc');
  const vlak = document.createElement('div');
  vlak.className = 'apc-vlak';
  root.appendChild(vlak);
  for (const [tekst, x, y] of OPSCHRIFTEN) {
    const d = document.createElement('div');
    d.className = 'opschrift'; d.textContent = tekst;
    zetPlek(d, x, y);
    vlak.appendChild(d);
  }

  /** @type {Map<string, HTMLElement>} */
  const el = new Map();
  /** Laatst bekende stand per fader/knop (0..1), voor slepen en weergave. @type {Map<string, number>} */
  const stand = new Map();
  /** Laatste LedStaat per control, om bij een bpm-wissel opnieuw te tekenen. @type {Map<string, LedStaat>} */
  const leds = new Map();
  /** Controls die nu lokaal bediend worden: echo's van de hub negeren we dan. @type {Set<string>} */
  const bezig = new Set();

  for (const c of CONTROLS) {
    const p = INDELING[c.id];
    if (!p) continue;
    const d = document.createElement('div');
    const horizontaal = c.soort === 'fader' && p.w > p.h;
    d.className = `ctl ${c.soort}${horizontaal ? ' horizontaal' : ''} led-${c.led}`;
    d.dataset.id = c.id;
    d.tabIndex = 0;
    d.setAttribute('role', c.soort === 'fader' || c.soort === 'draai' || c.soort === 'rel' ? 'slider' : 'button');
    d.setAttribute('aria-label', c.label);
    d.title = `${c.label} · ${c.t} ${c.n} kanaal ${c.ch + 1}`;
    zetPlek(d, p.x, p.y, p.w, p.h);
    if (c.soort === 'fader') d.innerHTML = '<i class="baan"></i><i class="kap"></i>';
    if (c.soort === 'draai' || c.soort === 'rel') d.innerHTML = '<i class="ring"></i><i class="dop"><b></b></i>';
    const k = document.createElement('span');
    k.className = 'kort'; k.textContent = p.kort;
    d.appendChild(k);
    vlak.appendChild(d);
    el.set(c.id, d);
    if (c.soort === 'fader') zetStand(c.id, c.id === 'xf' ? 0.5 : 0);
    if (c.soort === 'draai') zetStand(c.id, 0);
    if (c.soort === 'rel') zetStand(c.id, 0.5);
    if (c.soort === 'pad' || c.soort === 'scene' || c.soort === 'knop' || c.soort === 'voet') knopGedrag(c, d);
    else waardeGedrag(c, d, horizontaal);
  }

  /** @param {string} id @param {number} v */
  function zetStand(id, v) {
    const x = Math.max(0, Math.min(1, v));
    stand.set(id, x);
    el.get(id)?.style.setProperty('--v', String(x));
    el.get(id)?.setAttribute('aria-valuenow', String(Math.round(x * 127)));
  }

  /** @param {Control} c @param {HTMLElement} d */
  function knopGedrag(c, d) {
    let in_ = false, vast = false;
    const druk = () => { if (in_) return; in_ = true; bezig.add(c.id); d.classList.add('in'); stuur(drukBytes(c)); };
    const los = () => {
      if (!in_) return;
      in_ = false; vast = false; bezig.delete(c.id);
      d.classList.remove('in', 'vast'); stuur(losBytes(c));
    };
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (vast) { los(); return; } // tweede klik laat een vastgehouden knop los
      try { d.setPointerCapture(e.pointerId); } catch { /* synthetische events */ }
      druk();
      if (e.shiftKey) { vast = true; d.classList.add('vast'); }
    });
    const op = () => { if (!vast) los(); };
    d.addEventListener('pointerup', op);
    d.addEventListener('pointercancel', op);
    d.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        if (vast) { los(); return; }
        druk();
        if (e.shiftKey) { vast = true; d.classList.add('vast'); }
      }
    });
    d.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') op(); });
  }

  /** @param {Control} c @param {HTMLElement} d @param {boolean} horizontaal */
  function waardeGedrag(c, d, horizontaal) {
    let laatsteCC = -1, start = 0, v0 = 0, gestuurd = 0;
    /** @param {number} v */
    const stuurWaarde = (v) => {
      zetStand(c.id, v);
      const b = ccBytes(c, stand.get(c.id) ?? 0);
      if (b[2] !== laatsteCC) { laatsteCC = b[2]; stuur(b); }
    };
    /** @param {number} delta */
    const stuurRel = (delta) => {
      if (!delta) return;
      stuur(relBytes(c, delta));
      zetStand(c.id, ((stand.get(c.id) ?? 0.5) + delta / 64 + 1) % 1);
    };
    /** Fader: de kap springt naar waar je drukt (prettig op een tablet). @param {PointerEvent} e */
    const faderWaarde = (e) => {
      const r = d.getBoundingClientRect();
      const t = horizontaal ? (e.clientX - r.left - r.width * 0.08) / (r.width * 0.84) : 1 - (e.clientY - r.top - r.height * 0.1) / (r.height * 0.8);
      return t;
    };
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { d.setPointerCapture(e.pointerId); } catch { /* synthetische events */ }
      bezig.add(c.id); d.classList.add('in');
      start = c.soort === 'fader' && horizontaal ? e.clientX : e.clientY;
      v0 = stand.get(c.id) ?? 0; gestuurd = 0;
      laatsteCC = Math.round(v0 * 127);
      if (c.soort === 'fader') stuurWaarde(faderWaarde(e));
    });
    d.addEventListener('pointermove', (e) => {
      if (!bezig.has(c.id)) return;
      if (c.soort === 'fader') { stuurWaarde(faderWaarde(e)); return; }
      const px = start - e.clientY;
      if (c.soort === 'rel') {
        const stappen = Math.trunc(px / REL_STAP);
        if (stappen !== gestuurd) { stuurRel(stappen - gestuurd); gestuurd = stappen; }
        return;
      }
      stuurWaarde(v0 + px / KNOP_BEREIK);
    });
    const klaar = () => { bezig.delete(c.id); d.classList.remove('in'); };
    d.addEventListener('pointerup', klaar);
    d.addEventListener('pointercancel', klaar);
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      const stap = e.deltaY < 0 ? 1 : -1;
      if (c.soort === 'rel') stuurRel(stap);
      else { laatsteCC = -1; stuurWaarde((stand.get(c.id) ?? 0) + stap * (e.shiftKey ? 1 : 2) / 127); }
    }, { passive: false });
    d.addEventListener('keydown', (e) => {
      const op = e.key === 'ArrowUp' || e.key === 'ArrowRight', neer = e.key === 'ArrowDown' || e.key === 'ArrowLeft';
      if (!op && !neer) return;
      e.preventDefault();
      if (c.soort === 'rel') stuurRel(op ? 1 : -1);
      else { laatsteCC = -1; stuurWaarde((stand.get(c.id) ?? 0) + (op ? 4 : -4) / 127); }
    });
  }

  /** @param {string} id @param {LedStaat} s */
  function zetLed(id, s) {
    const d = el.get(id);
    const c = OP_ID.get(id);
    if (!d || !c) return;
    leds.set(id, s);
    const w = weergave(c, s, PALET, bpm());
    if (w.ring !== null) {
      if (!bezig.has(id)) zetStand(id, w.ring);
      return;
    }
    d.classList.toggle('aan', w.aan);
    d.classList.remove('puls', 'knipper', 'oneshot');
    if (w.anim) {
      d.classList.add(w.anim);
      d.style.setProperty('--duur', `${Math.max(0.08, w.duur).toFixed(3)}s`);
      // Herstart de animatie zodat een nieuwe oneshot opnieuw loopt.
      d.style.animation = 'none'; void d.offsetWidth; d.style.animation = '';
    }
    if (w.kleur) d.style.setProperty('--led', w.kleur); else d.style.removeProperty('--led');
    if (w.kleur2) d.style.setProperty('--led2', w.kleur2); else d.style.removeProperty('--led2');
    if (c.led === 'rgb') d.dataset.kleur = String(Math.max(0, Math.min(127, Math.round((s.anim && s.anim.kleur2 !== undefined ? s.anim.kleur2 : s.kleur) ?? 0))));
    if (c.led === 'ab') d.dataset.stand = String(w.stand);
  }

  return {
    el,
    stand,
    /** @param {Record<string, LedStaat>} staat */
    zetLeds(staat) { for (const [id, s] of Object.entries(staat)) zetLed(id, s); },
    zetLed,
    /** Na een bpm-wissel: alle animaties op het nieuwe tempo. */
    herteken() { for (const [id, s] of leds) zetLed(id, s); },
    /** Gebeurtenis van de echte (of virtuele) controller: laat zien wat er gebeurt. @param {any} g */
    invoer(g) {
      if (!g || g.dev !== 'apc40' || !g.el) return;
      const d = el.get(g.el);
      if (!d) return;
      d.classList.add('flits');
      setTimeout(() => d.classList.remove('flits'), 140);
      if (bezig.has(g.el)) return;
      if (g.kind === 'druk') d.classList.add('hw');
      else if (g.kind === 'los') d.classList.remove('hw');
      else if (g.kind === 'waarde') zetStand(g.el, typeof g.v === 'number' ? g.v : vanCC(g.raw ?? 0));
      else if (g.kind === 'delta' && typeof g.delta === 'number') zetStand(g.el, ((stand.get(g.el) ?? 0.5) + g.delta / 64 + 1) % 1);
    },
  };
}

/** @param {HTMLElement} d @param {number} x @param {number} y @param {number} [w] @param {number} [h] */
function zetPlek(d, x, y, w, h) {
  d.style.left = `calc(var(--u) * ${x})`;
  d.style.top = `calc(var(--u) * ${y})`;
  if (w !== undefined) d.style.width = `calc(var(--u) * ${w})`;
  if (h !== undefined) d.style.height = `calc(var(--u) * ${h})`;
}
