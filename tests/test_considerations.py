from stoxlib import considerations


def test_load_considerations_returns_empty_list_when_file_missing():
    assert considerations.load_considerations() == []


def test_add_consideration_then_load_round_trips():
    considerations.add_consideration("always factor in insider selling")
    assert considerations.load_considerations() == ["always factor in insider selling"]


def test_add_consideration_appends_multiple():
    considerations.add_consideration("first factor")
    considerations.add_consideration("second factor")
    assert considerations.load_considerations() == ["first factor", "second factor"]


def test_add_consideration_skips_exact_duplicates():
    considerations.add_consideration("same factor")
    considerations.add_consideration("same factor")
    assert considerations.load_considerations() == ["same factor"]


def test_add_consideration_ignores_blank_text():
    considerations.add_consideration("   ")
    assert considerations.load_considerations() == []


def test_add_consideration_strips_whitespace():
    considerations.add_consideration("  padded factor  ")
    assert considerations.load_considerations() == ["padded factor"]


def test_load_considerations_skips_blank_lines_and_comments():
    considerations.CONSIDERATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    considerations.CONSIDERATIONS_FILE.write_text(
        "# hand-written comment\n\nreal factor\n   \n# another comment\n"
    )
    assert considerations.load_considerations() == ["real factor"]


def test_add_consideration_creates_parent_directory(tmp_path, monkeypatch):
    nested = tmp_path / "nested" / "dir" / "considerations.txt"
    monkeypatch.setattr(considerations, "CONSIDERATIONS_FILE", nested)
    considerations.add_consideration("a factor")
    assert nested.exists()
    assert considerations.load_considerations() == ["a factor"]
