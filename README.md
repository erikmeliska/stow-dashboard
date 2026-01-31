# Stow Dashboard

Moderné webové rozhranie na vizualizáciu a správu tvojich projektov naskenovaných pomocou `stow-agent`.

## 🚀 Čo to je?

Dashboard je postavený na **Next.js 15** a slúži ako prehľadný katalóg všetkých projektov v adresári `~/Projekty`. Čerpá dáta zo súboru `projects_metadata.jsonl`, ktorý generuje skener.

## ✨ Funkcie

- **Interaktívna tabuľka projektov:** Poháňaná pomocou `@tanstack/react-table`.
- **Git integrácia:** Automatická detekcia repozitárov (GitHub, GitLab, Bitbucket), zobrazenie počtu commitov a tvojho príspevku.
- **Smart hľadanie:** Globálny filter cez názvy, cesty aj Git remotes.
- **Detekcia technologického stacku:** Zobrazuje technológie použité v projekte (z package.json, requirements.txt, atď.).
- **Metriky:** Sleduje veľkosť projektov na disku a dátum poslednej modifikácie.
- **Dark Mode:** Plná podpora tmavého režimu cez Tailwind CSS.

## 🛠 Technológie

- **Framework:** [Next.js 15 (App Router)](https://nextjs.org/)
- **UI:** [shadcn/ui](https://ui.shadcn.com/) + [Tailwind CSS](https://tailwindcss.com/)
- **Ikony:** [Lucide React](https://lucide.dev/)
- **Správa stavu:** React Context API

## 🏃 Spustenie

1. Nainštaluj závislosti:
   ```bash
   yarn install
   ```

2. Uisti sa, že máš vygenerované dáta (zabezpečuje `stow-agent`):
   ```bash
   # Dáta sa očakávajú v data/projects_metadata.jsonl
   ```

3. Spusti vývojový server:
   ```bash
   yarn dev
   ```

Dashboard bude dostupný na [http://localhost:3000](http://localhost:3000).

## 📂 Štruktúra dát

Aplikácia číta dáta zo súboru:
`src/lib/projects.js` -> `data/projects_metadata.jsonl`

Každý riadok JSONL obsahuje metadáta o jednom projekte vrátane Git informácií, veľkosti a technologického stacku.

---
*Vytvorené Ferkom pre Erička. 👍*
