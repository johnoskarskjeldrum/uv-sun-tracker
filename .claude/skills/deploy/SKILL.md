---
name: deploy
description: Deploy sol-tracker til Raspberry Pi — pusher lokale endringer til GitHub og oppdaterer Pi-en (git pull + restart av systemd-tjenesten) over SSH. Bruk denne når brukeren vil deploye, oppdatere Pi-en, eller «pushe til produksjon».
---

# Deploy sol-tracker til Raspberry Pi

Denne skill-en kjører `scripts/deploy.sh`, som:

1. Committer og pusher eventuelle lokale endringer til GitHub.
2. SSH-er inn på Pi-en og kjører `git pull`, installerer avhengigheter på nytt
   hvis `requirements.txt` er endret, og restarter systemd-tjenesten.
3. Verifiserer at tjenesten kjører, og viser logg hvis den feilet.

## Forutsetning: konfigurasjon

Deploy krever `scripts/deploy.env` (gitignorert). Hvis den mangler, opprett den:

```bash
cp scripts/deploy.env.example scripts/deploy.env
```

Deretter be brukeren fylle inn `PI_HOST`, `PI_DIR`, `SERVICE` og `BRANCH`.
Passordløs SSH til Pi-en (SSH-nøkkel) bør være satt opp, ellers spør SSH om passord.

## Kjøre deploy

```bash
bash scripts/deploy.sh
```

Med en egendefinert commit-melding for ucommittede endringer:

```bash
bash scripts/deploy.sh "Legg til UV-graf"
```

## Etter kjøring

- Rapporter om tjenesten ble startet (`✅ ... kjører`) eller feilet.
- Ved feil: vis den siste `journalctl`-loggen som skriptet skrev ut, og foreslå
  en fiks. Ikke prøv på nytt med identisk kommando uten en endring.
