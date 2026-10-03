import { describe, it, expect } from 'vitest';
import { INDELING } from '../ui/indeling.js';
import { CONTROLS, OP_ID } from '../src/devices/apc40mk2.js';

describe('opstelling van de virtuele APC40', () => {
  it('elke control heeft een plek', () => {
    expect(CONTROLS.filter((c) => !INDELING[c.id]).map((c) => c.id)).toEqual([]);
  });
  it('Scene Launch 1 (note 82) staat bovenaan, naast de bovenste padrij (noten 32-39)', () => {
    expect(OP_ID.get('scene1').n).toBe(82);
    expect(INDELING.scene1.y).toBeLessThan(INDELING.scene5.y);
    expect(Math.abs(INDELING.scene1.y - INDELING['pad5-1'].y)).toBeLessThan(0.2);
    expect(Math.abs(INDELING.scene5.y - INDELING['pad1-1'].y)).toBeLessThan(0.2);
  });
  it('◄ (note 97) staat links van ► (note 96)', () => {
    expect(INDELING.left.x).toBeLessThan(INDELING.right.x);
  });
});
