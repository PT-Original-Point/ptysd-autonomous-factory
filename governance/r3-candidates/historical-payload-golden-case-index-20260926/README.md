# R3-05 Historical Payload Golden Case Index

Classification: LOCAL / NONCANONICAL / UNTRUSTED CANDIDATE.

This candidate preserves the exact raw checkpoint blobs and indexes the 57 already-reported payload-digest mismatches under the source-pinned `canonicalize@5.0.0` recipe. Each raw checkpoint was fetched by its reported Git blob OID, then checked locally against both that Git blob OID and the reported raw SHA-256.

The archive is self-contained for the 57 checkpoint bytes, case metadata, and all eight exact source readback JSONs referenced by the index and manifest. Each readback is preserved at its exact filename and verified against its SHA-256. These source reports are evidence of prior readbacks; they are not new executions.

The expected outcome for all 57 cases remains `MISMATCH`. The bytes and index do not establish a historical writer profile, do not convert any mismatch to PASS, and do not modify project history, pointers, control, Mission, Policy, provider, Host, or Production state. The current recipe was not rerun in this unit; the existing reported results remain provenance rather than a newly claimed execution.
