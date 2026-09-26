import sys
import re

def resolve_test_conflicts(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # The conflict pattern is:
    # <<<<<<< HEAD
    # [head_content]
    # =======
    # [upstream_content]
    # >>>>>>> upstream/main
    
    # We will use regex to find all conflicts
    pattern = re.compile(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> upstream/main\n?', re.DOTALL)
    
    def replacer(match):
        head = match.group(1)
        upstream = match.group(2)
        
        # If upstream is empty, keep head
        if upstream.strip() == "":
            return head + "\n"
        
        # If head is empty, keep upstream
        if head.strip() == "":
            return upstream + "\n"
            
        # If head is a docstring, we might want to keep head or both, but this is a new merge, let's keep both
        # Actually for tests, keep both
        if "test_" in head or "test_" in upstream:
            return head + "\n" + upstream + "\n"
            
        # For the first conflict we had (docstrings, etc), just keep both
        return head + "\n" + upstream + "\n"

    new_content = pattern.sub(replacer, content)

    with open(filepath, 'w') as f:
        f.write(new_content)
        print("Resolved conflicts using regex.")

if __name__ == "__main__":
    resolve_test_conflicts(sys.argv[1])
