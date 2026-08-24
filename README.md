# Visages du peloton — running it on your Mac

`visages-du-peloton.html` is the whole app in one file. React and the ZIP reader
are bundled inside, so it needs no internet and no install.

## Layout

```
mon-dossier/
├── visages-du-peloton.html
└── photos/
    ├── POGACAR_Tadej.jpg
    ├── van_der_poel_mathieu.png
    ├── 12-kopecky.jpeg
    └── ...
```

## Start it

```bash
cd mon-dossier
python3 -m http.server 8000
```

Open **http://localhost:8000/visages-du-peloton.html**

## How photos work

The app reads `photos/` directly. **No image is ever copied into the app** — a
rider stores a filename, and the browser loads `photos/<file>` like any other
image. Your JPEGs stay JPEGs on disk.

Workflow: drop files into `photos/`, hit **Rescan** in the Photos tab. That's it.
Replacing a photo means overwriting the file — no re-import, no re-linking.

Filenames are matched on surname, ignoring accents, case, digits and separators:

| Filename | Links to |
|---|---|
| `POGACAR_Tadej.jpg` | Pogačar, Tadej |
| `van_der_poel_mathieu.png` | van der Poel |
| `12-kopecky.jpeg` | Kopecky |
| `Ferrand-Prevot_Pauline.jpg` | Ferrand-Prévot |
| `Kung.jpg` | Küng |

Two riders sharing a surname are flagged rather than guessed — put the first
name in the filename (`yates_simon.jpg`) and it resolves. Anything still
unclaimed gets a dropdown in the Photos tab, and that manual choice is
remembered across rescans.

Formats: JPEG, PNG, WEBP, GIF, BMP. Not HEIC — set iPhone to
Settings → Camera → Formats → Most Compatible, or export as JPEG.

### Serving from something other than python3

The folder scan reads the directory listing `http://.server` produces. On a host
with no listings (nginx with autoindex off, GitHub Pages, Netlify), drop a
`photos/manifest.json` next to the images instead — a plain array of filenames,
which the app prefers when present:

```bash
cd photos && ls *.jpg *.jpeg *.png 2>/dev/null | python3 -c \
  "import sys,json; print(json.dumps([l.strip() for l in sys.stdin]))" > manifest.json
```

## Why not just double-click the HTML?

Browsers block both `fetch` and storage on `file://` pages, so the folder scan
fails and nothing persists. The app detects this and says so. The one-line
server above avoids it.

## What is stored, and where

Only text: the roster, the filename each rider points at, and your progress
levels. It lives in IndexedDB under the `localhost:8000` origin.

- Same browser, same port → your roster is there.
- Different browser or port → looks empty.
- Clearing site data for localhost wipes it.

Keep the port at 8000.

## Backups

**Photos → Download backup** writes a small JSON: riders, filenames, progress.
Folder images aren't embedded, so it stays a few KB. Pair it with the `photos/`
folder and you have everything — that's also how you hand the set to another
volunteer.

(Photos added through the upload fallback, on a phone or inside Claude, *are*
embedded, since there's no folder to point at. Keep to the folder on desktop.)

## Rebuilding after edits

`rider-faces.jsx` is the source.

```bash
npm install react react-dom jszip esbuild
```

`entry.jsx`:

```jsx
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import App from "./rider-faces.jsx";
window.JSZip = JSZip;
createRoot(document.getElementById("root")).render(<App />);
```

```bash
npx esbuild entry.jsx --bundle --minify --jsx=automatic \
  --define:process.env.NODE_ENV='"production"' --outfile=bundle.js
```

Paste `bundle.js` inside the `<script>` tag of the HTML.
