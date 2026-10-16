"""Indice dei luoghi di Roma e dintorni da un estratto OpenStreetMap (.osm.pbf).

Uso:  python -I build_luoghi.py <estratto.osm.pbf> <cartella di uscita> <data/civici/vie.json>

Uscita:
  luoghi-<xy>.json  un file per le prime due lettere delle parole (senza "via", "di", "la"...): ogni luogo
                    sta nei file delle sue parole, cosi' basta scaricare il file della parola scritta.
                    Righe: [nome, tipo, lat*1e5, lon*1e5, indirizzo, comune]
  notevoli.json     monumenti, musei, stazioni, parchi...: per dire "vicino a" dove si tiene premuto.
Dati (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import sys
import unicodedata

import osmium

# Citta' metropolitana di Roma con un po' di margine.
SOUTH, NORTH, WEST, EAST = 41.40, 42.35, 11.70, 13.35

SKIP_AMENITY = {
    "parking", "parking_entrance", "parking_space", "bench", "waste_basket", "vending_machine", "bicycle_parking",
    "recycling", "post_box", "telephone", "drinking_water", "shelter", "charging_station", "atm", "toilets", "clock",
    "hunting_stand", "motorcycle_parking", "grit_bin", "waste_disposal", "letter_box", "water_point", "bbq",
    "photo_booth", "loading_dock", "watering_place", "smoking_area", "bicycle_repair_station", "compressed_air",
}

# Tipo in italiano: si mostra sotto il nome e si puo' cercare ("farmacia", "supermercato").
LABELS = {
    "restaurant": "ristorante", "fast_food": "fast food", "cafe": "bar", "bar": "bar", "pub": "pub", "ice_cream": "gelateria",
    "pharmacy": "farmacia", "hospital": "ospedale", "clinic": "clinica", "doctors": "medico", "dentist": "dentista",
    "school": "scuola", "university": "università", "college": "istituto", "kindergarten": "scuola dell'infanzia",
    "library": "biblioteca", "bank": "banca", "post_office": "ufficio postale", "police": "polizia", "fire_station": "vigili del fuoco",
    "place_of_worship": "chiesa", "theatre": "teatro", "cinema": "cinema", "townhall": "municipio", "fuel": "distributore",
    "marketplace": "mercato", "nightclub": "discoteca", "fountain": "fontana", "car_rental": "noleggio auto",
    "supermarket": "supermercato", "convenience": "minimarket", "clothes": "abbigliamento", "shoes": "scarpe",
    "bakery": "forno", "butcher": "macelleria", "hairdresser": "parrucchiere", "beauty": "estetista", "books": "libreria",
    "mall": "centro commerciale", "department_store": "grande magazzino", "electronics": "elettronica", "mobile_phone": "telefonia",
    "optician": "ottico", "florist": "fiorista", "furniture": "arredamento", "hardware": "ferramenta", "jewelry": "gioielleria",
    "pastry": "pasticceria", "greengrocer": "frutta e verdura", "tobacco": "tabaccheria", "kiosk": "edicola", "newsagent": "edicola",
    "sports": "articoli sportivi", "toys": "giocattoli", "pet": "animali", "car_repair": "officina", "car": "concessionaria",
    "laundry": "lavanderia", "dry_cleaning": "lavanderia", "travel_agency": "agenzia viaggi", "wine": "enoteca", "alcohol": "enoteca",
    "hotel": "hotel", "guest_house": "b&b", "hostel": "ostello", "apartment": "appartamento", "museum": "museo",
    "attraction": "attrazione", "viewpoint": "panorama", "artwork": "opera d'arte", "gallery": "galleria",
    "park": "parco", "garden": "giardino", "sports_centre": "centro sportivo", "stadium": "stadio", "pitch": "campo sportivo",
    "swimming_pool": "piscina", "fitness_centre": "palestra", "playground": "parco giochi", "dog_park": "area cani",
    "monument": "monumento", "memorial": "memoriale", "archaeological_site": "sito archeologico", "ruins": "rovine",
    "castle": "castello", "church": "chiesa", "city_gate": "porta", "city": "città", "town": "paese", "village": "paese",
    "suburb": "quartiere", "quarter": "quartiere", "neighbourhood": "zona", "hamlet": "frazione",
    "station": "stazione", "aerodrome": "aeroporto", "terminal": "terminal",
}

KEYS = ("amenity", "shop", "tourism", "leisure", "historic", "office", "healthcare", "craft", "place")
PLACES = {"city", "town", "village", "suburb", "quarter", "neighbourhood", "hamlet"}
STREETS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
           "pedestrian", "service", "road", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}


# Parole che non distinguono un luogo: non decidono in che file va.
STOP = {"via", "viale", "piazza", "piazzale", "largo", "corso", "vicolo", "lungotevere", "di", "del", "della", "dello",
        "dei", "degli", "delle", "de", "da", "dal", "la", "il", "lo", "le", "gli", "i", "e", "ed", "a", "al", "in", "the", "and"}
NOTABLE = {"attrazione", "monumento", "memoriale", "sito archeologico", "rovine", "museo", "fontana", "parco", "giardino",
           "stazione", "aeroporto", "stadio", "castello", "porta", "università", "ospedale", "teatro", "centro commerciale",
           "quartiere", "panorama", "chiesa"}


def norm(text):
    text = unicodedata.normalize("NFD", text or "")
    text = "".join(c for c in text if unicodedata.category(c) != "Mn").lower()
    return " ".join("".join(c if c.isalnum() else " " for c in text).split())


def inside(lat, lon):
    return SOUTH <= lat <= NORTH and WEST <= lon <= EAST


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.items = []
        self.towns = []      # (lat, lon, nome) di citta', paesi e frazioni per dare il comune ai luoghi
        self.streets = {}    # (nome normalizzato, cella ~1 km) -> [nome, lat, lon]

    def kind(self, tags):
        for key in KEYS:
            value = tags.get(key)
            if not value:
                continue
            if key == "amenity" and value in SKIP_AMENITY:
                return None
            if key == "place" and value not in PLACES:
                return None
            return value if value != "yes" else key
        if tags.get("railway") == "station" or tags.get("aeroway") in ("aerodrome", "terminal"):
            return tags.get("railway") or tags.get("aeroway")
        return None

    def add(self, tags, lat, lon):
        name = tags.get("name")
        if not name or not inside(lat, lon):
            return
        kind = self.kind(tags)
        if kind:
            street = tags.get("addr:street", "")
            number = tags.get("addr:housenumber", "")
            address = (street + " " + number).strip() if street else ""
            self.items.append([name, LABELS.get(kind, ""), round(lat * 1e5), round(lon * 1e5), address, tags.get("addr:city", "")])
            # Per dare il comune ai luoghi bastano citta' e paesi (le frazioni darebbero nomi poco noti).
            if tags.get("place") in ("city", "town", "village"):
                self.towns.append((lat, lon, name))

    def node(self, n):
        if n.tags and "name" in n.tags:
            self.add(n.tags, n.location.lat, n.location.lon)

    def way(self, w):
        tags = w.tags
        if "name" not in tags:
            return
        try:
            locs = [(nd.location.lat, nd.location.lon) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            return
        if not locs:
            return
        lat = sum(p[0] for p in locs) / len(locs)
        lon = sum(p[1] for p in locs) / len(locs)
        if tags.get("highway") in STREETS:
            if inside(lat, lon):
                key = (norm(tags["name"]), round(lat * 50), round(lon * 50))
                if key not in self.streets:
                    self.streets[key] = [tags["name"], lat, lon]
            return
        self.add(tags, lat, lon)

    def area(self, a):
        # I luoghi disegnati come relazioni (Pantheon, Colosseo, Fontana di Trevi, stadi, grandi parchi):
        # le vie sono gia' lette in way(), qui servono solo le relazioni.
        if a.from_way() or "name" not in a.tags:
            return
        lat_sum = lon_sum = count = 0
        try:
            for ring in a.outer_rings():
                for nr in ring:
                    if nr.location.valid():
                        lat_sum += nr.location.lat
                        lon_sum += nr.location.lon
                        count += 1
        except osmium.InvalidLocationError:
            return
        if count:
            self.add(a.tags, lat_sum / count, lon_sum / count)


def nearest_town(towns, lat, lon):
    best, best_d = "", 1e9
    for tlat, tlon, name in towns:
        d = (tlat - lat) ** 2 + ((tlon - lon) * math.cos(math.radians(lat))) ** 2
        if d < best_d:
            best, best_d = name, d
    return best


def main():
    source, out = sys.argv[1], sys.argv[2]
    handler = Collector()
    handler.apply_file(source, locations=True, idx="flex_mem")
    items = handler.items

    # Le vie: per Roma ci sono gia' quelle ANNCSU (coi civici); qui restano le vie degli altri comuni.
    anncsu = {}
    for name, _shard, lat, lon in json.load(open(sys.argv[3], encoding="utf-8")):
        anncsu.setdefault(norm(name), []).append((lat / 1e5, lon / 1e5))
    kept_streets = 0
    for name, lat, lon in handler.streets.values():
        same = anncsu.get(norm(name), [])
        if any(abs(a - lat) < 0.03 and abs(b - lon) < 0.04 for a, b in same):
            continue
        kept_streets += 1
        items.append([name, "via", round(lat * 1e5), round(lon * 1e5), "", ""])

    # Comune per chi non ce l'ha: il centro abitato piu' vicino (a griglia, per fare presto).
    grid = {}
    for t in handler.towns:
        grid.setdefault((int(t[0] * 10), int(t[1] * 10)), []).append(t)
    for item in items:
        if item[5]:
            continue
        lat, lon = item[2] / 1e5, item[3] / 1e5
        cells = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                cells += grid.get((int(lat * 10) + dy, int(lon * 10) + dx), [])
        item[5] = nearest_town(cells or handler.towns, lat, lon)

    # Doppioni: stesso nome e tipo a meno di ~100 m (nodo e edificio dello stesso negozio).
    seen = set()
    unique = []
    for item in items:
        key = (norm(item[0]), item[1], round(item[2] / 100), round(item[3] / 100))
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)

    # Ogni luogo nei file delle prime due lettere delle sue parole (nome, e tipo per i luoghi: "farmacia").
    shards = {}
    for item in unique:
        words = norm(item[0]).split()
        if item[1] and item[1] != "via":
            words += norm(item[1]).split()
        keys = set()
        for word in words:
            if word in STOP or len(word) < 2:
                continue
            key = word[:2]
            if key[0].isdigit():
                key = "0"
            elif not (key.isascii() and key.isalpha()):
                continue  # parole in altri alfabeti: il luogo si trova con le altre parole
            keys.add(key)
        for key in keys:
            shards.setdefault(key, []).append(item)

    os.makedirs(out, exist_ok=True)
    total = 0
    for letter, rows in shards.items():
        path = os.path.join(out, "luoghi-" + letter + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, separators=(",", ":"))
        total += os.path.getsize(path)
    notable = [[i[0], i[1], i[2], i[3]] for i in unique if i[1] in NOTABLE]
    path = os.path.join(out, "notevoli.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(notable, fh, ensure_ascii=False, separators=(",", ":"))
    print("luoghi", len(unique), "vie tenute", kept_streets, "di", len(handler.streets), "file", len(shards), "byte", total,
          "notevoli", len(notable), os.path.getsize(path))


if __name__ == "__main__":
    main()
