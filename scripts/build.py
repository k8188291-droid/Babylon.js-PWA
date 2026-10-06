#!/usr/bin/env python3
"""Mirror a coherent deployed Sandbox snapshot into a self-contained Pages PWA.

Builds require internet access. Runtime startup and local model viewing do not.
All required assets are mandatory; an upstream failure fails the build.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
import zlib

PROJECT = Path(__file__).resolve().parents[1]
SOURCES = {
    "cdn.babylonjs.com": "vendor/cdn",
    "preview.babylonjs.com": "vendor/preview",
    "assets.babylonjs.com": "vendor/assets",
    "sandbox.babylonjs.com": "vendor/sandbox",
}
LIBRARIES = [
    "babylon.js", "addons/babylonjs.addons.min.js",
    "loaders/babylonjs.loaders.min.js", "serializers/babylonjs.serializers.min.js",
    "materialsLibrary/babylonjs.materials.min.js", "gui/babylon.gui.min.js",
    "inspector/babylon.inspector-v2.bundle.js",
]
CDN_ASSETS = [
    "ammo.js", "cannon.js", "Oimo.js", "havok/HavokPhysics_umd.js",
    "havok/HavokPhysics.wasm", "draco_wasm_wrapper_gltf.js", "draco_decoder_gltf.wasm",
    "draco_decoder_gltf.js", "meshopt_decoder.js", "gltf_validator.js",
    "babylon.ktx2Decoder.js", "ktx2Transcoders/1/uastc_astc.wasm",
    "ktx2Transcoders/1/uastc_bc7.wasm", "ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm",
    "ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm", "ktx2Transcoders/1/msc_basis_transcoder.js",
    "ktx2Transcoders/1/msc_basis_transcoder.wasm", "zstddec.wasm",
    "basisTranscoder/1/basis_transcoder.js", "basisTranscoder/1/basis_transcoder.wasm",
    "glslang/glslang.js", "glslang/glslang.wasm", "twgsl/twgsl.js", "twgsl/twgsl.wasm",
]
ENVIRONMENTS = ["sanGiuseppeBridge.env", "ulmerMuenster.env", "studio.env"]
URL_PATTERN = re.compile(r"https?://(?:cdn|preview|assets|sandbox)\.babylonjs\.com/[^\s\"'`<>\\)]+")
RUNTIME_SUFFIXES = {".js", ".wasm", ".env", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".glb"}

def get(url):
    for attempt in range(3):
        try:
            request = Request(url, headers={"User-Agent": "Babylon-Sandbox-Offline-PWA/1.0"})
            with urlopen(request, timeout=90) as response:
                data = response.read()
                content_type = response.headers.get("Content-Type", "")
            if not data or "text/html" in content_type:
                raise ValueError(f"Expected asset, received empty response/HTML: {url}")
            return data
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def normalize(url):
    parts = urlsplit(url)
    if parts.hostname not in SOURCES or ".." in parts.path.split("/"):
        raise ValueError(f"Unsupported asset URL: {url}")
    return urlunsplit(("https", parts.netloc, parts.path, "", ""))

def local_path(url):
    parts = urlsplit(normalize(url))
    return SOURCES[parts.hostname] + parts.path

def rewrite_text(text, base_path):
    # Root-relative URLs also work in blob workers and nested decoder scripts.
    for host, directory in SOURCES.items():
        text = text.replace(f"https://{host}/", base_path + directory + "/")
        text = text.replace(f"http://{host}/", base_path + directory + "/")
    return re.sub(r"//# sourceMappingURL=[^\r\n]+", "", text)

def png_icon(size):
    # The same three simple cube facets used in icon.svg; no build dependencies.
    polygons = [
        ([(256,108),(384,182),(256,256),(128,182)], (255,178,76)),
        ([(128,182),(256,256),(256,404),(128,330)], (240,121,54)),
        ([(256,256),(384,182),(384,330),(256,404)], (195,68,48)),
    ]
    def inside(x, y, polygon):
        found = False
        for i, (ax, ay) in enumerate(polygon):
            bx, by = polygon[(i + 1) % len(polygon)]
            if (ay > y) != (by > y) and x < (bx-ax)*(y-ay)/(by-ay) + ax:
                found = not found
        return found
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            color = (23,28,37)
            for polygon, fill in polygons:
                if inside((x+.5)*512/size, (y+.5)*512/size, polygon):
                    color = fill
            raw.extend(color)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB",size,size,8,2,0,0,0)) + chunk(b"IDAT", zlib.compress(raw,9)) + chunk(b"IEND",b"")

def finalize(out, aliases):
    files = []
    for path in sorted(out.rglob("*")):
        if path.is_file() and path.name not in {"sw.js", "offline-config.json"}:
            digest = hashlib.sha256(path.read_bytes()).digest()
            files.append({"path": path.relative_to(out).as_posix(), "integrity": "sha256-" + base64.b64encode(digest).decode()})
    version = hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()[:20]
    config = {"version": version, "files": files, "aliases": aliases}
    encoded = json.dumps(config, ensure_ascii=False, separators=(",", ":"))
    source = (PROJECT / "web/sw.template.js").read_text()
    (out / "sw.js").write_text(source.replace("__OFFLINE_CONFIG__", encoded))
    (out / "offline-config.json").write_text(encoded)
    return config

def build(base_path, out):
    if not re.fullmatch(r"/(?:[A-Za-z0-9_.-]+/)*", base_path):
        raise ValueError("BASE_PATH must be / or a Pages repository path ending with /")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for path in (PROJECT / "web").iterdir():
        if path.is_file() and path.name != "sw.template.js":
            shutil.copyfile(path, out / path.name)
    icons = out / "icons"
    icons.mkdir()
    for name, size in [("icon-192.png",192),("icon-512.png",512),("icon-maskable-512.png",512)]:
        (icons / name).write_bytes(png_icon(size))

    # The upstream deployment uses preview libraries with timestamp.js. Capture
    # all artifacts in a single snapshot and reject a CDN rollover mid-build.
    timestamp_url = "https://cdn.babylonjs.com/timestamp.js"
    timestamp = get(timestamp_url + "?offline-build=" + str(time.time_ns()))
    pending = {"https://sandbox.babylonjs.com/babylon.sandbox.js"}
    pending |= {"https://preview.babylonjs.com/" + path for path in LIBRARIES}
    pending |= {"https://cdn.babylonjs.com/" + path for path in CDN_ASSETS}
    pending |= {"https://assets.babylonjs.com/environments/" + name for name in ENVIRONMENTS}
    pending.add("https://assets.babylonjs.com/meshes/YetiSmall.glb")
    downloaded = {}
    aliases = {}
    provenance = []
    for round_number in range(5):
        batch = sorted(pending - downloaded.keys())
        if not batch:
            break
        if len(downloaded) + len(batch) > 160:
            raise ValueError("Unexpected upstream asset graph; inspect before publishing")
        def download(url):
            return url, get(url + "?offline-snapshot=" + hashlib.sha256(timestamp).hexdigest()[:16])
        with ThreadPoolExecutor(max_workers=6) as pool:
            for url, data in pool.map(download, batch):
                downloaded[url] = data
                path = "babylon.sandbox.js" if url == "https://sandbox.babylonjs.com/babylon.sandbox.js" else local_path(url)
                aliases[url] = path
                provenance.append({"url": url, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
                if path.endswith(".js"):
                    original = data.decode("utf-8")
                    # Discover CDN scripts/textures that the current engine adds.
                    # Assets-site discovery is bounded to our required environments
                    # and default model, rather than every online example/link.
                    for match in URL_PATTERN.findall(original):
                        candidate = normalize(match)
                        parts = urlsplit(candidate)
                        suffix = Path(parts.path).suffix.lower()
                        if parts.hostname in {"cdn.babylonjs.com", "preview.babylonjs.com"} and suffix in RUNTIME_SUFFIXES:
                            pending.add(candidate)
                    data = rewrite_text(original, base_path).encode()
                target = out / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                print(f"Mirrored {path} ({len(data):,} bytes)", flush=True)
    if pending - downloaded.keys():
        raise ValueError("Dependency discovery did not converge")
    if get(timestamp_url + "?offline-check=" + str(time.time_ns())) != timestamp:
        raise ValueError("Babylon CDN changed during build; retry to capture a consistent snapshot")
    (out / "upstream-snapshot.json").write_text(json.dumps({
        "timestamp": timestamp.decode(), "base_path": base_path, "assets": provenance
    },indent=2))
    for name in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
        shutil.copyfile(PROJECT / name, out / name)
    (out / ".nojekyll").touch()
    config = finalize(out, aliases)
    print(f"Built {len(config['files'])} verified offline files, version {config['version']}")
    return config

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-path", default="/Babylon.js-PWA/")
    parser.add_argument("--output", type=Path, default=PROJECT / "dist")
    args = parser.parse_args()
    build(args.base_path, args.output.resolve())
