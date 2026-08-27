# Contributing to HYDRA-UMC-OPCUA-SERVER 🦾

We welcome contributions to the OPC-UA modeling module of the HYDRA-UMC ecosystem.

## Technology Stack
- **Language**: C++20.
- **OPC-UA Stack**: open62541 / Unified Automation.
- **Modeling**: XML NodeSets, UAModeler.
- **Build System**: CMake.

## Guidelines
1. **Information Model Integrity**: Any changes to the address space must be validated against the standard OPC UA NodeSet XML schemas.
2. **Deterministic Modeling**: Ensure that node IDs are persistent across server restarts to prevent PLC tag invalidation.
3. **Security Profiles**: New features must support Basic256Sha256 signing and encryption by default.
4. **Testing**: Validate tag discovery and subscription performance using standard industrial clients like Ignition or UaExpert.
