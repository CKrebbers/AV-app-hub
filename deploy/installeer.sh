#!/bin/sh
# Zet de Varve hub "altijd aan": launchd (macOS) of systemd --user (Linux), met het pad van deze checkout.
#   deploy/installeer.sh          schrijven + zeggen welke regel je moet draaien
#   deploy/installeer.sh --weg    weghalen
#   deploy/installeer.sh --lokaal zonder --lan (alleen op deze machine)
# Nooit met sudo: de dienst hoort bij jouw gebruiker.
set -eu
if [ "$(id -u)" = "0" ]; then
  echo "Niet als root of met sudo draaien: de dienst hoort bij jouw gebruiker." >&2
  exit 1
fi
hier=$(cd "$(dirname "$0")/.." && pwd)
command -v node >/dev/null 2>&1 || { echo "node niet gevonden (Node 22 nodig)." >&2; exit 1; }
exec node "$hier/src/cli.js" installeer "$@"
