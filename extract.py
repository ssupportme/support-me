import sys

def extract_conflicts(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    parts = content.split("<<<<<<< HEAD\n")
    if len(parts) == 1:
        print("No conflicts found")
        return

    out = []
    
    for i in range(1, len(parts)):
        part = parts[i]
        subparts = part.split("=======\n")
        head_content = subparts[0]
        
        # handle missing newline at EOF
        if ">>>>>>> upstream/main\n" in subparts[1]:
            rest = subparts[1].split(">>>>>>> upstream/main\n")
        else:
            rest = subparts[1].split(">>>>>>> upstream/main")
            
        upstream_content = rest[0]
        
        out.append(f"--- CONFLICT {i} ---\nHEAD:\n{head_content}=======\nUPSTREAM:\n{upstream_content}-------------------\n")

    with open("conflicts.txt", 'w') as f:
        f.write("".join(out))

if __name__ == "__main__":
    extract_conflicts(sys.argv[1])
