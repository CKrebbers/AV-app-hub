// @ts-check
import { f0Hardware } from './f0-hardware.js';
import { speelapparaten } from './speelapparaten.js';

/** Alle proeven die `varve-hub proef <naam>` kent. */
export const PROTOCOLLEN = { [f0Hardware.naam]: f0Hardware, [speelapparaten.naam]: speelapparaten };
