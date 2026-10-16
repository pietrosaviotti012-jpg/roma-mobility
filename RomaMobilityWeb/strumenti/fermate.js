// Rigenera data/fermate-roma.json (uso: node strumenti/fermate.js dalla cartella del sito) e data/fermate-cotral.json con le stesse funzioni dell'app.
const fs = require("fs");
const vm = require("vm");
const W = require("path").join(__dirname, "..") + "/";
const src = fs.readFileSync(W + "app.js", "utf8");
const end = src.indexOf("async function readJson(path)");
const ctx = { console, window: {}, document: {}, navigator: {}, localStorage: { getItem() { return null; } } };
vm.createContext(ctx);
vm.runInContext(src.slice(0, end) + ";this.api={parseCsv,parseAtacStops,parseCotralStops};", ctx);
const atac = ctx.api.parseAtacStops(ctx.api.parseCsv(fs.readFileSync(W + "data/stops.txt", "utf8")));
const cotral = ctx.api.parseCotralStops(ctx.api.parseCsv(fs.readFileSync(W + "data/cotral_stops.txt", "utf8")));
const e5 = (v) => Math.round(v * 1e5);
const roma = {
  // [stop_id, codice se diverso, nome, lat*1e5, lon*1e5]
  atac: atac.filter((s) => s.mode !== "MetroStation").map((s) => [s.stopId, s.code === s.stopId ? "" : s.code, s.name, e5(s.lat), e5(s.lon)]),
  // [nome, linea, lat, lon, stop_id della stazione, [[stop_id banchina, codice, lat, lon, linea], ...]]
  metro: atac.filter((s) => s.mode === "MetroStation").map((s) => [s.name, s.metroLine, e5(s.lat), e5(s.lon), s.stopId, s.children.map((c) => [c.stopId, c.code, e5(c.lat), e5(c.lon), c.metroLine])]),
};
const cot = cotral.map((s) => [s.stopId, s.name, e5(s.lat), e5(s.lon)]);
fs.writeFileSync(W + "data/fermate-roma.json", JSON.stringify(roma));
fs.writeFileSync(W + "data/fermate-cotral.json", JSON.stringify(cot));
for (const f of ["fermate-roma.json", "fermate-cotral.json"]) console.log(f, fs.statSync(W + "data/" + f).size, "byte");
