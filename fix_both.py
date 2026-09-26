import sys

def resolve_test_conflicts(filepath):
    with open(filepath, 'r') as f:
        lines = f.readlines()

    out = []
    in_head = False
    in_upstream = False
    skip_marker = False

    for line in lines:
        if line.startswith("<<<<<<< HEAD"):
            continue
        elif line.startswith("======="):
            continue
        elif line.startswith(">>>>>>> upstream/main"):
            continue
        else:
            out.append(line)

    with open(filepath, 'w') as f:
        f.writelines(out)
        print("Resolved conflicts by keeping both sides.")

if __name__ == "__main__":
    resolve_test_conflicts(sys.argv[1])
