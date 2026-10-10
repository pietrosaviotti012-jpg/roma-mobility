// Costruisce l'indice dei numeri civici di Roma dai dati ANNCSU (CC BY 4.0).
//  vie.json            [[nome, file, lat*1e5, lon*1e5], ...]  una riga per via, in ordine alfabetico
//  civici-NN.json      { "VIA ANAPO": [lat*1e5, lon*1e5, "1A:0,0;3:-2,1;..."], ... }
// Nei file dei civici ogni punto e' scritto come differenza dal precedente (in 1e-5 gradi, circa un metro).
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import fs from "fs";

const OUT = process.argv[2];
const SHARDS = 32;
const cells = JSON.parse(fs.readFileSync("roma-cells.json", "utf8"));
const streets = new Map();
let rows = 0;
let kept = 0;

for (const cell of cells) {
  const buf = fs.readFileSync("tiles/" + cell + ".parquet");
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = await parquetReadObjects({
    file,
    compressors,
    columns: ["CODICE_ISTAT", "ODONIMO", "CIVICO", "ESPONENTE", "longitude", "latitude", "out_of_bounds"],
  });
  rows += data.length;
  for (const r of data) {
    if (r.CODICE_ISTAT !== "058091" || r.out_of_bounds || r.CIVICO === null || r.CIVICO === undefined) continue;
    if (!Number.isFinite(r.latitude) || !Number.isFinite(r.longitude) || !r.ODONIMO) continue;
    const name = r.ODONIMO.trim().replace(/\s+/g, " ");
    const label = String(r.CIVICO) + (r.ESPONENTE ? String(r.ESPONENTE).trim().toUpperCase().replace(/[^A-Z0-9]/g, "") : "");
    if (!streets.has(name)) streets.set(name, new Map());
    const numbers = streets.get(name);
    if (numbers.has(label)) continue;
    numbers.set(label, [Math.round(r.latitude * 1e5), Math.round(r.longitude * 1e5)]);
    kept += 1;
  }
}

const natural = (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
const names = [...streets.keys()].sort((a, b) => a.localeCompare(b, "it"));
const perShard = Math.ceil(kept / SHARDS);
const shards = Array.from({ length: SHARDS }, () => ({}));
const index = [];
let shard = 0;
let filled = 0;

for (const name of names) {
  const entries = [...streets.get(name).entries()].sort((a, b) => natural(a[0], b[0]));
  if (filled >= perShard && shard < SHARDS - 1) {
    shard += 1;
    filled = 0;
  }
  const [lat0, lon0] = entries[0][1];
  let prev = [lat0, lon0];
  const parts = entries.map(([label, point]) => {
    const text = label + ":" + (point[0] - prev[0]) + "," + (point[1] - prev[1]);
    prev = point;
    return text;
  });
  shards[shard][name] = [lat0, lon0, parts.join(";")];
  const middle = entries[Math.floor(entries.length / 2)][1];
  index.push([name, shard, middle[0], middle[1]]);
  filled += entries.length;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(OUT + "/vie.json", JSON.stringify(index));
let total = fs.statSync(OUT + "/vie.json").size;
shards.forEach((content, i) => {
  const file = OUT + "/civici-" + String(i).padStart(2, "0") + ".json";
  fs.writeFileSync(file, JSON.stringify(content));
  total += fs.statSync(file).size;
});
console.log({ rows, kept, streets: names.length, shards: SHARDS, bytes: total, index: fs.statSync(OUT + "/vie.json").size });
