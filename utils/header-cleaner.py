filename = input()
def delete_even_lines(filename):
    with open(filename, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # Keep only even-numbered lines (2, 4, 6, ...)
    even_lines = [line for i, line in enumerate(lines, start=1) if i % 2 == 1]

    with open(filename, "w", encoding="utf-8") as f:
        f.writelines(even_lines)


if __name__ == "__main__":
    delete_even_lines(filename)
