"""Publication boundary and tamper checks; no network or game art needed."""
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("release_candidate", Path(__file__).resolve().parents[1] / "tools/release-candidate.py")
rc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rc)


class PublicationBoundaryTest(unittest.TestCase):
    def test_bundle_root_notices_keep_local_links(self):
        self.assertEqual(rc.root_doc('[来源](docs/REFERENCES.md) [许可](LICENSE) [官网](https://example.com) [章节](#a)'),
                         '[来源](app/docs/REFERENCES.md) [许可](app/LICENSE) [官网](https://example.com) [章节](#a)')

    def test_unsafe_paths_rejected(self):
        for name in ("../x", "/x", "a/../b", "a\\b", "a//b", "C:/x", "a/x."):
            with self.subTest(name=name), self.assertRaises(ValueError):
                rc.safe_rel(name)

    def test_only_base_upstream_art_selected(self):
        self.assertEqual(rc.upstream_art("Stronghold-Protocol/public/assets/a.png"), "public/assets/a.png")
        for name in ("Stronghold-Protocol/public/assets/local/fx/a.png", "Stronghold-Protocol/data/local-skins.json",
                     "Stronghold-Protocol/runtime/settings.json", "other/public/assets/a.png"):
            self.assertIsNone(rc.upstream_art(name))

    def test_hash_mismatch_stops_before_extract(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "input.zip"
            p.write_bytes(b"wrong")
            with self.assertRaises(ValueError):
                rc.checked_input(p, "0" * 64)

    def test_symlink_and_case_collision_rejected(self):
        for symlink in (True, False):
            with tempfile.TemporaryDirectory() as d:
                p = Path(d) / "input.zip"
                with zipfile.ZipFile(p, "w") as z:
                    info = zipfile.ZipInfo("Stronghold-Protocol/public/assets/A.png")
                    info.create_system = 3
                    info.external_attr = ((stat.S_IFLNK if symlink else stat.S_IFREG) | 0o644) << 16
                    z.writestr(info, b"bytes")
                    if not symlink:
                        z.writestr("Stronghold-Protocol/public/assets/a.png", b"bytes")
                with self.assertRaises(ValueError):
                    rc.extract_art(p, Path(d) / "app")

    def test_art_provenance_and_sidecars_enforced_at_final_inventory(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            p = root / "app/public/assets/a.png"
            rc.put(p, b"local substitute")
            with self.assertRaises(ValueError):
                rc.make_inventory(root, {})
            p.unlink()
            rc.put(root / "app/data/local-skins.json", b"{}")
            with self.assertRaises(ValueError):
                rc.make_inventory(root, {})

    def test_archive_verifies_actual_bytes_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "candidate"
            rc.put(root / "app/server/index.js", b"export {}")
            inventory = rc.make_inventory(root, {})
            archive = Path(d) / "candidate.zip"
            rc.archive_bundle(root, archive)
            self.assertEqual(rc.verify_archive(archive, inventory)["files"], 2)
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("candidate/app/server/index.js", b"export {}")
                z.writestr("candidate/PACKAGE-MANIFEST.json", b"tampered")
            with self.assertRaises(ValueError):
                rc.verify_archive(archive, inventory)


if __name__ == "__main__":
    unittest.main()
