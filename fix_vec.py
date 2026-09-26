import sys

def replace_soroban_vec(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Replace import "Vec as SorobanVec" with "Vec"
    content = content.replace("Vec as SorobanVec", "Vec")
    # Replace all usage of SorobanVec with Vec
    content = content.replace("SorobanVec", "Vec")

    with open(filepath, 'w') as f:
        f.write(content)

if __name__ == "__main__":
    replace_soroban_vec(sys.argv[1])
