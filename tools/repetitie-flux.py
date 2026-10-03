#!/usr/bin/env python3
"""Flux voor de generale repetitie (tools/repetitie.mjs): de echte flux-screensaver, onveranderd,
met een meetlat eromheen.

  python3 tools/repetitie-flux.py <pad/naar/flux-screensaver> <logbestand> [flux-opties...]

Laadt flux als module en draait main() met de opties. Er wordt niets in flux veranderd; alleen drie
methodes van flux.Hub worden omwikkeld om te loggen (JSON per regel, wandklok in ms):
  {"r":"in","t":..,"d":"<tekst>"}      wat flux van de hub ontving (vóór het eigen filter)
  {"r":"uit","t":..,"d":"<tekst>"}     wat flux naar de hub stuurde
  {"r":"staat","t":..,"w":{id:0..1}}   de waarden zoals flux ze zelf toepast (uit de lopende opties)
  {"r":"fout","t":..,"tekst":".."}     een uitzondering of stderr-regel
  {"r":"pid","t":..,"pid":..}          dit proces (zodat de repetitie flux netjes kan stoppen met SIGTERM)
"""
import importlib.machinery, importlib.util, json, os, sys, threading, time

flux_pad, log_pad, opties = sys.argv[1], sys.argv[2], sys.argv[3:]
_log = open(log_pad, "a", buffering=1, encoding="utf-8")
_slot = threading.Lock()


def meld(**x):
    x["t"] = time.time() * 1000
    with _slot:
        _log.write(json.dumps(x, ensure_ascii=False) + "\n")


class Stderr:
    def write(self, s):
        if s.strip():
            meld(r="fout", tekst=s.rstrip())
        return len(s)

    def flush(self):
        pass


meld(r="pid", pid=os.getpid())
sys.stderr = Stderr()
threading.excepthook = lambda a: meld(r="fout", tekst=f"{a.exc_type.__name__}: {a.exc_value}")

lader = importlib.machinery.SourceFileLoader("flux_screensaver", flux_pad)
spec = importlib.util.spec_from_loader("flux_screensaver", lader)
flux = importlib.util.module_from_spec(spec)
lader.exec_module(flux)
Hub = flux.Hub

_ontvang, _stuur, _toepassen = Hub._ontvang, Hub._stuur, Hub.toepassen


def ontvang(self, data):
    meld(r="in", d=data.decode("utf-8", "replace") if isinstance(data, (bytes, bytearray)) else str(data))
    return _ontvang(self, data)


def stuur(self, bericht):
    meld(r="uit", d=json.dumps(bericht, separators=(",", ":")))
    return _stuur(self, bericht)


def staat_uit(a):
    """De waarden zoals flux ze nu gebruikt, terug naar 0..1 (zelfde schaal als hub_manifest)."""
    w = {}
    for id_, _nm, lo, hi, *_ in flux.HUB_WAARDEN:
        if id_ == "helderheid":
            continue                                  # leeft in de render-lus (factor), niet in de opties
        w[id_] = min(1.0, max(0.0, (getattr(a, id_) - lo) / (hi - lo)))
    if a.palet:
        w["palet"] = flux.PALETTEN.index(a.palet) / (len(flux.PALETTEN) - 1)
    w["klok"] = 0.0 if a.palet else 1.0
    return w


def toepassen(self, a):
    nieuw = _toepassen(self, a)
    if nieuw:
        w = staat_uit(a)
        if "helderheid" in self.staat:
            w["helderheid"] = self.staat["helderheid"]
        meld(r="staat", w=w, nieuw=sorted(nieuw))
    return nieuw


Hub._ontvang, Hub._stuur, Hub.toepassen = ontvang, stuur, toepassen

sys.argv = [flux_pad] + opties
try:
    flux.main()
except SystemExit:
    pass
except BaseException as e:                            # noqa: BLE001 - alles melden, dan stoppen
    meld(r="fout", tekst=f"{type(e).__name__}: {e}")
    raise
