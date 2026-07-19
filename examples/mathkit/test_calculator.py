"""Pytest tests for the mathkit :class:`Calculator`.

These tests import :class:`Calculator` from :mod:`calculator` (the sibling
module in this package) and exercise its arithmetic methods, method
chaining, reset behaviour, and divide-by-zero error handling.

Run from within ``examples/mathkit`` so the sibling ``calculator`` /
``operations`` modules are importable, e.g.::

    cd examples/mathkit && pytest
"""

from __future__ import annotations

import pytest

from calculator import Calculator


def test_initial_value_defaults_to_zero() -> None:
    assert Calculator().value == 0.0


def test_initial_value_is_configurable() -> None:
    assert Calculator(10).value == 10


def test_add() -> None:
    assert Calculator(2).add(3).value == 5


def test_subtract() -> None:
    assert Calculator(5).subtract(2).value == 3


def test_multiply() -> None:
    assert Calculator(4).multiply(3).value == 12


def test_divide() -> None:
    assert Calculator(9).divide(3).value == 3


def test_divide_by_zero_raises_value_error() -> None:
    with pytest.raises(ValueError):
        Calculator(1).divide(0)


def test_reset_defaults_to_zero() -> None:
    calc = Calculator(42)
    calc.reset()
    assert calc.value == 0.0


def test_reset_to_specific_value() -> None:
    calc = Calculator(42)
    calc.reset(7)
    assert calc.value == 7


def test_methods_return_self_for_chaining() -> None:
    calc = Calculator(1)
    assert calc.add(1) is calc
    assert calc.subtract(1) is calc
    assert calc.multiply(2) is calc
    assert calc.divide(2) is calc
    assert calc.reset() is calc


def test_method_chaining_matches_docstring_example() -> None:
    assert Calculator(2).add(3).multiply(4).value == 20.0


def test_longer_chain() -> None:
    result = Calculator(10).add(5).subtract(3).multiply(2).divide(4).value
    assert result == 6.0


@pytest.mark.parametrize(
    ("start", "delta", "expected"),
    [
        (0, 0, 0),
        (-5, 5, 0),
        (2.5, 0.5, 3.0),
    ],
)
def test_add_parametrized(start: float, delta: float, expected: float) -> None:
    assert Calculator(start).add(delta).value == expected
