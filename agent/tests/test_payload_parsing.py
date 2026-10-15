"""Explicit parsing of the per-repo convergence fields in the invocation payload."""

from __future__ import annotations

import pytest

from server import _payload_bool, _payload_int


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({}, False),
        ({"k": True}, True),
        ({"k": False}, False),
        ({"k": "true"}, True),
        ({"k": "False"}, False),
    ],
)
def test_bool_fields(raw, expected):
    assert _payload_bool(raw, "k") is expected


@pytest.mark.parametrize("bad", ["yes", "0", 1, None])
def test_bool_fields_reject_ambiguous_values(bad):
    with pytest.raises(ValueError, match="'k' must be a boolean"):
        _payload_bool({"k": bad}, "k")


@pytest.mark.parametrize(
    ("raw", "expected"), [({}, 0), ({"k": None}, 0), ({"k": 900}, 900), ({"k": "900"}, 900)]
)
def test_int_fields(raw, expected):
    assert _payload_int(raw, "k") == expected


@pytest.mark.parametrize("bad", ["soon", True, 1.5, -1])
def test_int_fields_reject_garbage(bad):
    with pytest.raises(ValueError, match="'k' must be"):
        _payload_int({"k": bad}, "k")
