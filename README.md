# ☀️ Sol-tracker

En adaptiv UV-dose-tracker som lærer din faktiske soltoleranse over tid.
Den kombinerer den fotobiologiske doseformelen med dine egne tilbakemeldinger
om hvorvidt du ble solbrent, og finjusterer din personlige tålegrense (`MED_cal`).

Hostes på en Raspberry Pi og brukes som installerbar PWA på mobilen.

## Funksjoner

- **Live UV-indeks** hentet fra [Open-Meteo](https://open-meteo.com/) (gratis, ingen API-nøkkel) basert på posisjon.
- **Solingstimer** med sanntids dose-akkumulering (SED), fargekodet mot din tålegrense.
- **Robust mot mobilnettleseren**: aktiv økt lagres i `localStorage` og gjenopprettes hvis fanen kastes; Screen Wake Lock holder skjermen våken under soling.
- **Solkrem-logikk** med realistisk «tynt/tykt lag» — tynt lag halverer effektiv SPF.
- **Værforhold** (full sol / noe skyer / overskyet) demper dosen med en skyfaktor.
- **Kroppsside** (forside / bakside / begge) logges for hver økt.
- **Manuell registrering** av økter i etterkant med egne start- og sluttider.
- **Lærende algoritme** som justerer `MED_cal` opp/ned etter hud-feedback.
- **Forsinket feedback**: appen ber om tilbakemelding om huden først ~8 timer etter en økt (rødhet kommer 4–24t etter soling), med kommentar og hvor du ble brent.
- **PWA**: installerbar på hjemskjermen, fungerer offline for app-skallet.

## Doseformel

```
Dose (SED) = UV-indeks × (minutter / 60) × 0.9 × skyfaktor / effektiv_SPF
```

Effektiv SPF: `ingen krem` = 1, `tynt lag` = SPF/2, `tykt lag` = full SPF.
Skyfaktor: `full sol` = 1.0, `noe skyer` = 0.7, `overskyet` = 0.4.
Kroppsside logges som metadata (påvirker ikke dosen — huden på en gitt flate får samme dose uansett).

## Læringsalgoritme

| Feedback | Betingelse | Justering av `MED_cal` |
|----------|-----------|------------------------|
| 🔴 Solbrent | dose < grense | `grense − (grense − dose) × 0.3` (ned) |
| 🟡 Litt rosa | dose < grense | `grense − (grense − dose) × 0.15` (forsiktig ned) |
| 🟢 Helt fin | dose > grense | `grense + 0.2` (forsiktig opp) |

## Kjøre lokalt

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Åpne `http://localhost:8000` (eller `http://<pi-ip>:8000` fra mobilen på samme nett).

## Sette opp på Raspberry Pi (systemd)

1. Kopier prosjektet til Pi-en, f.eks. `/home/pi/sol-tracker`, og installer som over.
2. Lag `/etc/systemd/system/sol-tracker.service`:

   ```ini
   [Unit]
   Description=Sol-tracker
   After=network.target

   [Service]
   User=pi
   WorkingDirectory=/home/pi/sol-tracker
   ExecStart=/home/pi/sol-tracker/.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

3. Aktiver:

   ```bash
   sudo systemctl enable --now sol-tracker
   ```

## ⚠️ Viktig om GPS og HTTPS

Nettleseren gir bare tilgang til GPS-posisjon over **HTTPS** eller **localhost**.
Over `http://<pi-ip>:8000` på lokalnettet blokkeres GPS. Appen håndterer dette ved
at du kan lagre en **hjemmeposisjon** under ⚙️ Innstillinger — den brukes automatisk
som fallback for UV-henting.

Vil du ha ekte GPS: sett opp HTTPS (f.eks. via [Caddy](https://caddyserver.com/) med
et selvsignert sertifikat, eller [Tailscale](https://tailscale.com/) med MagicDNS + HTTPS).

## Datamodell

Alt lagres i SQLite (`soldata.db`) på Pi-en:

- **profile** — Fitzpatrick-hudtype, start-MED, kalibrert MED, hjemmeposisjon.
- **sessions** — hver økt: start/slutt, UV, SPF, påføring, værforhold, kroppsside, beregnet dose,
  feedback, feedback-kommentar og brannsted.

Nye kolonner legges automatisk til på eksisterende databaser ved oppstart (`migrate()`),
så du kan oppdatere Pi-en uten å miste tidligere økter.

## API

| Metode | Endepunkt | Beskrivelse |
|--------|-----------|-------------|
| GET | `/api/profile` | Hent profil |
| POST | `/api/profile` | Opprett/oppdater profil |
| GET | `/api/uv?lat=&lon=` | Live UV-indeks |
| POST | `/api/session` | Lagre en solingsøkt |
| GET | `/api/sessions` | Alle økter |
| GET | `/api/pending-feedback` | Økter som venter på feedback |
| POST | `/api/feedback` | Send feedback (trigger læring) |
| GET | `/api/today` | Dagens akkumulerte dose |

## Ansvarsfraskrivelse

Dette er et hobbyprosjekt for personlig bruk, ikke et medisinsk verktøy.
UV-estimatene er omtrentlige — bruk sunn fornuft og smør deg godt.
