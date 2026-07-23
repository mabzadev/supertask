#!/usr/bin/env python3
import ast
import json
from pathlib import Path


SOURCE = Path(
    "/Users/appmonster/Workspace/baserow/backend/tests/baserow/contrib/database/formula/"
    "test_baserow_formula_results.py"
)
TARGET = Path(__file__).resolve().parents[1] / "tests/cases/baserow_formula_source_cases.json"


def safe_constant(expression):
    if isinstance(expression, ast.Constant):
        return expression.value
    if isinstance(expression, ast.Tuple):
        return tuple(safe_constant(item) for item in expression.elts)
    if isinstance(expression, ast.List):
        return [safe_constant(item) for item in expression.elts]
    if isinstance(expression, ast.Dict):
        return {
            safe_constant(key): safe_constant(value)
            for key, value in zip(expression.keys, expression.values)
        }
    if isinstance(expression, ast.JoinedStr):
        return "".join(
            str(safe_constant(item.value)) if isinstance(item, ast.FormattedValue) else str(safe_constant(item))
            for item in expression.values
        )
    if isinstance(expression, ast.Call):
        if (
            isinstance(expression.func, ast.Attribute)
            and expression.func.attr == "getrecursionlimit"
            and isinstance(expression.func.value, ast.Name)
            and expression.func.value.id == "sys"
            and not expression.args
        ):
            return 1000
        if (
            isinstance(expression.func, ast.Attribute)
            and expression.func.attr == "join"
            and len(expression.args) == 1
        ):
            separator = safe_constant(expression.func.value)
            values = safe_constant(expression.args[0])
            if isinstance(separator, str) and isinstance(values, list):
                return separator.join(values)
    if isinstance(expression, ast.UnaryOp) and isinstance(expression.op, ast.USub):
        value = safe_constant(expression.operand)
        if isinstance(value, (int, float)):
            return -value
    if (
        isinstance(expression, ast.Attribute)
        and expression.attr == "MAX_FORMULA_STRING_LENGTH"
        and isinstance(expression.value, ast.Name)
        and expression.value.id == "settings"
    ):
        return 10000
    if isinstance(expression, ast.BinOp):
        left = safe_constant(expression.left)
        right = safe_constant(expression.right)
        if isinstance(expression.op, ast.Add):
            return left + right
        if isinstance(expression.op, ast.Sub):
            return left - right
        if isinstance(expression.op, ast.Mult):
            return left * right
        if isinstance(expression.op, ast.Div):
            return left / right
    raise ValueError("The expression is not a safe constant.")


def is_json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, list):
        return all(is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and is_json_value(item) for key, item in value.items())
    return False


def main():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    assignments = {
        target.id: node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    assignment = assignments["VALID_FORMULA_TESTS"]
    cases = []
    skipped = []
    for expression in assignment.elts:
        try:
            value = safe_constant(expression)
        except (ValueError, TypeError, ZeroDivisionError):
            skipped.append(ast.unparse(expression))
            continue
        if (
            isinstance(value, tuple)
            and len(value) == 2
            and isinstance(value[0], str)
            and is_json_value(value[1])
        ):
            cases.append({"formula": value[0], "expected": value[1]})
        else:
            skipped.append(ast.unparse(expression))

    invalid_cases = []
    skipped_invalid = []
    for expression in assignments["INVALID_FORMULA_TESTS"].elts:
        try:
            value = safe_constant(expression)
        except (ValueError, TypeError, ZeroDivisionError):
            skipped_invalid.append(ast.unparse(expression))
            continue
        if isinstance(value, tuple) and len(value) == 3 and isinstance(value[0], str):
            invalid_cases.append({"formula": value[0], "error": value[1], "detail": value[2]})
        else:
            skipped_invalid.append(ast.unparse(expression))

    nullable_cases = []
    skipped_nullable = []
    for expression in assignments["NULLABLE_FORMULA_TESTS"].elts:
        try:
            value = safe_constant(expression)
        except (ValueError, TypeError, ZeroDivisionError):
            skipped_nullable.append(ast.unparse(expression))
            continue
        if isinstance(value, tuple) and len(value) == 3:
            nullable_cases.append({"fields": value[0], "formula": value[1], "nullable": value[2]})
        else:
            skipped_nullable.append(ast.unparse(expression))

    TARGET.write_text(
        json.dumps(
            {
                "source": str(SOURCE),
                "cases": cases,
                "skipped_non_literal_cases": skipped,
                "invalid_cases": invalid_cases,
                "skipped_invalid_cases": skipped_invalid,
                "nullable_cases": nullable_cases,
                "skipped_nullable_cases": skipped_nullable,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        f"Extracted {len(cases)} valid, {len(invalid_cases)} invalid and "
        f"{len(nullable_cases)} nullable cases; skipped "
        f"{len(skipped) + len(skipped_invalid) + len(skipped_nullable)} cases."
    )


if __name__ == "__main__":
    main()
