import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";

/* ============================================================
   Visages du peloton — Montréal 2026
   A face-recognition trainer for race volunteers.
   Photos are supplied by you; the app handles drilling + recall.
   ============================================================ */

const BUCKET = 20;
const ROSTER_KEY = "mtl26:roster:v1";
const pbKey = (b) => `mtl26:pb:${b}`;

/* Two backends: Claude's artifact storage when running inside Claude, IndexedDB
   when running standalone. Falls back to memory so the app still works, badly. */
const hasStore =
  typeof window !== "undefined" &&
  window.storage &&
  typeof window.storage.get === "function";
const mem = new Map();
export const STORAGE_MODE = { current: hasStore ? "claude" : "idb" };

const DB_NAME = "visages-du-peloton";
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB blocked"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
  return dbPromise;
}

function idbRun(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", mode);
        const req = run(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

async function sGet(key) {
  if (hasStore) {
    try {
      const r = await window.storage.get(key, false);
      if (!r || r.value == null) return null;
      return typeof r.value === "string" ? JSON.parse(r.value) : r.value;
    } catch (e) {
      return null;
    }
  }
  try {
    const v = await idbRun("readonly", (s) => s.get(key));
    return v === undefined ? null : v;
  } catch (e) {
    STORAGE_MODE.current = "memory";
    return mem.has(key) ? mem.get(key) : null;
  }
}

async function sSet(key, val) {
  if (hasStore) {
    try {
      const r = await window.storage.set(key, JSON.stringify(val), false);
      return !!r;
    } catch (e) {
      return false;
    }
  }
  try {
    await idbRun("readwrite", (s) => s.put(val, key));
    return true;
  } catch (e) {
    STORAGE_MODE.current = "memory";
    mem.set(key, val);
    return false;
  }
}

async function sDel(key) {
  if (hasStore) {
    try {
      await window.storage.delete(key, false);
    } catch (e) {}
    return;
  }
  try {
    await idbRun("readwrite", (s) => s.delete(key));
  } catch (e) {
    mem.delete(key);
  }
}

/* Probe once so we can warn the user if nothing will persist (file:// origins
   block IndexedDB in most browsers). */
async function probeStorage() {
  if (hasStore) return "claude";
  try {
    await idbRun("readwrite", (s) => s.put(1, "__probe"));
    await idbRun("readwrite", (s) => s.delete("__probe"));
    return "idb";
  } catch (e) {
    STORAGE_MODE.current = "memory";
    return "memory";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- countries ---------- */
const IOC2ISO = {
  SLO:"SI",NED:"NL",BEL:"BE",DEN:"DK",ERI:"ER",ESP:"ES",MEX:"MX",POR:"PT",ITA:"IT",
  GBR:"GB",IRL:"IE",USA:"US",GER:"DE",SUI:"CH",FRA:"FR",ECU:"EC",COL:"CO",AUS:"AU",
  LAT:"LV",CAN:"CA",POL:"PL",NZL:"NZ",NOR:"NO",SWE:"SE",AUT:"AT",CZE:"CZ",SVK:"SK",
  RSA:"ZA",JPN:"JP",KAZ:"KZ",UKR:"UA",EST:"EE",LTU:"LT",HUN:"HU",ROU:"RO",CRO:"HR",
  SRB:"RS",GRE:"GR",TUR:"TR",ISR:"IL",BRA:"BR",ARG:"AR",CHI:"CL",URU:"UY",VEN:"VE",
  CRC:"CR",GUA:"GT",RWA:"RW",ETH:"ET",ALG:"DZ",MAR:"MA",TUN:"TN",EGY:"EG",BUR:"BF",
  UAE:"AE",CHN:"CN",KOR:"KR",TPE:"TW",THA:"TH",IND:"IN",INA:"ID",MAS:"MY",PHI:"PH",
  SGP:"SG",HKG:"HK",LUX:"LU",MON:"MC",BLR:"BY",MDA:"MD",GEO:"GE",ARM:"AM",AZE:"AZ",
  KGZ:"KG",UZB:"UZ",ISL:"IS",FIN:"FI",CYP:"CY",BUL:"BG",MKD:"MK",ALB:"AL",BIH:"BA",
  MNE:"ME",AND:"AD",SMR:"SM",MLT:"MT",NAM:"NA",KEN:"KE",UGA:"UG",NGR:"NG",GHA:"GH",
  CIV:"CI",SEN:"SN",CMR:"CM",ZIM:"ZW",BOT:"BW",MRI:"MU",CUB:"CU",DOM:"DO",PUR:"PR",
  PAN:"PA",HON:"HN",BOL:"BO",PER:"PE",PAR:"PY",TTO:"TT",JAM:"JM",BAR:"BB",SUR:"SR",
  GUY:"GY",FIJ:"FJ",PNG:"PG",MYA:"MM",VIE:"VN",NEP:"NP",IRI:"IR",IRQ:"IQ",JOR:"JO",
  LIB:"LB",KSA:"SA",QAT:"QA",BRN:"BH",KUW:"KW",OMA:"OM",SYR:"SY",LBA:"LY",SUD:"SD",
  TAN:"TZ",ZAM:"ZM",MOZ:"MZ",ANG:"AO",MAD:"MG",MAW:"MW",BEN:"BJ",TOG:"TG",MLI:"ML",
  NIG:"NE",GAB:"GA",CGO:"CG",COD:"CD",LIE:"LI",
};
function flagOf(code) {
  const iso = IOC2ISO[(code || "").toUpperCase()];
  if (!iso) return "";
  return String.fromCodePoint(
    ...iso.split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

const CATEGORIES = [
  "Men Elite",
  "Women Elite",
  "Men U23",
  "Women U23",
  "Men Junior",
  "Women Junior",
  "Staff / other",
];

/* ---------- starter roster (edit freely — not the official startlist) ---------- */
const SEED = [
  ["Pogačar","Tadej","SLO","Men Elite"],["van der Poel","Mathieu","NED","Men Elite"],
  ["Evenepoel","Remco","BEL","Men Elite"],["Vingegaard","Jonas","DEN","Men Elite"],
  ["Roglič","Primož","SLO","Men Elite"],["van Aert","Wout","BEL","Men Elite"],
  ["Pedersen","Mads","DEN","Men Elite"],["Philipsen","Jasper","BEL","Men Elite"],
  ["Girmay","Biniam","ERI","Men Elite"],["Ayuso","Juan","ESP","Men Elite"],
  ["Del Toro","Isaac","MEX","Men Elite"],["Almeida","João","POR","Men Elite"],
  ["Ganna","Filippo","ITA","Men Elite"],["Milan","Jonathan","ITA","Men Elite"],
  ["Pidcock","Tom","GBR","Men Elite"],["Onley","Oscar","GBR","Men Elite"],
  ["Healy","Ben","IRL","Men Elite"],["Skjelmose","Mattias","DEN","Men Elite"],
  ["Jorgenson","Matteo","USA","Men Elite"],["Kuss","Sepp","USA","Men Elite"],
  ["Simmons","Quinn","USA","Men Elite"],["Lipowitz","Florian","GER","Men Elite"],
  ["Hirschi","Marc","SUI","Men Elite"],["Küng","Stefan","SUI","Men Elite"],
  ["Mohorič","Matej","SLO","Men Elite"],["Alaphilippe","Julian","FRA","Men Elite"],
  ["Vauquelin","Kévin","FRA","Men Elite"],["Seixas","Paul","FRA","Men Elite"],
  ["Carapaz","Richard","ECU","Men Elite"],["Narváez","Jhonatan","ECU","Men Elite"],
  ["Bernal","Egan","COL","Men Elite"],["Matthews","Michael","AUS","Men Elite"],
  ["Skujiņš","Toms","LAT","Men Elite"],["Woods","Michael","CAN","Men Elite"],
  ["Houle","Hugo","CAN","Men Elite"],["Boivin","Guillaume","CAN","Men Elite"],
  ["Gee","Derek","CAN","Men Elite"],
  ["Kopecky","Lotte","BEL","Women Elite"],["Vollering","Demi","NED","Women Elite"],
  ["Wiebes","Lorena","NED","Women Elite"],["Vos","Marianne","NED","Women Elite"],
  ["Pieterse","Puck","NED","Women Elite"],["Longo Borghini","Elisa","ITA","Women Elite"],
  ["Balsamo","Elisa","ITA","Women Elite"],["Reusser","Marlen","SUI","Women Elite"],
  ["Niewiadoma","Katarzyna","POL","Women Elite"],["Ferrand-Prévot","Pauline","FRA","Women Elite"],
  ["Kerbaol","Cédrine","FRA","Women Elite"],["Faulkner","Kristen","USA","Women Elite"],
  ["Dygert","Chloé","USA","Women Elite"],["Lippert","Liane","GER","Women Elite"],
  ["Bäckstedt","Zoe","GBR","Women Elite"],["Wollaston","Ally","NZL","Women Elite"],
  ["Jackson","Alison","CAN","Women Elite"],["Vallieres","Magdeleine","CAN","Women Elite"],
  ["Baril","Olivia","CAN","Women Elite"],
];

/* ---------- image handling ---------- */
function fileToDataUrl(file, max = 460, quality = 0.75) {
  return new Promise((resolve, reject) => {
    if (file && file.type && /heic|heif/i.test(file.type)) {
      reject(new Error("iPhone HEIC photos can't be read here — switch Settings > Camera > Formats to 'Most Compatible', or take a screenshot of the photo and upload that instead."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error("That file couldn't be read from disk. Try a different photo."));
    };
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#101317";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL("image/jpeg", quality));
        } catch (e) {
          reject(new Error("That image couldn't be processed. Try a JPEG or PNG."));
        }
      };
      img.onerror = () => {
        reject(new Error("That file isn't a readable image. Try a JPEG, PNG, or WEBP."));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- filename matching ---------- */
function norm(v) {
  return (v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const toks = (v) => {
  const n = norm(v);
  return n ? n.split(" ") : [];
};
function hasSeq(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
function baseName(path) {
  const f = String(path).split(/[\\/]/).pop();
  return f.replace(/\.[a-z0-9]+$/i, "");
}

/* Score a filename against the roster. Surnames are matched as whole tokens
   ("van der poel" as three consecutive tokens), so "vos" won't hit "vosberg".
   A squashed filename like "tadejpogacar.jpg" falls back to substring, weakly. */
function matchRider(fileName, riders) {
  const ft = toks(baseName(fileName));
  const joined = ft.join("");
  let best = [];
  let bestScore = 0;
  for (const r of riders) {
    const lt = toks(r.last);
    const ftk = toks(r.first);
    let score = 0;
    if (hasSeq(ft, lt)) score = 3 + lt.length;
    else if (lt.length && lt.join("").length >= 4 && joined.includes(lt.join("")))
      score = 1;
    if (score && ftk.length) {
      if (hasSeq(ft, ftk) || joined.includes(ftk.join(""))) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = [r];
    } else if (score && score === bestScore) {
      best.push(r);
    }
  }
  if (!bestScore) return { riderId: "", status: "none" };
  if (best.length > 1) return { riderId: "", status: "ambiguous" };
  return {
    riderId: best[0].id,
    status: bestScore >= 4 ? "match" : "weak",
  };
}

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

const DEFAULT_DIR = "photos/";

/* Read the contents of a local photo folder. Tries photos/manifest.json first
   (works on any static host), then falls back to parsing the directory listing
   that python3 -m http.server serves by default. No binaries are ever copied
   into the app: riders just hold the filename, and <img src> does the rest. */
async function listFolder(dir) {
  const base = dir.endsWith("/") ? dir : dir + "/";

  try {
    const r = await fetch(base + "manifest.json", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const arr = Array.isArray(j) ? j : Array.isArray(j.files) ? j.files : null;
      if (arr) {
        const files = arr
          .map((n) => String(n).split("/").pop())
          .filter((n) => IMG_RE.test(n));
        if (files.length)
          return { base, files: [...new Set(files)], via: "manifest.json" };
      }
    }
  } catch (e) {
    /* no manifest, that's fine */
  }

  let res;
  try {
    res = await fetch(base, { cache: "no-store" });
  } catch (e) {
    throw new Error(
      `Couldn't reach ${base}. Is the app running from a local server?`
    );
  }
  if (!res.ok) throw new Error(`No folder at ${base} (HTTP ${res.status}).`);

  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "text/html");
  const files = [...doc.querySelectorAll("a[href]")]
    .map((a) => a.getAttribute("href") || "")
    .map((h) => {
      try {
        return decodeURIComponent(h);
      } catch (e) {
        return h;
      }
    })
    .map((h) => h.split("?")[0].split("#")[0].split("/").filter(Boolean).pop() || "")
    .filter((n) => IMG_RE.test(n) && !n.startsWith("."));

  const uniq = [...new Set(files)];
  if (!uniq.length)
    throw new Error(
      `Reached ${base} but found no images. Supported: JPEG, PNG, WEBP, GIF, BMP.`
    );
  return { base, files: uniq, via: "directory listing" };
}

/* A roster.json served next to the page turns a first visit into a ready app:
   same shape as a Photos-tab backup, riders pointing at photos/ by filename.
   What carries over is the roster — names, nations, categories, and the manual
   filename choices that resolve shared surnames. What does not is whoever
   exported it: box/seen/hits are reset so each visitor starts at zero rather
   than inheriting a stranger's progress. Embedded photos are ignored too — the
   folder is the source of truth — so `stored` is cleared rather than trusted.
   A missing file, or no network, falls through to the empty state as before. */
const SEED_FILE = "roster.json";

async function fetchSeedRoster() {
  let payload;
  try {
    const res = await fetch(SEED_FILE, { cache: "no-store" });
    if (!res.ok) return null;
    payload = await res.json();
  } catch (e) {
    return null; /* absent, malformed or offline: all mean "no seed" */
  }
  if (!payload || !Array.isArray(payload.riders) || !payload.riders.length)
    return null;
  return {
    riders: payload.riders.map((r, i) => ({
      ...r,
      seq: typeof r.seq === "number" ? r.seq : i,
      b: typeof r.b === "number" ? r.b : Math.floor(i / BUCKET),
      stored: false,
      box: 0,
      seen: 0,
      hits: 0,
    })),
    photoDir: payload.photoDir,
  };
}

/* Decide which file belongs to which rider. Explicit mappings the user has
   already made are honoured first; everything else is matched on surname. */
function resolveFolder(riders, files) {
  const present = new Set(files);
  const byId = {};
  const taken = new Set();

  for (const r of riders) {
    if (r.file && present.has(r.file)) {
      byId[r.id] = r.file;
      taken.add(r.file);
    }
  }

  const unmatched = [];
  const pool = riders.filter((r) => !byId[r.id]);
  for (const f of files) {
    if (taken.has(f)) continue;
    const m = matchRider(f, pool.filter((r) => !byId[r.id]));
    if (m.riderId && !byId[m.riderId]) {
      byId[m.riderId] = f;
      taken.add(f);
    } else {
      unmatched.push({ file: f, why: m.status });
    }
  }
  return { byId, unmatched };
}

function loadJSZip() {
  if (typeof window !== "undefined" && window.JSZip)
    return Promise.resolve(window.JSZip);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src =
      "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    el.onload = () =>
      window.JSZip
        ? resolve(window.JSZip)
        : reject(new Error("ZIP reader failed to load."));
    el.onerror = () =>
      reject(
        new Error(
          "Couldn't load the ZIP reader. Unzip the archive and pick the images or the folder instead."
        )
      );
    document.head.appendChild(el);
  });
}

/* Flatten a selection into plain image Files, expanding any .zip archives. */
async function expandSelection(fileList) {
  const out = [];
  for (const f of Array.from(fileList)) {
    const name = f.name || "";
    if (/\.zip$/i.test(name)) {
      const JSZip = await loadJSZip();
      const zip = await JSZip.loadAsync(f);
      const entries = [];
      zip.forEach((path, entry) => {
        const leaf = path.split("/").pop();
        if (!entry.dir && IMG_RE.test(path) && leaf && !leaf.startsWith("."))
          entries.push({ path, entry, leaf });
      });
      for (const e of entries) {
        const blob = await e.entry.async("blob");
        const ext = e.leaf.split(".").pop().toLowerCase();
        out.push(
          new File([blob], e.leaf, { type: MIME[ext] || "image/jpeg" })
        );
      }
    } else if (IMG_RE.test(name) && !name.startsWith(".")) {
      out.push(f);
    }
  }
  return out;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------- randomness ---------- */
function rnd() {
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] / 4294967296;
    }
  } catch (e) {}
  return Math.random();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* Random order over the whole set, weakly-known riders drifting earlier.
   Every rider appears exactly once per session. */
function weightedOrder(list) {
  return list
    .map((r) => ({
      id: r.id,
      k: Math.pow(rnd(), 1 / Math.max(1, 6 - (r.box || 0))),
    }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.id);
}

/* ---------- rainbow ---------- */
const BANDS = ["#2F6DB5", "#D6222A", "#111418", "#F2B705", "#00975A"];

function Jersey({ box = 0, size = "sm" }) {
  return (
    <span className={`mz-jersey mz-jersey-${size}`} aria-label={`Level ${box} of 5`}>
      {BANDS.map((c, i) => (
        <span
          key={i}
          className="mz-band"
          style={{ background: i < box ? c : "#DEDCD5" }}
        />
      ))}
    </span>
  );
}

/* ============================================================ */

export default function RiderFaces() {
  const [loaded, setLoaded] = useState(false);
  const [riders, setRiders] = useState([]);
  const [photos, setPhotos] = useState({});
  const [tab, setTab] = useState("study");
  const [toast, setToast] = useState(null);
  const [focus, setFocus] = useState(null);
  const [storageMode, setStorageMode] = useState("claude");
  const [photoDir, setPhotoDir] = useState(DEFAULT_DIR);
  const [folder, setFolder] = useState({
    state: "idle",
    files: [],
    via: "",
    msg: "",
  });

  const openProfile = useCallback((id) => {
    setFocus({ id, at: Date.now() });
    setTab("roster");
  }, []);

  const returnFromProfile = useCallback(() => {
    setFocus(null);
    setTab("study");
  }, []);

  const bucketsRef = useRef({});
  const saveTimer = useRef(null);
  const firstSave = useRef(true);

  /* ---- load ---- */
  useEffect(() => {
    let dead = false;
    (async () => {
      const data = await sGet(ROSTER_KEY);
      if (dead) return;
      if (data && Array.isArray(data.riders)) {
        setRiders(data.riders);
        if (data.photoDir) setPhotoDir(data.photoDir);
      } else {
        /* Nothing stored for this browser yet. If the host ships a roster.json,
           adopt it so a visitor lands on a full roster instead of the empty
           state. Clearing firstSave lets that seed persist on the next tick,
           after which this browser is on its own copy. */
        const seed = await fetchSeedRoster();
        if (dead) return;
        if (seed) {
          setRiders(seed.riders);
          if (seed.photoDir) setPhotoDir(seed.photoDir);
          firstSave.current = false;
        }
      }
      setLoaded(true);
      const mode = await probeStorage();
      if (!dead) setStorageMode(mode);
    })();
    return () => {
      dead = true;
    };
  }, []);

  /* ---- persist roster (debounced) ---- */
  useEffect(() => {
    if (!loaded) return;
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      sSet(ROSTER_KEY, { riders, photoDir });
    }, 500);
    return () => clearTimeout(saveTimer.current);
  }, [riders, photoDir, loaded]);

  const ensureBucket = useCallback(async (b) => {
    if (bucketsRef.current[b]) return bucketsRef.current[b];
    const data = (await sGet(pbKey(b))) || {};
    bucketsRef.current[b] = data;
    return data;
  }, []);

  /* ---- background photo load ---- */
  useEffect(() => {
    if (!loaded) return;
    let dead = false;
    (async () => {
      const need = [
        ...new Set(riders.filter((r) => r.stored).map((r) => r.b)),
      ].filter((b) => !bucketsRef.current[b]);
      for (const b of need) {
        if (dead) return;
        const data = await ensureBucket(b);
        if (dead) return;
        setPhotos((p) => ({ ...p, ...data }));
        await sleep(50);
      }
    })();
    return () => {
      dead = true;
    };
  }, [loaded, riders.length, ensureBucket]);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  /* ---- mutations ---- */
  const addRiders = useCallback((list) => {
    setRiders((rs) => {
      let seq = rs.reduce((m, r) => Math.max(m, (r.seq || 0) + 1), 0);
      const made = list.map((r) => {
        const rider = {
          id: uid(),
          seq,
          b: Math.floor(seq / BUCKET),
          last: r.last,
          first: r.first || "",
          country: (r.country || "").toUpperCase(),
          cat: r.cat || "Men Elite",
          note: r.note || "",
          box: 0,
          seen: 0,
          hits: 0,
          stored: false,
        };
        seq++;
        return rider;
      });
      return [...rs, ...made];
    });
  }, []);

  const updateRider = useCallback((id, patch) => {
    setRiders((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const savePhoto = useCallback(
    async (rider, url) => {
      const bucket = await ensureBucket(rider.b);
      bucket[rider.id] = url;
      bucketsRef.current[rider.b] = bucket;
      const ok = await sSet(pbKey(rider.b), bucket);
      setPhotos((p) => ({ ...p, [rider.id]: url }));
      updateRider(rider.id, { stored: true });
      if (!ok) flash("Photo shown but not saved — storage is full or offline.");
    },
    [ensureBucket, updateRider]
  );

  /* One storage write per bucket instead of one per photo. */
  const savePhotoBatch = useCallback(
    async (entries) => {
      const byBucket = new Map();
      for (const e of entries) {
        if (!byBucket.has(e.rider.b)) byBucket.set(e.rider.b, []);
        byBucket.get(e.rider.b).push(e);
      }
      const added = {};
      let failed = 0;
      for (const [b, list] of byBucket) {
        const bucket = await ensureBucket(b);
        for (const e of list) {
          bucket[e.rider.id] = e.url;
          added[e.rider.id] = e.url;
        }
        bucketsRef.current[b] = bucket;
        const ok = await sSet(pbKey(b), bucket);
        if (!ok) failed += list.length;
      }
      setPhotos((p) => ({ ...p, ...added }));
      const ids = new Set(entries.map((e) => e.rider.id));
      setRiders((rs) =>
        rs.map((r) => (ids.has(r.id) ? { ...r, stored: true } : r))
      );
      return { saved: entries.length - failed, failed };
    },
    [ensureBucket]
  );

  const exportBackup = useCallback(async () => {
    /* Riders reference folder photos by filename, so those stay out of the
       file entirely. Only photos uploaded through the app are embedded. */
    const buckets = [...new Set(riders.filter((r) => r.stored).map((r) => r.b))];
    const all = {};
    for (const b of buckets) Object.assign(all, await ensureBucket(b));
    const payload = {
      app: "visages-du-peloton",
      version: 2,
      exported: new Date().toISOString(),
      photoDir,
      riders,
      photos: all,
    };
    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `visages-du-peloton-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    flash(`Backup of ${riders.length} riders downloaded.`);
  }, [riders, photoDir, ensureBucket]);

  const restoreBackup = useCallback(
    async (payload) => {
      if (!payload || !Array.isArray(payload.riders))
        throw new Error("That file isn't a Visages du peloton backup.");
      if (payload.photoDir) setPhotoDir(payload.photoDir);
      for (const b of [...new Set(riders.map((r) => r.b))])
        await sDel(pbKey(b));
      bucketsRef.current = {};

      const incoming = payload.riders.map((r, i) => ({
        ...r,
        seq: typeof r.seq === "number" ? r.seq : i,
        b: typeof r.b === "number" ? r.b : Math.floor(i / BUCKET),
      }));
      const photosIn = payload.photos || {};
      const byBucket = {};
      for (const r of incoming) {
        const u = photosIn[r.id];
        if (!u) continue;
        if (!byBucket[r.b]) byBucket[r.b] = {};
        byBucket[r.b][r.id] = u;
      }
      for (const b of Object.keys(byBucket)) {
        bucketsRef.current[b] = byBucket[b];
        await sSet(pbKey(Number(b)), byBucket[b]);
      }
      setPhotos(photosIn);
      setRiders(
        incoming.map((r) => ({ ...r, stored: !!photosIn[r.id] }))
      );
      flash(`Restored ${incoming.length} riders.`);
    },
    [riders]
  );

  const removePhoto = useCallback(
    async (rider) => {
      const bucket = await ensureBucket(rider.b);
      delete bucket[rider.id];
      bucketsRef.current[rider.b] = bucket;
      await sSet(pbKey(rider.b), bucket);
      setPhotos((p) => {
        const n = { ...p };
        delete n[rider.id];
        return n;
      });
      updateRider(rider.id, { stored: false });
    },
    [ensureBucket, updateRider]
  );

  const deleteRider = useCallback(
    async (rider) => {
      await removePhoto(rider);
      setRiders((rs) => rs.filter((r) => r.id !== rider.id));
    },
    [removePhoto]
  );

  const resetAllProgress = useCallback(() => {
    setRiders((rs) =>
      rs.map((r) => ({ ...r, box: 0, seen: 0, hits: 0 }))
    );
    flash("Progress reset. Photos and riders kept.");
  }, []);

  /* ---- photo folder ---- */
  /* Scanning only reads the directory. Which file belongs to which rider is
     derived below, so it stays correct when the roster changes afterwards. */
  const scanFolder = useCallback(
    async (dir, quiet) => {
      const target = (dir || photoDir || DEFAULT_DIR).trim() || DEFAULT_DIR;
      setFolder((f) => ({ ...f, state: "scanning", msg: "" }));
      try {
        const { base, files, via } = await listFolder(target);
        setPhotoDir(base);
        setFolder({ state: "ok", files, via, msg: "" });
        if (!quiet) flash(`${files.length} images found in ${base}.`);
      } catch (err) {
        setFolder({ state: "error", files: [], via: "", msg: err.message });
        if (!quiet) flash(err.message);
      }
    },
    [photoDir]
  );

  /* Scan once on boot so the folder is just there. */
  useEffect(() => {
    if (!loaded) return;
    scanFolder(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const mapFile = useCallback((riderId, file) => {
    setRiders((rs) =>
      rs.map((r) => {
        if (r.id === riderId) return { ...r, file: file || undefined };
        // a file belongs to one rider only
        if (file && r.file === file) return { ...r, file: undefined };
        return r;
      })
    );
  }, []);

  /* ---- derived ---- */
  /* file <-> rider mapping, recomputed whenever either side changes */
  const resolution = useMemo(
    () => resolveFolder(riders, folder.files),
    [riders, folder.files]
  );

  /* Folder files resolve to plain URLs; uploaded photos stay as data URLs.
     Folder wins, because it's the live source of truth on disk. */
  const pics = useMemo(() => {
    const out = { ...photos };
    for (const id of Object.keys(resolution.byId)) {
      out[id] = photoDir + resolution.byId[id];
    }
    return out;
  }, [photos, resolution, photoDir]);

  const riderList = useMemo(
    () => riders.map((r) => ({ ...r, hasPhoto: !!pics[r.id] })),
    [riders, pics]
  );

  const withPhoto = riderList.filter((r) => r.hasPhoto).length;
  const ladder = useMemo(() => {
    const n = riders.length || 1;
    return [1, 2, 3, 4, 5].map(
      (lvl) => riders.filter((r) => (r.box || 0) >= lvl).length / n
    );
  }, [riders]);

  if (!loaded) {
    return (
      <div className="mz-root mz-center">
        <Styles />
        <div className="mz-loading">Loading your roster…</div>
      </div>
    );
  }

  return (
    <div className="mz-root">
      <Styles />

      <header className="mz-head">
        <div className="mz-ladder" aria-hidden="true">
          {BANDS.map((c, i) => (
            <span key={i} className="mz-ladder-seg">
              <span
                className="mz-ladder-fill"
                style={{ background: c, transform: `scaleX(${ladder[i]})` }}
              />
            </span>
          ))}
        </div>
        <div className="mz-head-row">
          <div>
            <div className="mz-eyebrow">UCI Road World Championships · Montréal 2026</div>
            <h1 className="mz-title">Visages du peloton</h1>
          </div>
          <div className="mz-count">
            <strong>{riders.length}</strong>
            <span>riders</span>
          </div>
        </div>
        <div className="mz-substat">
          {withPhoto} with photos · {riders.length - withPhoto} still need one
        </div>
        {storageMode === "memory" && (
          <div className="mz-alert">
            Nothing can be saved from a <span className="mz-mono">file://</span>{" "}
            page. Serve the folder instead — <span className="mz-mono">
            python3 -m http.server 8000</span> — then open{" "}
            <span className="mz-mono">localhost:8000</span>.
          </div>
        )}
      </header>

      <nav className="mz-tabs" role="tablist">
        {[
          ["study", "Drill"],
          ["roster", "Roster"],
          ["add", "Add"],
          ["photos", "Photos"],
        ].map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={`mz-tab ${tab === k ? "is-on" : ""}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="mz-main">
        {riders.length === 0 ? (
          <EmptyState
            onSeed={() =>
              addRiders(
                SEED.map(([last, first, country, cat]) => ({
                  last,
                  first,
                  country,
                  cat,
                }))
              )
            }
            onManual={() => setTab("add")}
          />
        ) : (
          <>
            <div className={tab === "study" ? "" : "mz-hide"}>
              <Drill
                riders={riderList}
                photos={pics}
                onGrade={(id, ok) =>
                  setRiders((rs) =>
                    rs.map((r) =>
                      r.id === id
                        ? {
                            ...r,
                            box: ok ? Math.min(5, (r.box || 0) + 1) : 1,
                            seen: (r.seen || 0) + 1,
                            hits: (r.hits || 0) + (ok ? 1 : 0),
                          }
                        : r
                    )
                  )
                }
                goAdd={() => setTab("add")}
                onOpenProfile={openProfile}
              />
            </div>
            <div className={tab === "roster" ? "" : "mz-hide"}>
              <Roster
                riders={riderList}
                photos={pics}
                folderFiles={folder.files}
                onMapFile={mapFile}
                focus={focus}
                onFocusReturn={returnFromProfile}
                onSavePhoto={savePhoto}
                onRemovePhoto={removePhoto}
                onUpdate={updateRider}
                onDelete={deleteRider}
                onResetAll={resetAllProgress}
                flash={flash}
              />
            </div>
            <div className={tab === "add" ? "" : "mz-hide"}>
              <AddPanel
                riders={riderList}
                onAdd={addRiders}
                flash={flash}
                goRoster={() => setTab("roster")}
              />
            </div>
            <div className={tab === "photos" ? "" : "mz-hide"}>
              <PhotosPanel
                riders={riderList}
                photoDir={photoDir}
                setPhotoDir={setPhotoDir}
                folder={folder}
                resolution={resolution}
                onScan={scanFolder}
                onMapFile={mapFile}
                onSaveBatch={savePhotoBatch}
                onExport={exportBackup}
                onRestore={restoreBackup}
                flash={flash}
              />
            </div>
          </>
        )}
      </main>

      {toast && <div className="mz-toast">{toast}</div>}
    </div>
  );
}

/* ============================================================
   Empty state
   ============================================================ */
function EmptyState({ onSeed, onManual }) {
  return (
    <div className="mz-empty">
      <Jersey box={0} size="lg" />
      <h2>Start with a roster, then attach faces.</h2>
      <p>
        Load a starter list of well-known elite contenders, or build your own from
        the nations you're assigned to. Photos come from you — the app handles the
        drilling.
      </p>
      <button className="mz-btn mz-btn-go" onClick={onSeed}>
        Load starter list (56 riders)
      </button>
      <button className="mz-btn mz-btn-ghost" onClick={onManual}>
        Add riders myself
      </button>
    </div>
  );
}

/* ============================================================
   Drill
   ============================================================ */
const MODES = [
  ["face", "Face → name"],
  ["choice", "Multiple choice"],
  ["name", "Name → face"],
];

function Drill({ riders, photos, onGrade, goAdd, onOpenProfile }) {
  const [mode, setMode] = useState("face");
  const [cat, setCat] = useState("all");
  const [country, setCountry] = useState("all");
  const [curId, setCurId] = useState(null);
  const [shown, setShown] = useState(false);
  const [picked, setPicked] = useState(null);
  const [session, setSession] = useState({ seen: 0, right: 0 });

  const countries = useMemo(
    () => [...new Set(riders.map((r) => r.country).filter(Boolean))].sort(),
    [riders]
  );

  const pool = useMemo(
    () =>
      riders.filter(
        (r) =>
          r.hasPhoto &&
          photos[r.id] &&
          (cat === "all" || r.cat === cat) &&
          (country === "all" || r.country === country)
      ),
    [riders, photos, cat, country]
  );

  const poolKey = useMemo(
    () => pool.map((r) => r.id).sort().join(","),
    [pool]
  );

  const [queue, setQueue] = useState([]);
  const [started, setStarted] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [tally, setTally] = useState({});
  const [summary, setSummary] = useState(null);

  /* mirror of live state, so the pool-change effect can read it without re-firing */
  const live = useRef({});
  live.current = { started, tally, curId };

  /* Pool changed mid-session (photo added, rider deleted): patch the queue in
     place rather than rebuilding it, so nobody already seen comes back. */
  useEffect(() => {
    if (!pool.length) {
      setQueue([]);
      setCurId(null);
      setStarted(false);
      return;
    }
    if (!live.current.started) return;
    const ids = new Set(pool.map((r) => r.id));
    const seenIds = new Set(Object.keys(live.current.tally));
    setQueue((q) => {
      const kept = q.filter((id) => ids.has(id));
      const known = new Set([...kept, ...seenIds, live.current.curId]);
      const added = pool.filter((r) => !known.has(r.id)).map((r) => r.id);
      return added.length ? [...kept, ...shuffle(added)] : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey]);

  const cur = pool.find((r) => r.id === curId) || null;

  const choices = useMemo(() => {
    if (!cur || mode !== "choice") return [];
    const same = riders.filter((r) => r.id !== cur.id && r.cat === cur.cat);
    const any = riders.filter((r) => r.id !== cur.id);
    const src = same.length >= 3 ? same : any;
    return shuffle([cur, ...shuffle(src).slice(0, 3)]);
  }, [cur, mode, riders]);

  const advance = (ok) => {
    if (!cur) return;
    const boxBefore = cur.box || 0;
    const boxAfter = ok ? Math.min(5, boxBefore + 1) : 1;
    onGrade(cur.id, ok);

    const nextSession = {
      seen: session.seen + 1,
      right: session.right + (ok ? 1 : 0),
    };
    const nextTally = {
      ...tally,
      [cur.id]: {
        right: ok ? 1 : 0,
        boxStart: boxBefore,
        boxEnd: boxAfter,
      },
    };
    setSession(nextSession);
    setTally(nextTally);
    setShown(false);
    setPicked(null);

    // Every rider appears once per session. Empty queue means we're done.
    if (queue.length === 0) {
      finish(nextSession, nextTally, true);
      return;
    }
    setCurId(queue[0]);
    setQueue(queue.slice(1));
  };

  const reshuffle = () => {
    setQueue((q) => shuffle(q));
  };

  const beginSession = () => {
    if (!pool.length) return;
    const q = weightedOrder(pool);
    setCurId(q[0]);
    setQueue(q.slice(1));
    setSession({ seen: 0, right: 0 });
    setStartedAt(Date.now());
    setStarted(true);
    setTally({});
    setSummary(null);
    setShown(false);
    setPicked(null);
  };

  const finish = (finalSession, finalTally, completed) => {
    const ms = startedAt ? Date.now() - startedAt : 0;
    setLastResult({ seen: finalSession.seen, right: finalSession.right, ms });
    setSummary({
      seen: finalSession.seen,
      right: finalSession.right,
      ms,
      completed,
      tally: finalTally,
    });
    setStarted(false);
    setShown(false);
    setPicked(null);
  };

  const endSession = () => finish(session, tally, false);

  if (!riders.some((r) => r.hasPhoto)) {
    return (
      <div className="mz-empty">
        <h2>No faces yet.</h2>
        <p>
          Open <strong>Roster</strong>, tap a rider and attach a photo from your
          phone. Once one rider has a face, drilling starts.
        </p>
        <button className="mz-btn mz-btn-go" onClick={goAdd}>
          Where to find photos
        </button>
      </div>
    );
  }

  if (!pool.length) {
    return (
      <div className="mz-panel">
        <FilterBar
          cat={cat}
          setCat={setCat}
          country={country}
          setCountry={setCountry}
          countries={countries}
        />
        <p className="mz-note">
          No riders with photos match this filter. Widen it, or add photos to these
          riders in the Roster tab.
        </p>
      </div>
    );
  }

  const pct = session.seen ? Math.round((session.right / session.seen) * 100) : null;
  const total = session.seen + queue.length + (cur ? 1 : 0);

  return (
    <div className="mz-drill">
      <div className="mz-modes">
        {MODES.map(([k, label]) => (
          <button
            key={k}
            className={`mz-chip ${mode === k ? "is-on" : ""}`}
            onClick={() => {
              setMode(k);
              setShown(false);
              setPicked(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <FilterBar
        cat={cat}
        setCat={setCat}
        country={country}
        setCountry={setCountry}
        countries={countries}
        disabled={started}
      />

      {!started ? (
        summary ? (
          <SessionSummary
            summary={summary}
            riders={riders}
            photos={photos}
            onOpenProfile={onOpenProfile}
            onAgain={beginSession}
            onDismiss={() => setSummary(null)}
          />
        ) : (
          <StartPanel
            pool={pool}
            lastResult={lastResult}
            onStart={beginSession}
          />
        )
      ) : (
        <>
          <div className="mz-progress" aria-hidden="true">
            <span
              className="mz-progress-fill"
              style={{ transform: `scaleX(${total ? session.seen / total : 0})` }}
            />
          </div>

          <div className="mz-session">
            <span>
              <strong>{session.seen}</strong> / {total}
            </span>
            <span>
              <strong>{queue.length}</strong> to go
            </span>
            {pct !== null && (
              <span>
                <strong>{pct}%</strong> correct
              </span>
            )}
          </div>

          <div className="mz-sessionctl">
            <button className="mz-link" onClick={reshuffle}>
              Shuffle rest
            </button>
            <button className="mz-link" onClick={beginSession}>
              Restart session
            </button>
            <button className="mz-link mz-end" onClick={endSession}>
              End session
            </button>
          </div>
        </>
      )}

      {started && cur && (
        <div className="mz-card" key={cur.id}>
          {mode === "name" && !shown ? (
            <div className="mz-nameprompt">
              <div className="mz-surname">{cur.last}</div>
              <div className="mz-given">{cur.first}</div>
              <div className="mz-tri">
                {flagOf(cur.country)} <span>{cur.country}</span>
              </div>
              <p className="mz-recall">Picture the face, then check.</p>
            </div>
          ) : (
            <div className="mz-photo">
              <img src={photos[cur.id]} alt="" />
            </div>
          )}

          <div className="mz-cardfoot">
            <Jersey box={cur.box || 0} />
            <span className="mz-cat">{cur.cat}</span>
          </div>

          {mode === "choice" ? (
            <div className="mz-choices">
              {choices.map((c) => {
                const state =
                  picked == null
                    ? ""
                    : c.id === cur.id
                    ? "is-right"
                    : c.id === picked
                    ? "is-wrong"
                    : "is-dim";
                return (
                  <button
                    key={c.id}
                    className={`mz-choice ${state}`}
                    disabled={picked != null}
                    onClick={() => setPicked(c.id)}
                  >
                    <span className="mz-choice-last">{c.last}</span>
                    <span className="mz-choice-first">{c.first}</span>
                  </button>
                );
              })}
              {picked != null && (
                <>
                  <button
                    className="mz-openprofile"
                    onClick={() => onOpenProfile(cur.id)}
                  >
                    Open {cur.last} in the roster ↗
                  </button>
                  <button
                    className="mz-btn mz-btn-go"
                    onClick={() => advance(picked === cur.id)}
                  >
                    Next rider
                  </button>
                </>
              )}
            </div>
          ) : !shown ? (
            <button className="mz-btn mz-btn-go" onClick={() => setShown(true)}>
              {mode === "name" ? "Show the face" : "Show the name"}
            </button>
          ) : (
            <>
              <div className="mz-answer">
                <button
                  className="mz-namelink"
                  onClick={() => onOpenProfile(cur.id)}
                  title="Open this rider in the roster"
                >
                  <span className="mz-surname">{cur.last}</span>
                  <span className="mz-arrow" aria-hidden="true">↗</span>
                  <span className="mz-given">
                    {cur.first} <span className="mz-dot">·</span>{" "}
                    <span className="mz-mono">
                      {flagOf(cur.country)} {cur.country}
                    </span>
                  </span>
                </button>
                {cur.note && <div className="mz-tell">{cur.note}</div>}
              </div>
              <div className="mz-grade">
                <button className="mz-btn mz-btn-miss" onClick={() => advance(false)}>
                  Missed it
                </button>
                <button className="mz-btn mz-btn-hit" onClick={() => advance(true)}>
                  Knew it
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtDur(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m ? `${m} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
}

function SessionSummary({
  summary,
  riders,
  photos,
  onOpenProfile,
  onAgain,
  onDismiss,
}) {
  const { seen, right, ms, completed, tally } = summary;

  if (!seen) {
    return (
      <div className="mz-start">
        <p className="mz-note">
          That session ended before any cards were graded, so there's nothing to
          report.
        </p>
        <button className="mz-btn mz-btn-go" onClick={onAgain}>
          Start a drill
        </button>
      </div>
    );
  }

  const byId = Object.fromEntries(riders.map((r) => [r.id, r]));
  const entries = Object.entries(tally)
    .map(([id, t]) => ({ ...t, id, rider: byId[id] }))
    .filter((e) => e.rider);

  const accuracy = Math.round((right / seen) * 100);
  const perCard = ms / seen;
  const levelled = entries.filter((e) => e.boxEnd > e.boxStart).length;
  const dropped = entries.filter((e) => e.boxEnd < e.boxStart).length;
  const toRainbow = entries.filter(
    (e) => e.boxEnd >= 5 && e.boxStart < 5
  ).length;

  const trouble = entries
    .filter((e) => !e.right)
    .sort((a, b) => a.rider.last.localeCompare(b.rider.last, "fr"));
  const clean = entries
    .filter((e) => e.right)
    .sort((a, b) => a.rider.last.localeCompare(b.rider.last, "fr"));

  return (
    <div className="mz-summary">
      <div className="mz-eyebrow">
        {completed ? "Session complete" : "Session ended early"}
      </div>

      <div className="mz-startstats">
        <div className="mz-startstat">
          <strong>{seen}</strong>
          <span>cards</span>
        </div>
        <div className="mz-startstat">
          <strong>{accuracy}%</strong>
          <span>correct</span>
        </div>
        <div className="mz-startstat">
          <strong>{fmtDur(ms)}</strong>
          <span>elapsed</span>
        </div>
      </div>

      <div className="mz-sumline">
        {completed
          ? `Every rider in the pool covered once · ${(perCard / 1000).toFixed(1)} s per face`
          : `${(perCard / 1000).toFixed(1)} s per face`}
      </div>

      <div className="mz-sumbands">
        <Jersey box={Math.min(5, Math.round((accuracy / 100) * 5))} size="lg" />
        <div>
          <div className="mz-sumbands-main">
            {levelled} moved up{toRainbow > 0 && `, ${toRainbow} to full rainbow`}
          </div>
          {dropped > 0 && (
            <div className="mz-sumbands-sub">{dropped} dropped back to band one</div>
          )}
        </div>
      </div>

      {trouble.length > 0 && (
        <section className="mz-sumsection">
          <h4 className="mz-sumhead">
            Faces that caught you out{" "}
            <span className="mz-mono">({trouble.length})</span>
          </h4>
          <div className="mz-sumlist">
            {trouble.map((e) => (
              <button
                key={e.id}
                className="mz-sumrow"
                onClick={() => onOpenProfile(e.id)}
              >
                <span className="mz-sumthumb">
                  {photos[e.id] ? <img src={photos[e.id]} alt="" /> : null}
                </span>
                <span className="mz-sumname">
                  <span className="mz-sumlast">{e.rider.last}</span>
                  <span className="mz-sumsub">
                    {e.rider.first} · {e.rider.country}
                  </span>
                </span>
                <span className="mz-summiss">Missed</span>
              </button>
            ))}
          </div>
          <p className="mz-note mz-sumtip">
            Tap a rider to add a tell — the detail you wish you'd noticed.
          </p>
        </section>
      )}

      {clean.length > 0 && (
        <section className="mz-sumsection">
          <h4 className="mz-sumhead">
            Recognised <span className="mz-mono">({clean.length})</span>
          </h4>
          <div className="mz-sumchips">
            {clean.map((e) => (
              <span key={e.id} className="mz-sumchip">
                {e.rider.last}
              </span>
            ))}
          </div>
        </section>
      )}

      <button className="mz-btn mz-btn-go" onClick={onAgain}>
        Drill again
      </button>
      <button className="mz-btn mz-btn-ghost" onClick={onDismiss}>
        Back to setup
      </button>
    </div>
  );
}

function StartPanel({ pool, lastResult, onStart }) {
  const fresh = pool.filter((r) => !r.box).length;
  const learning = pool.filter((r) => (r.box || 0) > 0 && (r.box || 0) < 5).length;
  const owned = pool.filter((r) => (r.box || 0) >= 5).length;

  return (
    <div className="mz-start">
      {lastResult && lastResult.seen > 0 && (
        <div className="mz-lastrun">
          <div className="mz-eyebrow">Last session</div>
          <div className="mz-lastrun-row">
            <span>
              <strong>{lastResult.seen}</strong> cards
            </span>
            <span>
              <strong>
                {Math.round((lastResult.right / lastResult.seen) * 100)}%
              </strong>{" "}
              correct
            </span>
            <span>{fmtDur(lastResult.ms)}</span>
          </div>
        </div>
      )}

      <div className="mz-startstats">
        <div className="mz-startstat">
          <strong>{fresh}</strong>
          <span>never seen</span>
        </div>
        <div className="mz-startstat">
          <strong>{learning}</strong>
          <span>learning</span>
        </div>
        <div className="mz-startstat">
          <strong>{owned}</strong>
          <span>rainbow</span>
        </div>
      </div>

      <button className="mz-btn mz-btn-go" onClick={onStart}>
        Start drill · {pool.length} riders
      </button>
      <p className="mz-note mz-startnote">
        Set the mode and filters above first. Each session shuffles the whole pool
        into rounds, so you see every rider before anyone repeats.
      </p>
    </div>
  );
}

function FilterBar({ cat, setCat, country, setCountry, countries, disabled }) {
  return (
    <div className={`mz-filters ${disabled ? "is-locked" : ""}`}>
      <select
        className="mz-select"
        value={cat}
        disabled={disabled}
        onChange={(e) => setCat(e.target.value)}
      >
        <option value="all">All categories</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        className="mz-select"
        value={country}
        disabled={disabled}
        onChange={(e) => setCountry(e.target.value)}
      >
        <option value="all">All nations</option>
        {countries.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ============================================================
   Roster
   ============================================================ */
function Roster({
  riders,
  photos,
  folderFiles,
  onMapFile,
  focus,
  onFocusReturn,
  onSavePhoto,
  onRemovePhoto,
  onUpdate,
  onDelete,
  onResetAll,
  flash,
}) {
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const cameFromDrill = useRef(false);

  useEffect(() => {
    if (focus && focus.id) {
      setOpenId(focus.id);
      cameFromDrill.current = true;
    }
  }, [focus]);

  const closeSheet = useCallback(() => {
    setOpenId(null);
    if (cameFromDrill.current) {
      cameFromDrill.current = false;
      onFocusReturn();
    }
  }, [onFocusReturn]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return riders
      .filter((r) => (onlyMissing ? !r.hasPhoto : true))
      .filter(
        (r) =>
          !needle ||
          `${r.last} ${r.first} ${r.country}`.toLowerCase().includes(needle)
      )
      .sort((a, b) => a.last.localeCompare(b.last, "fr"));
  }, [riders, q, onlyMissing]);

  const open = riders.find((r) => r.id === openId) || null;

  return (
    <div className="mz-panel">
      <div className="mz-searchrow">
        <input
          className="mz-input"
          placeholder="Search name or nation"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button
          className={`mz-chip ${onlyMissing ? "is-on" : ""}`}
          onClick={() => setOnlyMissing((v) => !v)}
        >
          No photo
        </button>
      </div>

      <div className="mz-grid">
        {list.map((r) => (
          <button key={r.id} className="mz-tile" onClick={() => setOpenId(r.id)}>
            <span className="mz-thumb">
              {photos[r.id] ? (
                <img src={photos[r.id]} alt="" />
              ) : (
                <span className="mz-thumb-empty">+ photo</span>
              )}
            </span>
            <span className="mz-tile-name">{r.last}</span>
            <span className="mz-tile-sub">
              <span className="mz-mono">{r.country}</span>
              <Jersey box={r.box || 0} />
            </span>
          </button>
        ))}
      </div>

      {list.length === 0 && (
        <p className="mz-note">Nothing matches. Clear the search or the filter.</p>
      )}

      <div className="mz-danger">
        {!confirmReset ? (
          <button className="mz-btn mz-btn-ghost" onClick={() => setConfirmReset(true)}>
            Reset progress on all riders
          </button>
        ) : (
          <div className="mz-confirm">
            <span>
              Every rider drops back to zero rainbow bands. Riders, photos and your
              notes are kept.
            </span>
            <div className="mz-confirm-row">
              <button className="mz-btn mz-btn-ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button
                className="mz-btn mz-btn-go"
                onClick={() => {
                  onResetAll();
                  setConfirmReset(false);
                }}
              >
                Reset all progress
              </button>
            </div>
          </div>
        )}

      </div>

      {open && (
        <RiderSheet
          rider={open}
          photo={photos[open.id]}
          folderFiles={folderFiles}
          onMapFile={onMapFile}
          backToDrill={cameFromDrill.current}
          onClose={closeSheet}
          onSavePhoto={onSavePhoto}
          onRemovePhoto={onRemovePhoto}
          onUpdate={onUpdate}
          onDelete={(r) => {
            onDelete(r);
            closeSheet();
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

function RiderSheet({
  rider,
  photo,
  folderFiles,
  onMapFile,
  backToDrill,
  onClose,
  onSavePhoto,
  onRemovePhoto,
  onUpdate,
  onDelete,
  flash,
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setBusy(true);
    try {
      const data = await fileToDataUrl(f);
      await onSavePhoto(rider, data);
    } catch (err) {
      flash(err.message);
    }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="mz-sheet-wrap" onClick={onClose}>
      <div className="mz-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="mz-sheet-head">
          <div>
            <div className="mz-surname sm">{rider.last}</div>
            <div className="mz-given">
              {rider.first} <span className="mz-mono">· {flagOf(rider.country)} {rider.country}</span>
            </div>
          </div>
          <button
            className="mz-x"
            onClick={onClose}
            aria-label={backToDrill ? "Back to drill" : "Close"}
          >
            ×
          </button>
        </div>

        <div className="mz-sheet-photo">
          {photo ? <img src={photo} alt="" /> : <span className="mz-thumb-empty">No photo yet</span>}
        </div>

        {folderFiles && folderFiles.length > 0 && (
          <label className="mz-field mz-mt">
            <span>Photo file in folder</span>
            <select
              className="mz-select full"
              value={rider.file || ""}
              onChange={(e) => onMapFile(rider.id, e.target.value)}
            >
              <option value="">— none —</option>
              {folderFiles.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="mz-btn mz-btn-ghost mz-filelabel">
          {busy ? "Processing…" : "Upload a photo instead"}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            hidden
          />
        </label>

        <div className="mz-urlrow">
          <input
            className="mz-input"
            placeholder="…or paste an image link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            className="mz-btn mz-btn-ghost sm"
            onClick={() => {
              const u = url.trim();
              if (!/^https?:\/\//i.test(u)) {
                flash("That link needs to start with http:// or https://");
                return;
              }
              onSavePhoto(rider, u);
              setUrl("");
            }}
          >
            Use
          </button>
        </div>

        <div className="mz-fields">
          <Field label="Surname" value={rider.last} onChange={(v) => onUpdate(rider.id, { last: v })} />
          <Field label="First name" value={rider.first} onChange={(v) => onUpdate(rider.id, { first: v })} />
          <Field
            label="Nation code"
            value={rider.country}
            onChange={(v) => onUpdate(rider.id, { country: v.toUpperCase().slice(0, 3) })}
          />
          <label className="mz-field">
            <span>Category</span>
            <select
              className="mz-select full"
              value={rider.cat}
              onChange={(e) => onUpdate(rider.id, { cat: e.target.value })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="Your own tell (glasses, jawline, hair…)"
            value={rider.note || ""}
            onChange={(v) => onUpdate(rider.id, { note: v })}
          />
        </div>

        <div className="mz-sheet-stats">
          <Jersey box={rider.box || 0} size="lg" />
          <span>
            Seen {rider.seen || 0}× · {rider.hits || 0} correct
          </span>
          <button className="mz-link" onClick={() => onUpdate(rider.id, { box: 0, seen: 0, hits: 0 })}>
            Reset progress
          </button>
        </div>

        {backToDrill && (
          <button className="mz-btn mz-btn-ghost mz-backdrill" onClick={onClose}>
            ← Back to drill
          </button>
        )}

        <div className="mz-sheet-foot">
          {photo && (
            <button className="mz-btn mz-btn-ghost sm" onClick={() => onRemovePhoto(rider)}>
              Remove photo
            </button>
          )}
          {!confirmDel ? (
            <button className="mz-btn mz-btn-ghost sm" onClick={() => setConfirmDel(true)}>
              Delete rider
            </button>
          ) : (
            <button className="mz-btn mz-btn-miss sm" onClick={() => onDelete(rider)}>
              Confirm delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }) {
  return (
    <label className="mz-field">
      <span>{label}</span>
      <input className="mz-input full" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/* ============================================================
   Add
   ============================================================ */
function PhotosPanel({
  riders,
  photoDir,
  setPhotoDir,
  folder,
  resolution,
  onScan,
  onMapFile,
  onSaveBatch,
  onExport,
  onRestore,
  flash,
}) {
  const [dirInput, setDirInput] = useState(photoDir);
  const [confirmRestore, setConfirmRestore] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const jsonRef = useRef(null);

  useEffect(() => setDirInput(photoDir), [photoDir]);

  const sorted = useMemo(
    () => [...riders].sort((a, b) => a.last.localeCompare(b.last, "fr")),
    [riders]
  );
  const missing = sorted.filter((r) => !r.hasPhoto);
  const linked = Object.keys(resolution.byId).length;
  const unmatched = resolution.unmatched;

  const readJson = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setConfirmRestore(JSON.parse(reader.result));
      } catch (err) {
        flash("That file isn't valid JSON.");
      }
    };
    reader.readAsText(f);
    if (jsonRef.current) jsonRef.current.value = "";
  };

  return (
    <div className="mz-panel">
      <section className="mz-block">
        <h3 className="mz-h3">Photo folder</h3>
        <p className="mz-note">
          Put your images in a folder next to the app and the roster reads them
          straight off disk. Nothing is copied into the app — riders store only a
          filename, matched on surname. Add or replace a file, hit Rescan, done.
        </p>

        <div className="mz-formrow">
          <input
            className="mz-input"
            value={dirInput}
            onChange={(e) => setDirInput(e.target.value)}
            placeholder="photos/"
            spellCheck={false}
          />
          <button
            className="mz-btn mz-btn-go sm"
            onClick={() => onScan(dirInput)}
            disabled={folder.state === "scanning"}
          >
            {folder.state === "scanning" ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {folder.state === "ok" && (
          <div className="mz-matchbar">
            <span>
              <strong>{folder.files.length}</strong> files
            </span>
            <span>
              <strong>{linked}</strong> linked
            </span>
            {unmatched.length > 0 && (
              <span className="mz-warn">
                <strong>{unmatched.length}</strong> unclaimed
              </span>
            )}
            <span className="mz-mono mz-via">via {folder.via}</span>
          </div>
        )}

        {folder.state === "error" && (
          <div className="mz-alert mz-alert-inline">
            {folder.msg}
            <div className="mz-alertsub">
              Create a <span className="mz-mono">photos/</span> folder beside the
              HTML file and serve it with{" "}
              <span className="mz-mono">python3 -m http.server 8000</span>. Inside
              Claude there's no filesystem, so use the upload fallback below.
            </div>
          </div>
        )}

        {unmatched.length > 0 && (
          <>
            <h4 className="mz-sumhead mz-mt">
              Files with no rider{" "}
              <span className="mz-mono">({unmatched.length})</span>
            </h4>
            <div className="mz-matchlist">
              {unmatched.map((u) => (
                <div key={u.file} className="mz-matchrow is-unmatched">
                  <span className="mz-matchfile" title={u.file}>
                    {u.file}
                    {u.why === "ambiguous" && (
                      <em className="mz-why"> two riders share this surname</em>
                    )}
                  </span>
                  <select
                    className="mz-select"
                    value=""
                    onChange={(e) =>
                      e.target.value && onMapFile(e.target.value, u.file)
                    }
                  >
                    <option value="">— assign to —</option>
                    {sorted.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.last}
                        {r.first ? `, ${r.first}` : ""}
                        {r.country ? ` (${r.country})` : ""}
                        {r.hasPhoto ? " ✓" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </>
        )}

        {folder.state === "ok" && missing.length > 0 && (
          <>
            <h4 className="mz-sumhead mz-mt">
              Riders with no photo{" "}
              <span className="mz-mono">({missing.length})</span>
            </h4>
            <div className="mz-chipwrap">
              {missing.slice(0, 60).map((r) => (
                <span key={r.id} className="mz-sumchip mz-chip-warn">
                  {r.last}
                </span>
              ))}
              {missing.length > 60 && (
                <span className="mz-sumchip">+{missing.length - 60} more</span>
              )}
            </div>
            <p className="mz-note mz-sumtip">
              Name a file after the surname and it links on the next rescan —
              e.g. <span className="mz-mono">{missing[0].last}.jpg</span>.
            </p>
          </>
        )}
      </section>

      <section className="mz-block">
        <h3 className="mz-h3">Backup &amp; restore</h3>
        <p className="mz-note">
          Saves riders, filenames and progress. Folder photos aren't copied in —
          the file stays small, and your images stay images.
        </p>
        <button className="mz-btn mz-btn-go" onClick={onExport}>
          Download backup ({riders.length} riders)
        </button>
        <button
          className="mz-btn mz-btn-ghost"
          onClick={() => jsonRef.current && jsonRef.current.click()}
        >
          Restore from a backup file
        </button>
        <input
          ref={jsonRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={readJson}
        />

        {confirmRestore && (
          <div className="mz-confirm mz-restorebox">
            <span>
              This replaces your current roster of {riders.length} riders with{" "}
              {Array.isArray(confirmRestore.riders)
                ? confirmRestore.riders.length
                : "?"}{" "}
              from the file.
            </span>
            <div className="mz-confirm-row">
              <button
                className="mz-btn mz-btn-ghost"
                onClick={() => setConfirmRestore(null)}
              >
                Cancel
              </button>
              <button
                className="mz-btn mz-btn-go"
                onClick={async () => {
                  try {
                    await onRestore(confirmRestore);
                  } catch (err) {
                    flash(err.message);
                  }
                  setConfirmRestore(null);
                }}
              >
                Replace everything
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="mz-block">
        <button
          className="mz-disclose"
          onClick={() => setShowUpload((v) => !v)}
        >
          {showUpload ? "▾" : "▸"} Upload photos into the app instead
        </button>
        {showUpload && (
          <>
            <p className="mz-note mz-mt">
              Only needed where there's no folder to read — on your phone, or
              inside Claude. These are copied into browser storage, which is
              exactly the heavyweight path the folder avoids.
            </p>
            <UploadFallback
              riders={riders}
              onSaveBatch={onSaveBatch}
              flash={flash}
            />
          </>
        )}
      </section>
    </div>
  );
}

function UploadFallback({ riders, onSaveBatch, flash }) {
  const [items, setItems] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const filesRef = useRef(null);

  const sorted = useMemo(
    () => [...riders].sort((a, b) => a.last.localeCompare(b.last, "fr")),
    [riders]
  );

  const ingest = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setScanning(true);
    try {
      const files = await expandSelection(fileList);
      const taken = new Set();
      setItems(
        files.map((f, i) => {
          const m = matchRider(f.name, riders);
          let riderId = m.riderId;
          if (riderId && taken.has(riderId)) riderId = "";
          else if (riderId) taken.add(riderId);
          return { key: `${i}-${f.name}`, name: f.name, file: f, riderId };
        })
      );
    } catch (err) {
      flash(err.message);
    }
    setScanning(false);
  };

  const chosen = items.filter((it) => it.riderId);

  const run = async () => {
    setBusy(true);
    const entries = [];
    for (let i = 0; i < chosen.length; i++) {
      const rider = riders.find((r) => r.id === chosen[i].riderId);
      if (!rider) continue;
      try {
        entries.push({ rider, url: await fileToDataUrl(chosen[i].file) });
      } catch (e) {}
      setDone(i + 1);
    }
    const res = await onSaveBatch(entries);
    setBusy(false);
    setItems([]);
    setDone(0);
    flash(`${res.saved} photos stored.`);
  };

  return (
    <>
      <button
        className="mz-btn mz-btn-ghost"
        onClick={() => filesRef.current && filesRef.current.click()}
      >
        {scanning ? "Reading…" : "Choose images or a .zip"}
      </button>
      <input
        ref={filesRef}
        type="file"
        multiple
        accept="image/*,.zip"
        hidden
        onChange={(e) => {
          ingest(e.target.files);
          e.target.value = "";
        }}
      />
      {items.length > 0 && (
        <>
          <div className="mz-matchlist mz-mt">
            {items.map((it) => (
              <div key={it.key} className="mz-matchrow">
                <span className="mz-matchfile" title={it.name}>
                  {it.name}
                </span>
                <select
                  className="mz-select"
                  value={it.riderId}
                  onChange={(e) =>
                    setItems((l) =>
                      l.map((x) =>
                        x.key === it.key ? { ...x, riderId: e.target.value } : x
                      )
                    )
                  }
                >
                  <option value="">— skip —</option>
                  {sorted.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.last}
                      {r.first ? `, ${r.first}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {busy ? (
            <div className="mz-note">
              Processing {done} / {chosen.length}…
            </div>
          ) : (
            <button className="mz-btn mz-btn-go" onClick={run}>
              Store {chosen.length} photos
            </button>
          )}
        </>
      )}
    </>
  );
}

function AddPanel({ riders, onAdd, flash, goRoster }) {
  const [last, setLast] = useState("");
  const [first, setFirst] = useState("");
  const [country, setCountry] = useState("");
  const [cat, setCat] = useState("Men Elite");
  const [bulk, setBulk] = useState("");
  const [bulkCat, setBulkCat] = useState("Men Elite");

  const addOne = () => {
    if (!last.trim()) {
      flash("A surname is required.");
      return;
    }
    onAdd([{ last: last.trim(), first: first.trim(), country: country.trim(), cat }]);
    setLast("");
    setFirst("");
    flash("Rider added. Attach a photo in the Roster tab.");
  };

  const parseBulk = () => {
    const lines = bulk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) {
      flash("Paste one rider per line first.");
      return;
    }
    const out = lines.map((line) => {
      let country = "";
      let name = line;
      const paren = name.match(/\(([A-Za-z]{2,3})\)\s*$/);
      const comma = name.match(/[,;\t]\s*([A-Za-z]{2,3})\s*$/);
      const trail = name.match(/\s([A-Z]{3})\s*$/);
      if (paren) {
        country = paren[1];
        name = name.slice(0, paren.index).trim();
      } else if (comma) {
        country = comma[1];
        name = name.slice(0, comma.index).trim();
      } else if (trail) {
        country = trail[1];
        name = name.slice(0, trail.index).trim();
      }
      name = name.replace(/^\d+[.)\s]+/, "").replace(/[,;]+$/, "").trim();
      const caps = name.match(/\b[A-ZÀ-Þ][A-ZÀ-Þ'\-]{1,}\b/g);
      let lastName = "";
      let firstName = "";
      if (caps && caps.join(" ").length < name.length) {
        lastName = caps.join(" ");
        firstName = name.replace(lastName, "").trim();
      } else {
        const parts = name.split(/\s+/);
        lastName = parts.length > 1 ? parts[parts.length - 1] : name;
        firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
      }
      return { last: lastName, first: firstName, country, cat: bulkCat };
    });
    onAdd(out);
    setBulk("");
    flash(`${out.length} riders added. Attach photos in the Roster tab.`);
  };

  return (
    <div className="mz-panel">
      <section className="mz-block">
        <h3 className="mz-h3">One rider</h3>
        <div className="mz-formgrid">
          <Field label="Surname" value={last} onChange={setLast} />
          <Field label="First name" value={first} onChange={setFirst} />
          <Field label="Nation code (SLO, CAN…)" value={country} onChange={setCountry} />
          <label className="mz-field">
            <span>Category</span>
            <select className="mz-select full" value={cat} onChange={(e) => setCat(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="mz-btn mz-btn-go" onClick={addOne}>
          Add rider
        </button>
      </section>

      <section className="mz-block">
        <h3 className="mz-h3">Paste a startlist</h3>
        <p className="mz-note">
          One rider per line. Nation codes in parentheses, after a comma, or as a
          trailing three-letter code are picked up automatically.
        </p>
        <textarea
          className="mz-textarea"
          rows={6}
          placeholder={"POGAČAR Tadej (SLO)\nKopecky, Lotte, BEL\nDerek Gee CAN"}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
        />
        <div className="mz-formrow">
          <select
            className="mz-select"
            value={bulkCat}
            onChange={(e) => setBulkCat(e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button className="mz-btn mz-btn-go sm" onClick={parseBulk}>
            Add all
          </button>
        </div>
      </section>

      <section className="mz-block">
        <h3 className="mz-h3">Where to get the faces</h3>
        <ul className="mz-list">
          <li>
            <strong>Your accreditation desk first.</strong> Volunteers working rider-side
            usually get access to the official Montréal 2026 / UCI rider database, which
            has headshots against bib numbers. Ask your coordinator — it's the only source
            that matches the actual startlist.
          </li>
          <li>
            <strong>National federation team announcements.</strong> Each nation publishes
            its selection with photos, usually in the two weeks before the race.
          </li>
          <li>
            <strong>Trade team rider pages.</strong> Every WorldTour team has official
            headshots on its site — good likeness, clean framing.
          </li>
          <li>
            <strong>Rider databases</strong> like ProCyclingStats or FirstCycling carry a
            profile photo per rider, useful for private study.
          </li>
        </ul>
        <p className="mz-note">
          Save an image to your phone, then tap the rider in the Roster tab and add it.
          Photos stay on your device.
        </p>
        <p className="mz-note">
          For more than a handful, use the <strong>Import</strong> tab: drop a
          whole folder or .zip and photos are matched to surnames automatically.
        </p>
        <button className="mz-btn mz-btn-ghost" onClick={goRoster}>
          Go to roster ({riders.filter((r) => !r.hasPhoto).length} without a photo)
        </button>
      </section>
    </div>
  );
}

/* ============================================================
   Styles
   ============================================================ */
function Styles() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.mz-root {
  --ink: #F4F3EF;
  --mute: #979CA4;
  --bg: #17191D;
  --card: #21242A;
  --line: #31353C;
  --blue: #2F6DB5;
  --red: #D6222A;
  --yellow: #F2B705;
  --green: #00975A;
  background: var(--bg);
  color: var(--ink);
  font-family: 'Barlow', system-ui, -apple-system, sans-serif;
  min-height: 100vh;
  padding: env(safe-area-inset-top) env(safe-area-inset-right)
    calc(48px + env(safe-area-inset-bottom)) env(safe-area-inset-left);
  -webkit-font-smoothing: antialiased;
}
.mz-root *, .mz-root *::before, .mz-root *::after { box-sizing: border-box; }
.mz-center { display: flex; align-items: center; justify-content: center; padding: 80px 20px; }
.mz-loading { color: var(--mute); font-size: 15px; }
.mz-mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }

/* header */
.mz-head { padding: 0 0 14px; border-bottom: 1px solid var(--line); }
.mz-ladder { display: flex; gap: 2px; height: 6px; background: #FFFFFF; }
.mz-ladder-seg { flex: 1; background: #DEDCD5; overflow: hidden; }
.mz-ladder-fill { display: block; height: 100%; width: 100%; transform-origin: left center; transition: transform .5s cubic-bezier(.2,.7,.3,1); }
.mz-head-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding: 16px 18px 0; }
.mz-eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--mute); }
.mz-title { font-family: 'Barlow Condensed', 'Barlow', sans-serif; font-weight: 800; font-size: 34px; line-height: .95; letter-spacing: -.01em; margin: 4px 0 0; text-transform: uppercase; }
.mz-count { text-align: right; line-height: 1; }
.mz-count strong { display: block; font-family: 'Barlow Condensed', sans-serif; font-size: 30px; font-weight: 800; }
.mz-count span { font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--mute); }
.mz-substat { padding: 6px 18px 0; font-size: 12.5px; color: var(--mute); }

/* tabs */
.mz-tabs { display: flex; border-bottom: 1px solid var(--line); position: sticky; top: env(safe-area-inset-top); background: var(--bg); z-index: 5; }
.mz-tab { flex: 1; background: none; border: none; border-bottom: 2px solid transparent; color: var(--mute); font-family: 'Barlow', sans-serif; font-size: 13px; font-weight: 600; letter-spacing: .02em; padding: 13px 6px; cursor: pointer; }
.mz-tab.is-on { color: var(--ink); border-bottom-color: var(--yellow); }

.mz-main { padding: 18px; max-width: 620px; margin: 0 auto; }

/* jersey */
.mz-jersey { display: inline-flex; gap: 1px; background: #FFFFFF; padding: 2px; border-radius: 1px; vertical-align: middle; }
.mz-band { display: block; width: 4px; height: 11px; }
.mz-jersey-lg .mz-band { width: 8px; height: 22px; }

/* empty */
.mz-empty { text-align: center; padding: 34px 6px; }
.mz-empty h2 { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 25px; text-transform: uppercase; margin: 18px 0 8px; line-height: 1.05; }
.mz-empty p { color: var(--mute); font-size: 14.5px; line-height: 1.55; margin: 0 auto 20px; max-width: 380px; }

/* buttons */
.mz-btn { display: block; width: 100%; text-align: center; border: 1px solid var(--line); background: var(--card); color: var(--ink); font-family: 'Barlow', sans-serif; font-size: 15px; font-weight: 600; padding: 13px 16px; border-radius: 3px; cursor: pointer; margin-top: 10px; }
.mz-btn.sm { width: auto; padding: 9px 14px; font-size: 13px; margin-top: 0; }
.mz-btn-go { background: var(--ink); color: #17191D; border-color: var(--ink); }
.mz-btn-ghost { background: transparent; color: var(--mute); }
.mz-btn-hit { background: var(--green); border-color: var(--green); color: #fff; }
.mz-btn-miss { background: transparent; border-color: var(--red); color: #FF8080; }
.mz-btn:focus-visible, .mz-tab:focus-visible, .mz-chip:focus-visible, .mz-tile:focus-visible, .mz-input:focus-visible, .mz-select:focus-visible, .mz-textarea:focus-visible, .mz-choice:focus-visible { outline: 2px solid var(--yellow); outline-offset: 2px; }
.mz-link { background: none; border: none; color: var(--yellow); font-size: 12.5px; cursor: pointer; padding: 0; font-family: inherit; }

/* chips + filters */
.mz-modes { display: flex; gap: 6px; margin-bottom: 12px; }
.mz-chip { flex: 1; background: transparent; border: 1px solid var(--line); color: var(--mute); font-family: 'Barlow', sans-serif; font-size: 12px; font-weight: 600; padding: 8px 6px; border-radius: 2px; cursor: pointer; white-space: nowrap; }
.mz-chip.is-on { background: var(--ink); color: #17191D; border-color: var(--ink); }
.mz-filters { display: flex; gap: 8px; margin-bottom: 12px; }
.mz-select { flex: 1; background: var(--card); border: 1px solid var(--line); color: var(--ink); font-family: 'Barlow', sans-serif; font-size: 13px; padding: 9px 10px; border-radius: 2px; }
.mz-select.full { width: 100%; }
.mz-session { display: flex; gap: 16px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--mute); margin-bottom: 14px; }
.mz-session strong { color: var(--ink); }
.mz-progress { height: 3px; background: var(--line); border-radius: 2px; overflow: hidden; margin-bottom: 10px; }
.mz-progress-fill { display: block; height: 100%; width: 100%; background: var(--yellow); transform-origin: left center; transition: transform .35s cubic-bezier(.2,.7,.3,1); }
.mz-filters.is-locked { opacity: .45; }
.mz-select:disabled { cursor: not-allowed; }
.mz-sessionctl { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
.mz-sessionctl .mz-link { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.mz-end { margin-left: auto; color: #FF8080; }
.mz-start { padding: 4px 0 0; }
.mz-lastrun { border: 1px solid var(--line); border-radius: 3px; padding: 11px 13px; margin-bottom: 16px; }
.mz-lastrun-row { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 6px; font-size: 13px; color: var(--mute); }
.mz-lastrun-row strong { color: var(--ink); font-size: 15px; }
.mz-startstats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 6px; }
.mz-startstat { background: var(--card); border: 1px solid var(--line); border-radius: 3px; padding: 14px 10px; text-align: center; }
.mz-startstat strong { display: block; font-family: 'Barlow Condensed', sans-serif; font-size: 30px; font-weight: 800; line-height: 1; }
.mz-startstat span { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--mute); margin-top: 5px; }
.mz-startnote { margin-top: 12px; }
.mz-summary { padding: 4px 0 0; }
.mz-summary .mz-startstats { margin-top: 10px; }
.mz-summary .mz-startstat strong { font-size: 26px; }
.mz-sumline { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: var(--mute); margin: 10px 0 16px; }
.mz-sumbands { display: flex; align-items: center; gap: 12px; border: 1px solid var(--line); border-radius: 3px; padding: 12px 13px; margin-bottom: 20px; }
.mz-sumbands-main { font-size: 14.5px; font-weight: 600; }
.mz-sumbands-sub { font-size: 13px; color: var(--mute); margin-top: 2px; }
.mz-sumsection { margin-bottom: 22px; }
.mz-sumhead { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 17px; text-transform: uppercase; letter-spacing: .02em; margin: 0 0 10px; }
.mz-sumhead .mz-mono { font-size: 12px; color: var(--mute); font-weight: 400; }
.mz-sumlist { display: flex; flex-direction: column; gap: 6px; }
.mz-sumrow { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; background: var(--card); border: 1px solid var(--line); border-radius: 3px; padding: 7px 11px 7px 7px; cursor: pointer; color: var(--ink); font-family: inherit; }
.mz-sumthumb { flex: 0 0 auto; width: 34px; height: 42px; background: #101317; border-radius: 2px; overflow: hidden; display: block; }
.mz-sumthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mz-sumname { flex: 1; min-width: 0; }
.mz-sumlast { display: block; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 17px; text-transform: uppercase; line-height: 1.05; }
.mz-sumsub { display: block; font-size: 11.5px; color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mz-summiss { flex: 0 0 auto; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: #FF8080; }
.mz-sumtip { margin-top: 10px; margin-bottom: 0; }
.mz-sumchips { display: flex; flex-wrap: wrap; gap: 5px; }
.mz-sumchip { font-family: 'Barlow Condensed', sans-serif; font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: .02em; border: 1px solid var(--line); border-left: 2px solid var(--green); border-radius: 2px; padding: 4px 8px; color: var(--mute); }
.mz-shuffle { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }

/* card */
.mz-card { background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 14px; animation: mzIn .28s ease both; }
@keyframes mzIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.mz-photo { position: relative; aspect-ratio: 4 / 5; background: #101317; border-radius: 2px; overflow: hidden; }
.mz-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mz-nameprompt { aspect-ratio: 4 / 5; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #101317; border-radius: 2px; padding: 20px; text-align: center; }
.mz-recall { color: var(--mute); font-size: 13px; margin-top: 14px; }
.mz-cardfoot { display: flex; align-items: center; justify-content: space-between; padding: 12px 2px 4px; }
.mz-cat { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--mute); }
.mz-surname { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 38px; line-height: .92; text-transform: uppercase; letter-spacing: -.005em; }
.mz-surname.sm { font-size: 26px; }
.mz-given { font-size: 15px; color: var(--mute); margin-top: 3px; }
.mz-tri { font-family: 'IBM Plex Mono', monospace; font-size: 13px; margin-top: 8px; letter-spacing: .1em; }
.mz-dot { opacity: .5; }
.mz-answer { padding: 6px 2px 2px; animation: mzIn .2s ease both; }
.mz-namelink { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0; margin: 0; color: var(--ink); font-family: inherit; cursor: pointer; position: relative; }
.mz-namelink .mz-surname { display: inline; border-bottom: 2px solid rgba(242,183,5,.55); }
.mz-namelink .mz-given { display: block; }
.mz-namelink:hover .mz-surname { border-bottom-color: var(--yellow); }
.mz-arrow { font-size: 15px; color: var(--yellow); margin-left: 7px; vertical-align: super; }
.mz-openprofile { grid-column: 1 / -1; background: none; border: none; color: var(--yellow); font-family: 'Barlow', sans-serif; font-size: 13px; font-weight: 600; text-align: center; padding: 10px 4px 2px; cursor: pointer; }
.mz-backdrill { margin-bottom: 4px; }
.mz-hide { display: none; }
.mz-alert { margin: 10px 18px 0; border-left: 3px solid var(--yellow); background: rgba(242,183,5,.09); padding: 9px 11px; font-size: 12.5px; line-height: 1.5; color: var(--ink); }
.mz-drop { border: 1px dashed var(--line); border-radius: 4px; padding: 22px 14px; text-align: center; margin-bottom: 14px; transition: border-color .15s, background .15s; }
.mz-drop.is-over { border-color: var(--yellow); background: rgba(242,183,5,.07); }
.mz-dropmsg { display: block; font-size: 13.5px; color: var(--mute); }
.mz-droprow { display: flex; gap: 8px; justify-content: center; margin-top: 12px; }
.mz-matchbar { display: flex; gap: 16px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--mute); margin-bottom: 10px; }
.mz-matchbar strong { color: var(--ink); }
.mz-matchbar .mz-warn strong { color: var(--yellow); }
.mz-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--mute); margin-bottom: 12px; cursor: pointer; }
.mz-check input { margin-top: 2px; flex: 0 0 auto; }
.mz-matchlist { display: flex; flex-direction: column; gap: 6px; max-height: 340px; overflow-y: auto; border: 1px solid var(--line); border-radius: 3px; padding: 8px; margin-bottom: 14px; }
.mz-matchrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: center; }
.mz-matchrow.is-unmatched { border-left: 2px solid var(--yellow); padding-left: 7px; }
.mz-matchrow.is-skipped { opacity: .42; }
.mz-matchfile { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--mute); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mz-matchrow .mz-select { font-size: 12px; padding: 7px 8px; width: 100%; min-width: 0; }
.mz-mt { margin-top: 14px; }
.mz-via { margin-left: auto; opacity: .7; }
.mz-alert-inline { margin: 0 0 14px; }
.mz-alertsub { margin-top: 6px; color: var(--mute); font-size: 12px; }
.mz-why { font-style: normal; color: var(--yellow); font-size: 10px; }
.mz-chipwrap { display: flex; flex-wrap: wrap; gap: 5px; }
.mz-chip-warn { border-left-color: var(--yellow); }
.mz-disclose { background: none; border: none; color: var(--mute); font-family: 'Barlow', sans-serif; font-size: 13px; font-weight: 600; padding: 0; cursor: pointer; text-align: left; }
.mz-formrow .mz-input { flex: 1; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
.mz-restorebox { border: 1px solid var(--line); border-radius: 3px; padding: 12px; margin-top: 12px; }
.mz-tell { margin-top: 8px; font-size: 13.5px; color: var(--yellow); }
.mz-grade { display: flex; gap: 8px; }
.mz-grade .mz-btn { flex: 1; }

/* choices */
.mz-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.mz-choice { text-align: left; background: transparent; border: 1px solid var(--line); border-radius: 3px; padding: 10px 11px; cursor: pointer; color: var(--ink); font-family: inherit; }
.mz-choice-last { display: block; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 17px; text-transform: uppercase; line-height: 1.05; }
.mz-choice-first { display: block; font-size: 12px; color: var(--mute); }
.mz-choice.is-right { border-color: var(--green); background: rgba(0,151,90,.16); }
.mz-choice.is-wrong { border-color: var(--red); background: rgba(214,34,42,.14); }
.mz-choice.is-dim { opacity: .38; }
.mz-choices .mz-btn { grid-column: 1 / -1; }

/* panels */
.mz-panel { display: block; }
.mz-block { border-top: 1px solid var(--line); padding-top: 18px; margin-top: 20px; }
.mz-block:first-child { border-top: none; padding-top: 0; margin-top: 0; }
.mz-h3 { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 19px; text-transform: uppercase; letter-spacing: .02em; margin: 0 0 10px; }
.mz-note { color: var(--mute); font-size: 13.5px; line-height: 1.55; margin: 0 0 12px; }
.mz-list { color: var(--mute); font-size: 13.5px; line-height: 1.55; padding-left: 18px; margin: 0 0 12px; }
.mz-list li { margin-bottom: 9px; }
.mz-list strong { color: var(--ink); font-weight: 600; }

/* inputs */
.mz-input { background: var(--card); border: 1px solid var(--line); color: var(--ink); font-family: 'Barlow', sans-serif; font-size: 15px; padding: 10px 11px; border-radius: 2px; width: 100%; }
.mz-input.full { width: 100%; }
.mz-textarea { width: 100%; background: var(--card); border: 1px solid var(--line); color: var(--ink); font-family: 'IBM Plex Mono', monospace; font-size: 13px; line-height: 1.6; padding: 11px; border-radius: 2px; resize: vertical; }
.mz-field { display: block; margin-bottom: 10px; }
.mz-field > span { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--mute); margin-bottom: 5px; }
.mz-formgrid { margin-bottom: 4px; }
.mz-formrow { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.mz-searchrow { display: flex; gap: 8px; margin-bottom: 14px; }
.mz-searchrow .mz-input { flex: 1; }
.mz-searchrow .mz-chip { flex: 0 0 auto; padding: 0 14px; }

/* grid */
.mz-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.mz-tile { display: block; background: var(--card); border: 1px solid var(--line); border-radius: 3px; padding: 6px; cursor: pointer; text-align: left; color: var(--ink); font-family: inherit; }
.mz-thumb { display: block; aspect-ratio: 4 / 5; background: #101317; border-radius: 2px; overflow: hidden; position: relative; }
.mz-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mz-thumb-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #5A6068; letter-spacing: .06em; }
.mz-tile-name { display: block; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 14px; text-transform: uppercase; line-height: 1.1; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mz-tile-sub { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; font-size: 10px; color: var(--mute); letter-spacing: .08em; }

/* sheet */
.mz-sheet-wrap { position: fixed; inset: 0; background: rgba(10,11,13,.72); display: flex; align-items: flex-end; justify-content: center; z-index: 40; padding: 0; }
.mz-sheet { background: var(--bg); border-top: 3px solid var(--yellow); width: 100%; max-width: 620px; max-height: 92vh; max-height: 92dvh; overflow-y: auto; padding: 18px 18px calc(18px + env(safe-area-inset-bottom)); animation: mzUp .24s cubic-bezier(.2,.8,.3,1) both; }
@keyframes mzUp { from { transform: translateY(24px); opacity: .4; } to { transform: none; opacity: 1; } }
.mz-sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.mz-x { background: none; border: 1px solid var(--line); color: var(--mute); width: 32px; height: 32px; border-radius: 2px; font-size: 20px; line-height: 1; cursor: pointer; flex: 0 0 auto; }
.mz-sheet-photo { width: 216px; height: 270px; background: #101317; border-radius: 2px; overflow: hidden; position: relative; margin: 0 auto; }
.mz-sheet-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mz-filelabel { display: block; }
.mz-urlrow { display: flex; gap: 8px; margin: 10px 0 18px; }
.mz-urlrow .mz-input { flex: 1; font-size: 13px; }
.mz-fields { border-top: 1px solid var(--line); padding-top: 16px; }
.mz-sheet-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 14px; font-size: 12.5px; color: var(--mute); }
.mz-sheet-foot { display: flex; gap: 8px; margin-top: 16px; }
.mz-sheet-foot .mz-btn { flex: 1; margin-top: 0; }

/* danger */
.mz-danger { border-top: 1px solid var(--line); margin-top: 26px; padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.mz-danger .mz-btn { margin-top: 0; }
.mz-confirm { font-size: 13px; color: var(--mute); }
.mz-confirm-row { display: flex; gap: 8px; margin-top: 10px; }
.mz-confirm-row .mz-btn { flex: 1; margin-top: 0; }

/* toast */
.mz-toast { position: fixed; left: 50%; bottom: calc(22px + env(safe-area-inset-bottom)); transform: translateX(-50%); background: #FFFFFF; color: #17191D; font-size: 13.5px; font-weight: 500; padding: 11px 16px; border-radius: 3px; max-width: 88vw; z-index: 60; box-shadow: 0 8px 24px rgba(0,0,0,.4); }

@media (prefers-reduced-motion: reduce) {
  .mz-root *, .mz-root *::before, .mz-root *::after { animation: none !important; transition: none !important; }
}
`}</style>
  );
}
