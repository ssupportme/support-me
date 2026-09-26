import sys

def resolve_conflicts(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # We will manually split and resolve based on standard git conflict markers
    parts = content.split("<<<<<<< HEAD\n")
    if len(parts) == 1:
        print("No conflicts found")
        return

    out = [parts[0]]
    
    for i in range(1, len(parts)):
        part = parts[i]
        # split by =======
        subparts = part.split("=======\n")
        head_content = subparts[0]
        rest = subparts[1].split(">>>>>>> upstream/main\n")
        upstream_content = rest[0]
        tail = rest[1]

        if i == 1:
            # First conflict: keep both docstrings
            out.append(head_content)
            out.append(upstream_content)
        else:
            # Keep HEAD content for all other conflicts
            out.append(head_content)
        
        out.append(tail)

    with open(filepath, 'w') as f:
        f.write("".join(out))

if __name__ == "__main__":
    resolve_conflicts(sys.argv[1])
