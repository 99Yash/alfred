# Mission: Alfred Agent Harness

## Why
Build enough operational understanding of Alfred's harness to trace a real run, explain why it behaved that way, and debug it without treating the model, queue, workflow engine, and prompt cache as one black box.

## Success looks like
- Trace one chat turn from HTTP request to durable completion using the real source files.
- Predict which component owns the loop, tool execution, checkpointing, and prompt-cache stability.
- Extend the trace case by case to tool calls, HIL approval, failures, recovery, and sub-agents.

## Constraints
- Teach at junior-engineer altitude, frame by frame, with concrete state changes.
- Cover one execution case at a time and use recall checks before adding complexity.

## Out of scope
- An exhaustive upfront map of every failure and approval combination.
