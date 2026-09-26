import sys

def resolve_test_conflicts(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    # Conflict 1: add_allowed_token
    c1 = "<<<<<<< HEAD\n        donation_client.add_allowed_token(&token_address);\n=======\n>>>>>>> upstream/main"
    content = content.replace(c1, "        donation_client.add_allowed_token(&token_address);")
    
    # Check if there are other similar ones with spaces or something
    # Actually, we can split by '<<<<<<< HEAD\n'
    parts = content.split("<<<<<<< HEAD\n")
    if len(parts) == 1:
        print("No more conflicts!")
        with open(filepath, 'w') as f:
            f.write(content)
        return

    out = [parts[0]]
    for i in range(1, len(parts)):
        part = parts[i]
        subparts = part.split("=======\n")
        head_content = subparts[0]
        
        rest = subparts[1].split(">>>>>>> upstream/main\n")
        if len(rest) == 1:
            rest = subparts[1].split(">>>>>>> upstream/main")
            
        upstream_content = rest[0]
        tail = rest[1]
        
        if head_content.strip() == "donation_client.add_allowed_token(&token_address);" and upstream_content.strip() == "":
            out.append(head_content)
            out.append(tail)
            continue
            
        # For the final conflict where HEAD has allowlist tests and upstream has try_charge tests:
        # We can just keep both
        if "test_donate_rejects_unallowed_token" in head_content and "test_charge_subscription_insufficient_allowance" in upstream_content:
            out.append(head_content)
            # Upstream tests might also need add_allowed_token!
            # We'll just append upstream_content as is, and then we might need to fix it later.
            out.append(upstream_content)
            out.append(tail)
            continue
            
        # If there's another one at the end that's just empty upstream
        if upstream_content.strip() == "":
            out.append(head_content)
            out.append(tail)
            continue
            
        # Default: keep both if not handled
        print(f"Unhandled conflict {i}!")
        out.append(head_content)
        out.append(upstream_content)
        out.append(tail)

    with open(filepath, 'w') as f:
        f.write("".join(out))
        print("Resolved conflicts written.")

if __name__ == "__main__":
    resolve_test_conflicts(sys.argv[1])
