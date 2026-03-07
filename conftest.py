"""Project-level pytest compatibility hooks.

This repo is primarily a JavaScript project and may run pytest without the
pytest-cov plugin installed. We accept common coverage CLI flags so
`pytest --cov=./` still runs instead of failing on argument parsing.
"""


def pytest_addoption(parser):
    parser.addoption(
        "--cov",
        action="append",
        default=[],
        metavar="SOURCE",
        help="Compatibility flag when pytest-cov is unavailable.",
    )
    parser.addoption(
        "--cov-report",
        action="append",
        default=[],
        metavar="TYPE",
        help="Compatibility flag when pytest-cov is unavailable.",
    )
    parser.addoption(
        "--cov-fail-under",
        action="store",
        default=None,
        metavar="MIN",
        help="Compatibility flag when pytest-cov is unavailable.",
    )
