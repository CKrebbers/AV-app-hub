#!/bin/zsh -l
# Start studio: de hub plus Varve DJ voor de proefavonden (set "studio").
# Dubbelklik dit bestand in Finder; er opent een Terminal-venster en Chrome met Varve DJ.
# --geen-drivers: de hub start geen drivers voor apps die niet draaien (Uurwerk, Scene Kit,
# Sediment), zodat Varve DJ het eerste slot en de focus krijgt. APC, LPD8, Xboard49 en
# Maschine werken gewoon.
# Stoppen: Ctrl-C in dit venster (de hub ruimt op wat hij startte).
cd "$(dirname "$0")"
exec npm start -- studio --geen-drivers
