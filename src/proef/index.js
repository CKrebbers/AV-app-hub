// @ts-check
import { f0Hardware } from './f0-hardware.js';
import { speelapparaten } from './speelapparaten.js';
import { kp3plus, efx500 } from './kp3-efx.js';

/** Alle proeven die `varve-hub proef <naam>` kent. */
export const PROTOCOLLEN = { [f0Hardware.naam]: f0Hardware, [speelapparaten.naam]: speelapparaten, [kp3plus.naam]: kp3plus, [efx500.naam]: efx500 };
