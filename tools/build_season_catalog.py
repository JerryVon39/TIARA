"""Build TIARA's public season seed and optional local-use Bangumi thumbnails."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import threading
import time

UTC8 = timezone(timedelta(hours=8))
FIRST_SEASON = 2019 * 4
PLATFORMS = {"tv": "TV", "web": "WEB", "movie": "剧场版", "ova": "OVA"}
SOURCE = "https://github.com/bangumi-data/bangumi-data"
USER_AGENT = "JerryVon39/TIARA (https://github.com/JerryVon39/TIARA)"


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(UTC8) if result.tzinfo else None
    except (ValueError, AttributeError):
        return None


def quarter(day):
    return day.year * 4 + (day.month - 1) // 3


def quarter_name(index):
    return f"{index // 4}Q{index % 4 + 1}"


def quarter_start(index):
    return datetime(index // 4, (index % 4) * 3 + 1, 1, tzinfo=UTC8)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf8", newline="\n")


def rows_from(source, first, last):
    groups = {index: {} for index in range(first, last + 1)}
    for item in source["items"]:
        start = timestamp(item.get("begin"))
        if not start or quarter(start) not in groups or not item.get("title"):
            continue
        sites = item.get("sites", [])
        subject = next((str(row.get("id")) for row in sites if row.get("site") == "bangumi"), "")
        key = item.get("officialSite") or (item["title"] + str(start.year))
        entry_id = int(subject) if subject.isascii() and subject.isdecimal() and 0 < int(subject) <= 9_999_999_999 else (
            "local-catalog-" + sha256(key.encode()).hexdigest()[:20]
        )
        titles = item.get("titleTranslate", {})
        chinese = (titles.get("zh-Hans") or titles.get("zh-Hant") or [item["title"]])[0]
        row = {"id": entry_id, "name": item["title"], "name_cn": chinese, "date": start.date().isoformat(),
               "platform": PLATFORMS.get(item.get("type"), ""), "eps": None}
        end = timestamp(item.get("end"))
        if end and end >= start and item.get("type") in ("tv", "web"):
            row["broadcast_end"] = end.date().isoformat()
        schedule = item.get("broadcast", "").split("/")
        regular = timestamp(schedule[1]) if len(schedule) == 3 and schedule[0] == "R" and schedule[2] == "P7D" else None
        if regular:
            row["weekday"] = regular.isoweekday()
            row["time_cst"] = regular.strftime("%H:%M")
        groups[quarter(start)].setdefault(entry_id, row)
    for index, group in groups.items():
        yield index, sorted(group.values(), key=lambda row: (row["date"], str(row["id"])))


def thumbnails(ids, directory, caches, proxy, workers, refresh):
    import requests
    from PIL import Image, ImageOps

    directory.mkdir(parents=True, exist_ok=True)
    context = threading.local()
    image_limit = 512 * 1024

    def thumb(subject):
        destination = directory / f"{subject}.jpg"
        if destination.is_file() and not refresh:
            return None
        try:
            data = None
            for cache in caches:
                candidate = cache / destination.name
                if candidate.is_file() and candidate.stat().st_size <= image_limit and not refresh:
                    data = candidate.read_bytes()
                    break
            if data is None:
                if not hasattr(context, "session"):
                    context.session = requests.Session()
                    context.session.trust_env = False
                    context.session.headers["User-Agent"] = USER_AGENT
                    if proxy:
                        context.session.proxies = {"https": proxy}
                url = f"https://api.bgm.tv/v0/subjects/{subject}/image?type=grid"
                for attempt in range(2):
                    with context.session.get(url, timeout=(8, 12), stream=True) as response:
                        if attempt == 0 and (response.status_code == 429 or response.status_code >= 500):
                            wait = response.headers.get("Retry-After", "3")
                            time.sleep(max(2, min(int(wait), 45)) if wait.isdecimal() else 3)
                            continue
                        response.raise_for_status()
                        if "no_icon_subject" in response.url:
                            return None if destination.is_file() else "source_has_no_image"
                        if not response.headers.get("Content-Type", "").startswith("image/"):
                            return None if destination.is_file() else "source_not_image"
                        data = bytearray()
                        for block in response.iter_content(16384):
                            data.extend(block)
                            if len(data) > image_limit:
                                return None if destination.is_file() else "source_image_too_large"
                        break
            img = ImageOps.exif_transpose(Image.open(BytesIO(data))).convert("RGB")
            img.thumbnail((100, 210), Image.Resampling.LANCZOS)
            output = BytesIO()
            img.save(output, "JPEG", quality=83, optimize=True)
            content = output.getvalue()
            if not destination.is_file() or destination.read_bytes() != content:
                temporary = destination.with_suffix(".tmp")
                temporary.write_bytes(content)
                temporary.replace(destination)
            return None
        except requests.HTTPError as error:
            return None if destination.is_file() else f"source_http_{error.response.status_code}"
        except requests.RequestException:
            return None if destination.is_file() else "source_unreachable"
        except (OSError, ValueError, TypeError):
            return None if destination.is_file() else "invalid_image"

    missing = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for index, (subject, reason) in enumerate(zip(ids, pool.map(thumb, ids)), start=1):
            if reason:
                missing[str(subject)] = reason
            if index % 200 == 0:
                print(f"Thumbnails checked: {index}/{len(ids)}, available: {index - len(missing)}", flush=True)
    return missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="bangumi-data dist/data.json")
    parser.add_argument("--checked-at", required=True, help="ISO timestamp of this full source check")
    parser.add_argument("--covers", action="store_true")
    parser.add_argument("--refresh-covers", action="store_true")
    parser.add_argument("--cache", type=Path, action="append", default=[])
    parser.add_argument("--proxy")
    parser.add_argument("--workers", type=int, choices=range(1, 13), default=6)
    args = parser.parse_args()
    checked = timestamp(args.checked_at)
    if not checked:
        parser.error("checked-at must have a timezone")
    original = args.source.read_bytes()
    generated = Path(__file__).resolve().parents[1] / "assets" / "season-catalog"
    generated.mkdir(parents=True, exist_ok=True)
    current = quarter(checked)
    grouped = list(rows_from(json.loads(original), FIRST_SEASON, current + 2))
    if any(not rows for index, rows in grouped if index <= current):
        parser.error("the source omits one or more past/current quarters")
    ids, missing_covers, seasons = set(), {}, {}
    for index, rows in grouped:
        if not rows:
            continue
        name = quarter_name(index)
        verify_due = quarter_start(index + 1) + timedelta(days=14)
        verified_at = args.checked_at if checked >= verify_due else None
        seasons[name] = len(rows)
        ids.update(row["id"] for row in rows if isinstance(row["id"], int))
        missing_covers.update({row["id"]: "no_bangumi_id" for row in rows if isinstance(row["id"], str)})
        write_json(generated / f"{name}.json", {"q": name, "total": len(rows), "items": rows,
                   "fetched_at": args.checked_at, "verified_at": verified_at, "source": "bangumi-data"})
    print(f"Built {len(seasons)} quarters, {sum(seasons.values())} entries, {len(ids)} Bangumi IDs", flush=True)
    if args.covers:
        missing_covers.update(thumbnails(sorted(ids), generated / "covers", args.cache, args.proxy,
                                         args.workers, args.refresh_covers))
    else:
        missing_covers.update({str(subject): "not_checked" for subject in sorted(ids)
                               if not (generated / "covers" / f"{subject}.jpg").is_file()})
    available = len(ids) - sum(str(subject) in missing_covers for subject in ids)
    print(f"Thumbnails available: {available}/{len(ids)}, placeholders: {len(missing_covers)}", flush=True)
    write_json(generated / "index.json", {"schema": 1, "source": SOURCE, "data_license": "CC BY 4.0",
               "source_sha256": sha256(original).hexdigest(), "checked_at": args.checked_at, "seasons": seasons,
               "thumbnails": available, "missing_covers": dict(sorted(missing_covers.items()))})


if __name__ == "__main__":
    main()
