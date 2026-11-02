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
    def test_server_notice_keeps_complete_upstream_sections_and_fork_changes(self):
        notes = "# Release\n\n### 本分支新增与修复\n\n- 本分支修复。\n\n以上概括自上游来源。\n\n## 下载与素材边界\n下载说明。"
        changes = "## 0.3.3 — today\n\n- 完整热修复 @AuthorA\n\n## 0.3.2 — yesterday\n\n### 规则\n\n- 全部规则 @AuthorB\n\n### 工具\n\n- 全部工具\n\n## 0.3.1 — old\n旧日志"
        body = rc.server_announcement(notes, changes)
        self.assertIn("- 完整热修复 @AuthorA", body)
        self.assertIn("### 工具\n\n- 全部工具", body)
        self.assertIn("@AuthorB", body)
        self.assertIn("- 本分支修复。", body)
        self.assertNotIn("旧日志", body)
        self.assertNotIn("下载说明", body)
        with self.assertRaises(ValueError):
            rc.server_announcement(notes, changes.replace("## 0.3.2", "## 0.4.2"))

    def test_bundle_root_notices_keep_local_links(self):
        self.assertEqual(rc.root_doc('[来源](docs/REFERENCES.md) [许可](LICENSE) [官网](https://example.com) [章节](#a)'),
                         '[来源](app/docs/REFERENCES.md) [许可](app/LICENSE) [官网](https://example.com) [章节](#a)')

    def test_unsafe_paths_rejected(self):
        for name in ("../x", "/x", "a/../b", "a\\b", "a//b", "C:/x", "a/x."):
            with self.subTest(name=name), self.assertRaises(ValueError):
                rc.safe_rel(name)

    def test_only_verified_upstream_art_and_required_indexes_selected(self):
        self.assertEqual(rc.upstream_art("Stronghold-Protocol/public/assets/a.png"), "public/assets/a.png")
        self.assertEqual(rc.upstream_art("Stronghold-Protocol/public/assets/local/fx/a.png"), "public/assets/local/fx/a.png")
        self.assertEqual(rc.upstream_art("Stronghold-Protocol/data/assets.json"), "data/assets.json")
        self.assertEqual(rc.upstream_art("Stronghold-Protocol/data/local-assets.json"), "data/local-assets.json")
        self.assertEqual(rc.upstream_art("Stronghold-Protocol/data/local-fx.json"), "data/local-fx.json")
        for name in ("Stronghold-Protocol/data/local-skins.json", "Stronghold-Protocol/public/assets/local/.env",
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

    def test_upstream_local_assets_require_exact_provenance_and_no_missing_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = root / "upstream.zip"
            app = root / "bundle/app"
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("Stronghold-Protocol/public/assets/local/fx/source.bin", b"upstream art")
                z.writestr("Stronghold-Protocol/data/local-fx.json", b"{}")
            provenance = rc.extract_art(archive, app)
            rc.make_inventory(root / "bundle", provenance)
            art = app / "public/assets/local/fx/source.bin"
            art.write_bytes(b"local replacement")
            with self.assertRaises(ValueError):
                rc.make_inventory(root / "bundle", provenance)
            art.unlink()
            with self.assertRaises(ValueError):
                rc.make_inventory(root / "bundle", provenance)


if __name__ == "__main__":
    unittest.main()
