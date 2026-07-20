# Buddy Bots — Architecture

## Communications Security Controls (as of 2026.7.8)

| Control | Status | Enforcement point | Notes |
|----------------------|-----------------|------------------------------------|-------|
| Envelope schema | Implemented | `parseCoordinationMessage` | |
| Payload size limits | Implemented | same | |
| Expiry | Implemented | same | |
| Trust boundary | Partial | optional argument (now mandatory) | fail-closed after Phase 0 |
| Nonce / replay | Not implemented | — | planned |
| Peer authentication | External (XMTP) | transport adapter | coordination layer does not re-verify |
| Rate limiting | Not implemented | — | planned |
| PII / injection filter | Not implemented | — | planned |
| Audit trail | Not implemented | — | planned |

Any control not listed as "Implemented" + linked to a negative test is **not** a system guarantee.