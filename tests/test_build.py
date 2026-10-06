import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build", ROOT / "scripts/build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)

class BuildTests(unittest.TestCase):
    def test_pages_paths_remain_under_repository(self):
        text = '"https://assets.babylonjs.com/environments/studio.env";"https://cdn.babylonjs.com/draco_decoder_gltf.wasm"'
        result = build.rewrite_text(text, "/Babylon.js-PWA/")
        self.assertIn('"/Babylon.js-PWA/vendor/assets/environments/studio.env"', result)
        self.assertIn('"/Babylon.js-PWA/vendor/cdn/draco_decoder_gltf.wasm"', result)
        self.assertNotIn("https://", result)

    def test_required_inventory_has_all_configured_decoders(self):
        boot = (ROOT / "web/boot.js").read_text()
        for decoder in build.CDN_ASSETS:
            self.assertTrue(decoder in boot or decoder.startswith(("havok/", "glslang/", "twgsl/")), decoder)

    def test_generated_config_covers_every_file_with_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "index.html").write_text("app")
            (out / "model.glb").write_bytes(b"model")
            first = build.finalize(out, {})
            self.assertEqual({file["path"] for file in first["files"]}, {"index.html", "model.glb"})
            self.assertTrue(all(file["integrity"].startswith("sha256-") for file in first["files"]))
            self.assertNotIn("__OFFLINE_CONFIG__", (out / "sw.js").read_text())
            self.assertEqual(first, json.loads((out / "offline-config.json").read_text()))
            self.assertEqual(first["version"], build.finalize(out, {})["version"])
            (out / "model.glb").write_bytes(b"new model")
            self.assertNotEqual(first["version"], build.finalize(out, {})["version"])

    def test_model_scope_and_manifest(self):
        manifest = json.loads((ROOT / "web/manifest.webmanifest").read_text())
        self.assertEqual(manifest["scope"], "./")
        self.assertEqual(manifest["start_url"], "./")
        self.assertEqual(manifest["display"], "standalone")
        for size in (192, 512):
            data = build.png_icon(size)
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(int.from_bytes(data[16:20], "big"), size)

    def test_url_validation(self):
        with self.assertRaises(ValueError):
            build.local_path("https://evil.example/private.js")
        with self.assertRaises(ValueError):
            build.local_path("https://cdn.babylonjs.com/../../escape.js")

if __name__ == "__main__":
    unittest.main()
