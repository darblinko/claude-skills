"""Check that every skill folder is installable and that relative links resolve."""

import os
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".venv", "node_modules", ".pytest_cache", ".ruff_cache"}
SKILL_DIRS = sorted(path for path in (REPO_ROOT / "skills").iterdir() if path.is_dir())
LINK_PATTERNS = [
    re.compile(r"\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)"),
    re.compile(r"""(?:src|href|srcset)=["']([^"']+)["']"""),
]


def published_files(suffixes):
    for directory, subdirs, files in os.walk(REPO_ROOT):
        subdirs[:] = [name for name in subdirs if name not in SKIP_DIRS]
        for name in files:
            if Path(name).suffix in suffixes:
                yield Path(directory) / name


def frontmatter(skill_md):
    match = re.match(r"---\n(.*?)\n---\n", skill_md.read_text(), re.DOTALL)
    assert match, f"{skill_md} has no frontmatter"
    fields = {}
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip().strip('"')
    return fields


def is_relative(target):
    return not re.match(r"^(https?:|mailto:|data:|#)", target)


@pytest.mark.parametrize("skill_dir", SKILL_DIRS, ids=lambda path: path.name)
def test_skill_folder_has_skill_md_and_readme(skill_dir):
    fields = frontmatter(skill_dir / "SKILL.md")
    assert fields["name"] == skill_dir.name
    assert len(fields["description"]) > 20
    assert (skill_dir / "README.md").is_file()


def test_relative_links_resolve():
    broken = []
    for document in published_files({".md", ".html"}):
        text = document.read_text()
        for pattern in LINK_PATTERNS:
            for target in pattern.findall(text):
                target = target.split("#")[0].split("?")[0]
                if target and is_relative(target) and not (document.parent / target).exists():
                    broken.append(f"{document.relative_to(REPO_ROOT)}: {target}")
    assert broken == []
