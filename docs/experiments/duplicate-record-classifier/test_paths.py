from pathlib import Path
import unittest
from paths import checkout_roots,repository_root


class RelocatedArchivePaths(unittest.TestCase):
    def test_finds_repository_from_nested_artifact(self):
        root=repository_root(Path(__file__).parent/'round5/url_parity.py')
        self.assertTrue((root/'ARCHITECTURE.md').is_file())
        self.assertTrue((root/'packages/server/src/records/derive.ts').is_file())
    def test_private_exports_are_protected_across_archive_depth(self):
        roots=checkout_roots(Path(__file__).parent/'round2/shadow.py')
        destination=Path(__file__).resolve().parent/'round2/private-export'
        self.assertTrue(any(root in destination.parents for root in roots))
        self.assertFalse(any(root==Path('/tmp').resolve() or root in Path('/tmp').resolve().parents for root in roots))

if __name__=='__main__':unittest.main()
