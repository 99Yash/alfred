# Capabilities must precede prompt construction

The learner identified that a multi-provider harness should exploit the selected model's best provider-native behavior instead of forcing every provider through one lowest-common-denominator tool surface. The key architectural implication is that Alfred must resolve the concrete provider/model and its tool-loading limitations before constructing the prompt; an opaque fallback that changes providers only inside the model call is too late for protocol-level differences such as deferred tool search.

**Evidence:** Independently proposed tracking provider limitations and selecting advantages based on the model actually used.
