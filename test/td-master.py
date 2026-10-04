"""td-master.py: speel MIDI van de hub af op de echte TD-code van av-scene-kit (zonder TouchDesigner).

Gebruikt de mock-omgeving van av-scene-kit (td/_mock_td_test.py: op, ui, CHOP's ...), bouwt de TD-hub met
td/td_build_hub.py zoals de mocktest dat doet, en voert dan elk MIDI-bericht van stdin door de echte
callbacks: note-on → pads.onOffToOn, CC van een knop → pickup.onValueChange (alleen als de waarde
verandert, zoals een CHOP Execute DAT). Na elk bericht: ctrl.knob8 = knob·mask + preset·inv (de master
die TD laat zien, td_build_hub.py "soft-takeover").

    python3 test/td-master.py <pad naar av-scene-kit>  < [[status, d1, d2], ...]  →  [ctrl.knob8 vooraf, en na elk bericht]

Voor test/paniek-drivers.test.js: hub en TD moeten na een paniek dezelfde master hebben.
"""
import contextlib
import json
import os
import sys
import tempfile

kit = os.path.abspath(sys.argv[1])
berichten = json.load(sys.stdin)
sys.path.insert(0, os.path.join(kit, 'td'))
os.environ['HOME'] = tempfile.mkdtemp(prefix='td_master_')
os.environ.pop('VARVE_CONFIG', None)
os.environ['VARVE_KIT_ROOT'] = kit

with contextlib.redirect_stdout(sys.stderr):
    import _mock_td_test as M  # noqa: E402  (mock-globals; run() draait niet bij importeren)
    g = M.td_globals()
    exec(compile(open(M.SCRIPT, encoding='utf-8').read(), M.SCRIPT, 'exec'), g)

hub = M.PROJECT1.op('hub')
pads = hub.op('pads').module
pick = hub.op('pickup').module
ch = int(g['MIDI_CH'])
knop_cc = {cc: f'knob{i + 1}' for i, cc in enumerate(g['KNOB_CC'])}
live = {}


def master():
    base = hub.op('preset_base')['knob8'].eval()
    mask = hub.op('pickup_mask')['knob8'].eval()
    inv = hub.op('pickup_inv')['knob8'].eval()
    return live.get('knob8', base) * mask + base * inv


uit = [master()]  # vóór het eerste bericht: de stand na de build (preset 1)
with contextlib.redirect_stdout(sys.stderr):
    for status, d1, d2 in berichten:
        soort, kanaal = status & 0xF0, (status & 0x0F) + 1
        if kanaal == ch and soort == 0x90 and d2 > 0:
            pads.onOffToOn(M.Chan('ch%dn%d' % (ch, d1), 1), 0, 1, 0)
        elif kanaal == ch and soort == 0xB0 and d1 in knop_cc:
            naam, v = knop_cc[d1], d2 / 127
            vorige = live.get(naam)
            live[naam] = v
            if vorige is None or vorige != v:
                pick.onValueChange(M.Chan(naam, v), 0, v, 0.0 if vorige is None else vorige)
        uit.append(master())

print(json.dumps(uit))
