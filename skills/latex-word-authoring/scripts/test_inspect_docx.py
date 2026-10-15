import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("inspect_docx", Path(__file__).with_name("inspect_docx.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def make_docx(path, content, extras=None):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("word/document.xml", content)
        for name, data in (extras or {}).items():
            archive.writestr(name, data)


DOC = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>
 <w:p><w:r><w:t>Hello 中文</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>
 <w:tbl><w:tr><w:tc><w:p><w:ins><w:r><w:t>New</w:t></w:r></w:ins></w:p></w:tc></w:tr></w:tbl>
 </w:body></w:document>'''


class InspectDocxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "sample.docx"

    def test_read_only_counts_and_hash(self):
        make_docx(self.file, DOC)
        original = self.file.read_bytes()
        result = module.inspect_docx(self.file)
        self.assertEqual(result["counts"]["formulas"], 1)
        self.assertEqual(result["counts"]["tables"], 1)
        self.assertEqual(result["counts"]["paragraphs"], 2)
        self.assertEqual(result["counts"]["tracked_insertions"], 1)
        self.assertEqual(result["counts"]["text_characters"], len("Hello 中文New"))
        self.assertEqual(len(result["sha256"]), 64)
        self.assertEqual(self.file.read_bytes(), original)

    def test_reports_external_links_without_fetching(self):
        relationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship TargetMode="External" Target="http://127.0.0.1:1/private"/></Relationships>'
        make_docx(self.file, DOC, {"word/_rels/document.xml.rels": relationships})
        self.assertEqual(module.inspect_docx(self.file)["counts"]["external_relationships"], 1)

    def test_rejects_missing_body(self):
        with zipfile.ZipFile(self.file, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
        with self.assertRaisesRegex(ValueError, "required"):
            module.inspect_docx(self.file)

    def test_rejects_xml_entities(self):
        make_docx(self.file, '<!DOCTYPE x [<!ENTITY y "bad">]><x>&y;</x>')
        with self.assertRaisesRegex(ValueError, "DTD/entity"):
            module.inspect_docx(self.file)

    def test_rejects_utf16_xml_entities(self):
        make_docx(self.file, '<?xml version="1.0" encoding="utf-16"?><!DOCTYPE x [<!ENTITY y "bad">]><x>&y;</x>'.encode("utf-16"))
        with self.assertRaisesRegex(ValueError, "DTD/entity"):
            module.inspect_docx(self.file)

    def test_rejects_non_word_body(self):
        make_docx(self.file, "<not-a-word-document/>")
        with self.assertRaisesRegex(ValueError, "root"):
            module.inspect_docx(self.file)

    def test_rejects_macro_package(self):
        make_docx(self.file, DOC, {"word/vbaProject.bin": b"macro"})
        with self.assertRaisesRegex(ValueError, "Macro"):
            module.inspect_docx(self.file)

    def test_rejects_unsafe_paths(self):
        make_docx(self.file, DOC, {"../outside": b"data"})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            module.inspect_docx(self.file)

    def test_formula_loss_is_observable(self):
        make_docx(self.file, DOC)
        before = module.inspect_docx(self.file)
        candidate = self.file.with_name("candidate.docx")
        make_docx(candidate, '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>')
        self.assertEqual(before["counts"]["formulas"], 1)
        self.assertEqual(module.inspect_docx(candidate)["counts"]["formulas"], 0)


if __name__ == "__main__":
    unittest.main()
