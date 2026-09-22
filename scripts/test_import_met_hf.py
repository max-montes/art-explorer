"""Run with: python3 -m unittest scripts/test_import_met_hf.py"""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "import_met_hf", Path(__file__).with_name("import-met-hf.py")
)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def row(**overrides: str) -> dict[str, str]:
    base = {
        "isPublicDomain": "True",
        "classification": "Paintings",
        "objectName": "Painting",
        "department": "European Paintings",
        "primaryImage": "https://images.metmuseum.org/x.jpg",
        "objectURL": "https://www.metmuseum.org/art/collection/search/1",
        "objectID": "1",
        "title": "A Title",
    }
    return {**base, **overrides}


class ToEntryTest(unittest.TestCase):
    def test_classified_painting_is_included(self):
        self.assertEqual(importer.to_entry(row())["id"], "met-1")

    def test_blank_classification_falls_back_to_exact_object_name(self):
        american = row(classification="", department="The American Wing")
        self.assertIsNotNone(importer.to_entry(american))

    def test_blank_classification_rejects_other_object_names(self):
        for name in ("Painting, miniature", "Vase", "Watercolor", ""):
            with self.subTest(name=name):
                candidate = row(classification="", objectName=name)
                self.assertIsNone(importer.to_entry(candidate))

    def test_non_painting_classification_is_not_rescued_by_object_name(self):
        self.assertIsNone(importer.to_entry(row(classification="Glass")))

    def test_manuscript_like_objects_are_excluded(self):
        for name in ("Folio", "manuscript", "Initiation Card"):
            with self.subTest(name=name):
                self.assertIsNone(importer.to_entry(row(objectName=name)))

    def test_lehman_collection_is_an_allowed_department(self):
        lehman = row(department="Robert Lehman Collection")
        self.assertIsNotNone(importer.to_entry(lehman))

    def test_unlisted_department_is_excluded(self):
        self.assertIsNone(importer.to_entry(row(department="Arms and Armor")))

    def test_not_public_domain_is_excluded(self):
        self.assertIsNone(importer.to_entry(row(isPublicDomain="False")))


if __name__ == "__main__":
    unittest.main()
