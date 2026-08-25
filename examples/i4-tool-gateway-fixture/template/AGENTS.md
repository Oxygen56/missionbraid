# Iteration 4 Tool Gateway Fixture

This is a disposable Agent-development fixture for a real pre-tool breakpoint.

- Use the native `Write` tool exactly once to create `original.txt` with the exact content `ORIGINAL` followed by a newline.
- Do not use Bash or another mutable tool before that Write request.
- After Write returns, run `node verify.mjs` with Bash.
- If verification succeeds, stop. Do not create any other file.
- Do not use shell redirection, Python, Git, the network, or external services.

The controller may inspect, reject, or modify a pending mutable tool request. Treat the actual tool result as authoritative.
