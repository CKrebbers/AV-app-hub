// @ts-check
// Het tafereel van de oefenruimte: de Zon aan de hemel, de Zee eronder. Alles wat je met de
// controllers doet, zie je hier meteen terug. Tekent op een canvas, ±60 beelden per seconde.

/** @typedef {{ waarden: Record<string, number>, triggers: Record<string, boolean>, focus: boolean, verbonden: boolean }} AppStand */

const TINTEN = ['#ffd23f', '#ff9f1c', '#ff4d3d'];

/** @param {string} hex @param {number} a */
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
/** @param {number} a @param {number} b @param {number} t */
const meng = (a, b, t) => a + (b - a) * t;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {() => { zon: AppStand, zee: AppStand, adem: number, paniek: boolean }} stand
 */
export function startTafereel(canvas, stand) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  /** Zachte weergave: de tekening volgt de waarden met een korte vertraging, zodat sprongen zichtbaar maar niet hard zijn. */
  /** @type {Record<string, number>} */
  const zacht = {};
  const volg = (/** @type {string} */ k, /** @type {number} */ v, snel = 0.25) => (zacht[k] = zacht[k] === undefined ? v : meng(zacht[k], v, snel));
  let draaiing = 0, t0 = performance.now(), loopt = true;

  function maat() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return { w, h, dpr };
  }

  function teken() {
    if (!loopt) return;
    const { w, h, dpr } = maat();
    const s = stand();
    const tijd = (performance.now() - t0) / 1000;
    const horizon = h * 0.56;
    const zonUit = s.zon.triggers.paniek ? 1 : 0, zeeUit = s.zee.triggers.paniek ? 1 : 0;

    // Hemel: ademt zacht mee met de globale adem.
    const adem = 0.5 - 0.5 * Math.cos(2 * Math.PI * (s.adem || 0));
    const gloed = volg('gloed', s.zon.verbonden ? s.zon.waarden.gloed ?? 0.5 : 0) * (1 - volg('zonUit', zonUit, 0.08));
    const lucht = ctx.createLinearGradient(0, 0, 0, horizon);
    lucht.addColorStop(0, `hsl(225, 45%, ${meng(5, 16, gloed) + adem * 3}%)`);
    lucht.addColorStop(1, `hsl(${meng(225, 25, gloed * 0.7)}, ${meng(30, 60, gloed)}%, ${meng(10, 34, gloed) + adem * 3}%)`);
    ctx.fillStyle = lucht;
    ctx.fillRect(0, 0, w, horizon);

    // Zon
    if (s.zon.verbonden) {
      const tint = TINTEN[Math.round((s.zon.waarden.tint ?? 0.5) * 2)] ?? TINTEN[1];
      const r = (h * 0.07 + h * 0.13 * volg('grootte', s.zon.waarden.grootte ?? 0.5)) * meng(1, 0.6, zacht.zonUit ?? 0);
      const cx = w * 0.5, cy = horizon * 0.52;
      draaiing += (volg('draai', s.zon.waarden.draai ?? 0) * 0.04);
      const halo = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 3.2);
      halo.addColorStop(0, rgba(tint, 0.55 * gloed));
      halo.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, horizon);
      if ((s.zon.waarden.stralen ?? 1) >= 0.5) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(draaiing);
        ctx.strokeStyle = rgba(tint, 0.25 + 0.6 * gloed);
        ctx.lineWidth = 3 * dpr;
        ctx.lineCap = 'round';
        for (let i = 0; i < 12; i++) {
          ctx.rotate(Math.PI / 6);
          ctx.beginPath(); ctx.moveTo(r * 1.25, 0); ctx.lineTo(r * (1.6 + 0.15 * Math.sin(tijd * 2 + i)), 0); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(tint, 0.25 + 0.75 * gloed);
      ctx.fill();
      if (s.zon.triggers.flits) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(0, 0, w, horizon); }
    }

    // Zee
    const diepte = volg('diepte', s.zee.verbonden ? s.zee.waarden.diepte ?? 0.5 : 0);
    const stil = volg('zeeUit', zeeUit, 0.08);
    const golf = volg('golf', s.zee.waarden.golf ?? 0.4) * (1 - stil);
    const galm = volg('galm', s.zee.waarden.galm ?? 0.3, 0.5);
    const schuim = volg('schuim', s.zee.waarden.schuim ?? 0.2);
    const zee = ctx.createLinearGradient(0, horizon, 0, h);
    zee.addColorStop(0, `hsl(210, 70%, ${meng(14, 46, diepte) * (1 - 0.6 * stil)}%)`);
    zee.addColorStop(1, `hsl(222, 75%, ${meng(5, 22, diepte) * (1 - 0.6 * stil)}%)`);
    ctx.fillStyle = zee;
    ctx.fillRect(0, horizon, w, h - horizon);
    if (s.zee.verbonden) {
      // Golflijnen; de galm geeft er nagalmende kopieën bij.
      const echo = 1 + Math.round(galm * 5);
      for (let laag = 0; laag < 5; laag++) {
        const y0 = horizon + (h - horizon) * (0.12 + laag * 0.18);
        for (let e = 0; e < echo; e++) {
          ctx.beginPath();
          const amp = (h * 0.006 + h * 0.035 * golf) * (1 - laag * 0.12) * (1 - e * 0.12);
          for (let x = 0; x <= w; x += 6 * dpr) {
            const y = y0 + e * 5 * dpr * galm + Math.sin(x / (w * 0.09) + tijd * (0.8 + golf * 2.2) + laag * 1.7 - e * 0.5) * amp;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(200, 80%, ${meng(55, 85, diepte)}%, ${(0.45 - laag * 0.06) / (1 + e * 1.1)})`;
          ctx.lineWidth = 2 * dpr;
          ctx.stroke();
        }
        // Schuimkoppen
        const n = Math.round(schuim * 14 * (1 - stil));
        for (let i = 0; i < n; i++) {
          const x = ((i * 0.137 + laag * 0.31 + tijd * 0.02 * (1 + golf)) % 1) * w;
          const y = y0 + Math.sin(x / (w * 0.09) + tijd * (0.8 + golf * 2.2) + laag * 1.7) * (h * 0.006 + h * 0.035 * golf) - 2 * dpr;
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.beginPath(); ctx.ellipse(x, y, 6 * dpr, 2 * dpr, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (s.zee.triggers.meeuw) {
        const x = w * (0.2 + ((tijd * 0.15) % 0.6)), y = horizon * 0.8;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x - 14 * dpr, y); ctx.quadraticCurveTo(x - 7 * dpr, y - 8 * dpr, x, y); ctx.quadraticCurveTo(x + 7 * dpr, y - 8 * dpr, x + 14 * dpr, y); ctx.stroke();
      }
    }
    if (s.paniek) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, w, h); }
    requestAnimationFrame(teken);
  }
  requestAnimationFrame(teken);
  return { stop() { loopt = false; } };
}
