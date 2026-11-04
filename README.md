# Juleølsmaking

En norsk nettapp for juleølsmaking med tre visninger: arrangør, deltaker og TV. Alle bruker samme server, og stemmer og resultater oppdateres automatisk.

## WordPress / Datejust.no

`wordpress/datejust-juleol/` inneholder en egen WordPress-versjon. Installer mappen som en plugin-ZIP og aktiver den. Appen vises på `/juleolsmaking/`, uten endringer i menyer, eksisterende sider eller tema. Den oppretter ingen sideoppføring i nettstedets vanlige sideoversikter eller standard sitemap, og sender `noindex`.

Denne versjonen lagrer smakinger i WordPress-databasen og henter oppdateringer hvert 2,5 sekund (6 sekunder i bakgrunnsfaner). Den krever ingen separat Node-server. QR-koder genereres i nettleseren uten ekstern tjeneste. Arrangør- og deltakeradgang fungerer som beskrevet nedenfor.

Arrangøren kan legge til et valgfritt bilde av hvert øl. På mobil brukes «Ta bilde» for å fotografere ølet med kameraet, eller «Velg bilde» for et eksisterende bilde. «Ta bilde» ber nettleseren om kameraet på baksiden; på PC kan knappen åpne vanlig filvalg. Bildet vises i øllisten, på poengsiden og i TV-visningen. Opplastingen gjør bildet mindre og konverterer det til JPEG i nettleseren. Bare arrangørtilgangen kan endre bilder.

Gjengens kveldssnitt vises både per deltaker og samlet, slik som i Node-versjonen. Kjør `npm run build:wordpress` for å oppdatere WordPress-grensesnittet fra `public/`. PHP-testene kjøres med `php test/wordpress-domain.test.php`, `php test/wordpress-upload.test.php` og `php test/wordpress-averages.test.php`. GitHub Actions kontrollerer også PHP- og JavaScript-syntaksen. Se `wordpress/datejust-juleol/README.txt` for drift og lagring.

## Kom i gang

Du trenger **Node.js 24**. Versjonen brukt under utvikling er angitt i `.nvmrc`.

```sh
npm ci
npm start
```

Serveren bruker port `3000` som standard. Åpne serverens adresse i nettleseren. På en lokal maskin kan du bruke `http://localhost:3000`. For at mobiltelefoner og TV skal kunne delta, må de bruke en adresse til **samme server** som de har nettverkstilgang til. `localhost` på en telefon peker på selve telefonen.

Ved utvikling kan du bruke `npm run dev` for automatisk omstart når serverkoden endres. Oppdater nettleseren etter endringer i frontendfilene.

## Slik gjennomfører du en smaking

1. Opprett en smaking og gi den et navn.
2. Legg inn ølene dere skal smake, gjerne med bryggeri, alkoholprosent og et bilde av flasken eller boksen.
3. Vis QR-koden på arrangørsiden eller TV-en, eller del deltakerlenken. Når deltakerne skanner QR-koden med mobilkameraet, åpnes riktig smaking. De skriver navnet sitt og vises så på tavlen.
4. Åpne TV-visningen på en stor skjerm.
5. Åpne det første ølet for poenggiving fra arrangørsiden. Hver deltaker velger et heltall fra **1 til 10** og lagrer poenget sitt.
6. TV-visningen viser hvem som har stemt, hvem som mangler, og tabellen over ølene. Rangeringen bruker gjennomsnittspoeng; antall stemmer vises ved siden av.
7. Åpne neste øl når alle er klare, eller steng poenggivingen. Tidligere poeng blir bevart. Deltakerne kan endre poenget sitt mens det aktuelle ølet er åpent.

### Bilder av ølene

Velg et bilde når du legger til et øl, eller legg til og bytt bilde senere fra øllisten. Du kan også fjerne bildet uten å endre ølet eller poengene. Bildene vises for deltakerne og på TV-en.

JPG, PNG og WebP støttes, opptil **10 MiB per bilde** og 40 millioner piksler. Node-serveren tilpasser bildene til maksimalt 1600 × 1600 piksler og lagrer dem som WebP. WordPress-versjonen tilpasser bildene i nettleseren til maksimalt 400 × 400 piksler og sender JPEG til nettstedets opplastingsmappe. Kamerarotasjon korrigeres, og opprinnelige metadata fjernes. Bilder i for eksempel HEIC-format må først lagres som JPG eller PNG.

### Gjengens poeng

Gjengens oversikt viser hvor mange øl hver deltaker har vurdert og gjennomsnittet vedkommende har gitt gjennom kvelden. Kveldens samlede snitt beregnes av alle registrerte vurderinger. Manglende vurderinger teller ikke som null, og endringer erstatter den tidligere vurderingen.

Arrangørtilgangen og deltakertilgangen huskes i nettleseren som opprettet dem. Ikke slett nettleserdata under en smaking. Koden gir innsyn i smakingens navn, deltakernavn og resultater; del den bare med dem som skal delta. Bruk gjerne fornavn eller kallenavn.

### Arrangør på flere enheter

1. Åpne smakingen på enheten som allerede har arrangørtilgang.
2. Finn **Flere arrangørenheter** og velg **Lag arrangørkode**.
3. Åpne appen på en annen mobil, PC eller et nettbrett og velg **Fortsett som arrangør**.
4. Skriv inn **koden til smakingen** og den separate **arrangørkoden**.

Begge enhetene kan nå legge inn øl, håndtere bilder og styre rundene i den samme smakingen. Endringer oppdateres på de andre enhetene. Hver enhet får sin egen tilgang som huskes etter at siden lastes på nytt.

Arrangørkoden vises bare etter at den er laget og kan kopieres fra arrangørsiden. Den lagres ikke i nettleseren og blir ikke med i deltakerlenken eller QR-koden. Lag en ny kode hvis du trenger den igjen etter at siden er lastet på nytt. En ny kode erstatter den gamle for nye innlogginger; enheter som allerede er logget inn, beholder tilgangen. Del arrangørkoden bare med dem som skal styre smakingen.

Dette fungerer også med eksisterende smakinger etter oppdatering: den opprinnelige arrangøren åpner smakingen og lager en arrangørkode. Øl, bilder, deltakere og poeng beholdes. Den vanlige deltakerkoden alene gir ikke arrangørtilgang.

## QR-kode og nettadresse

Hver smaking får automatisk en QR-kode på arrangørsiden og TV-visningen. Koden genereres lokalt på appens server, eller i nettleseren i WordPress-versjonen, og inneholder bare deltakerlenken. Den deler ingen arrangørtilgang og bruker ingen ekstern QR-tjeneste. Lenke og kode kan fortsatt brukes manuelt.

QR-koden bruker nettadressen i nettleseren. Åpne derfor appen på en adresse deltakerne kan nå før du viser koden. Ved `localhost` vises en påminnelse, fordi samme adresse på telefonen peker på telefonen selv. En QR-kode gjør ikke serveren offentlig tilgjengelig.

For tilgang over Internett kan WordPress-versjonen installeres på nettstedet. Node-versjonen trenger en tjeneste som støtter **Node.js 24, varig datalagring og langvarige HTTP-forbindelser**. Når appen får en offentlig HTTPS-adresse, bruker QR-kodene automatisk den adressen. En adresse på det lokale nettverket kan også brukes hvis alle enhetene er på samme nettverk og kan nå serveren.

Appen ber søkemotorer om ikke å indeksere sidene. En skjult QR-lenke kan likevel deles videre av dem som kjenner den; selve QR-koden er ikke adgangskontroll. Arrangørhandlinger krever fortsatt nettleserens private arrangørtilgang.

## Lagring og drift av Node-versjonen

Appen bruker SQLite og trenger ingen ekstern databasetjeneste eller API-nøkler. Databasen opprettes ved første oppstart og inneholder både smakinger, poeng og opplastede bilder. Den er utelatt fra Git, sammen med installerte testavhengigheter. Eksisterende databaser oppdateres automatisk når appen starter.

| Variabel | Standard | Bruk |
| --- | --- | --- |
| `PORT` | `3000` | HTTP-port |
| `HOST` | `0.0.0.0` | Adressen serveren lytter på |
| `DATA_DIR` | `./data` | Mappe for SQLite-databasen; relativ til arbeidsmappen |

Eksempel med en annen port og datamappe:

```sh
PORT=8080 DATA_DIR=/var/lib/juleol npm start
```

Ved hosting må `DATA_DIR` ligge på varig lagring. Kjør én appinstans mot databasen, bruk HTTPS foran serveren, og la en eventuell reverse proxy slippe gjennom Server-Sent Events uten buffering. Liveforbindelser gjenopprettes automatisk ved korte nettverksbrudd. Ta sikkerhetskopi av datamappen mens serveren er stoppet.

Appen bruker `qrcode` for å generere QR-koder og `sharp` for å kontrollere og tilpasse ølbilder. `playwright-core`, `jsqr` og `pngjs` brukes til nettlesertesten, som også dekoder QR-bildene og kontrollerer at de åpner riktig smaking. Node kan vise en melding om at den innebygde SQLite-API-en er eksperimentell.

## Tester

```sh
npm test
npm run test:browser
```

API-testene bruker isolerte, midlertidige databaser. Nettlesertesten starter sin egen server og bruker Chromium. I skymiljøet brukes `/usr/bin/chromium`. Sett `BROWSER_EXECUTABLE` til en annen Chromium-/Chrome-binær ved behov. Testene endrer ikke dataene til en kjørende smaking.

`npm run test:browser:wordpress` tester det bygde WordPress-grensesnittet med riktig undermappe, QR-lenker, polling, tilgangshoder og JPEG-opplasting mot en lokal protokolladapter. PHP-testene kontrollerer WordPress-reglene og REST-adapteren separat. Dette erstatter ikke kontroll på et faktisk WordPress-nettsted etter installasjon.

## Filer

- `server.mjs` – HTTP-API, liveoppdateringer og statiske filer.
- `lib/` – databaselagring og regler for smakingen.
- `public/` – grensesnitt for arrangør, mobil og TV.
- `test/` – automatiske tester av API og lagring.
- `scripts/browser-smoke.mjs` – nettlesertest av en full smaking.

Filene kan legges i GitHub-repositoriet. Publisering til GitHub og hosting av appen er separate steg; appen publiseres ikke automatisk ved å starte den lokalt.
