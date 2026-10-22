"""One-off scrape of the Qadhely product catalog (SF-35) from Tamimi and Panda.

Run once:  python scrape_catalog.py
Output:    catalog.json (the file the backend seeds MongoDB from) and raw/ (untouched responses).
Teammates do not need to run this; they use catalog.json.
"""
import json, re, time, pathlib, urllib.request, urllib.parse

HERE = pathlib.Path(__file__).parent
RAW = HERE / "raw"
PER_CATEGORY = 50
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

# our category -> (Tamimi slug, Panda category_id)
CATEGORIES = {
    "dairy": ("dairy", 356),
    "bakery": ("bakery", 235),
    "beverages": ("water--beverages", 288),
    "fruits_vegetables": ("fruits--vegetables", 352),
    "food_basics": ("rice--pasta", 466),
    "household": ("household", 273),
}
UNITS = {"g": "g", "gm": "g", "gms": "g", "gr": "g", "kg": "kg", "kgs": "kg", "ml": "ml", "l": "l", "ltr": "l",
         "litre": "l", "liter": "l", "pc": "pcs", "pcs": "pcs", "piece": "pcs", "pieces": "pcs", "count": "pcs", "counts": "pcs"}


def get(url, params, headers=None, save_as=None):
    time.sleep(1)  # be gentle: one request per second
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode("utf-8")
    if save_as:
        (RAW / save_as).write_text(body, encoding="utf-8")
    return body


def parse_size(text):
    # last "<number> <unit>" wins, so a multipack like "12 X 20 G" gives the size of one unit (20 g)
    for value, unit in reversed(re.findall(r"(\d+(?:\.\d+)?)\s*([a-zA-Z]+)", text or "")):
        if unit.lower() in UNITS:
            return float(value), UNITS[unit.lower()]
    return None, None  # "Each", "Pack", "Medium": no size to give


def tamimi(category, slug):
    url = "https://shop.tamimimarkets.com/api/product"
    en, ar = [], {}
    for page in range(1, PER_CATEGORY // 20 + 2):
        en += json.loads(get(url, {"category": slug, "page": page}, save_as=f"tamimi_{slug}_{page}_en.json"))["data"]["product"]
        for p in json.loads(get(url, {"category": slug, "page": page}, {"Accept-Language": "ar"},
                                f"tamimi_{slug}_{page}_ar.json"))["data"]["product"]:
            ar[p["id"]] = p
        if len(en) >= PER_CATEGORY:
            break
    for p in en[:PER_CATEGORY]:
        v, a = p["variants"][0], ar.get(p["id"], {})
        size_value, size_unit = parse_size(v.get("name"))
        yield {"id": f"tamimi-{p['id']}", "name_en": p["name"], "name_ar": a.get("name"),
               "brand_en": (p.get("brand") or {}).get("name"), "brand_ar": (a.get("brand") or {}).get("name"),
               "size_value": size_value, "size_unit": size_unit, "size_text": v.get("name"), "flavor": None,
               "category": category, "store_category": (p.get("primaryCategory") or {}).get("name"),
               "barcode": (v.get("barcodes") or [None])[0], "image": (v.get("images") or [None])[0], "store": "Tamimi"}


def panda_page(category_id, page, lang):
    html = get(f"https://panda.sa/{lang}/plp", {"category_id": category_id, "page": page},
               save_as=f"panda_{category_id}_{page}_{lang}.html")
    payload = ""
    for part in html.split("self.__next_f.push([1,")[1:]:
        try:
            payload += json.JSONDecoder().raw_decode(part)[0]
        except ValueError:
            pass
    start = payload.index('"products":[') + len('"products":')
    return json.JSONDecoder().raw_decode(payload[start:])[0]


def panda(category, category_id):
    en, ar = [], {}
    for page in range(1, PER_CATEGORY // 30 + 2):
        en += panda_page(category_id, page, "en")
        ar.update({p["id"]: p for p in panda_page(category_id, page, "ar")})
        if len(en) >= PER_CATEGORY:
            break
    for p in en[:PER_CATEGORY]:
        v, a = p["varieties"][0], ar.get(p["id"], {})
        unit = (v.get("unit") or "").strip().lower()
        yield {"id": f"panda-{p['id']}", "name_en": p["name"], "name_ar": a.get("name"),
               "brand_en": (p.get("brand") or {}).get("name"), "brand_ar": (a.get("brand") or {}).get("name"),
               "size_value": float(v["size"]) if v.get("size") else None, "size_unit": UNITS.get(unit, unit or None),
               "size_text": f"{v.get('size')} {v.get('unit')}", "flavor": None,
               "category": category, "store_category": (p.get("category") or {}).get("name"),
               "barcode": v.get("barcode"), "image": v["images"][0][0] if v.get("images") else v.get("imageURL"),
               "store": "Panda"}


def main():
    RAW.mkdir(exist_ok=True)
    items, seen = [], set()
    for category, (slug, panda_id) in CATEGORIES.items():
        for store, rows in (("tamimi", tamimi(category, slug)), ("panda", panda(category, panda_id))):
            n = 0
            for item in rows:
                if item["id"] not in seen:  # a product can sit in two of our categories; keep the first
                    seen.add(item["id"]); items.append(item); n += 1
            print(f"{category:18} {store:7} {n}")
    (HERE / "catalog.json").write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    missing = {k: sum(1 for i in items if not i[k]) for k in ("name_en", "name_ar", "brand_en", "image", "size_value")}
    print(f"\n{len(items)} items -> catalog.json | missing values: {missing}")
    assert len(seen) == len(items) and not missing["name_en"]


if __name__ == "__main__":
    main()
