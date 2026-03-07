from pathlib import Path


def test_repository_contains_readme():
    assert Path('README.md').exists()


def test_repository_contains_package_json():
    assert Path('package.json').exists()
