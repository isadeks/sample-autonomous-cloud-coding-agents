"""A small calculator built on top of the mathkit arithmetic operations.

This module imports the primitive operations from :mod:`operations` and
composes them into a tiny :class:`Calculator` helper plus a simple
command-line demo.
"""

from __future__ import annotations

from operations import add, divide, multiply, subtract


class Calculator:
    """Stateful calculator that accumulates a running result.

    Each method mutates and returns the running :attr:`value`, so calls can be
    chained::

        >>> Calculator(2).add(3).multiply(4).value
        20.0
    """

    def __init__(self, value: float = 0.0) -> None:
        self.value = value

    def add(self, other: float) -> "Calculator":
        """Add ``other`` to the running value."""
        self.value = add(self.value, other)
        return self

    def subtract(self, other: float) -> "Calculator":
        """Subtract ``other`` from the running value."""
        self.value = subtract(self.value, other)
        return self

    def multiply(self, other: float) -> "Calculator":
        """Multiply the running value by ``other``."""
        self.value = multiply(self.value, other)
        return self

    def divide(self, other: float) -> "Calculator":
        """Divide the running value by ``other``.

        Raises:
            ValueError: If ``other`` is zero.
        """
        self.value = divide(self.value, other)
        return self

    def reset(self, value: float = 0.0) -> "Calculator":
        """Reset the running value back to ``value`` (default ``0.0``)."""
        self.value = value
        return self


def main() -> None:
    """Run a short demonstration of the calculator operations."""
    print("add(2, 3)      =", add(2, 3))
    print("subtract(5, 2) =", subtract(5, 2))
    print("multiply(4, 3) =", multiply(4, 3))
    print("divide(9, 3)   =", divide(9, 3))

    result = Calculator(10).add(5).subtract(3).multiply(2).divide(4).value
    print("chained result =", result)


if __name__ == "__main__":
    main()
