# Originals Protocol

A three-layer decentralized identifier (DID) protocol for digital asset authentication, provenance tracking, and ownership management.

## Three-Layer Architecture

1. **did:peer** (Private Layer) - Local, offline, private assets
2. **did:webvh** (Web Layer) - Published via HTTPS with verifiable history
3. **did:btco** (Bitcoin Layer) - Immutable inscription on Bitcoin blockchain

## Project Structure

```
/workspace
├── apps/originals-explorer/     # Main application
│   ├── client/                  # React frontend
│   ├── server/                  # Express backend
│   └── shared/                  # Shared types and schemas
├── src/                         # Originals SDK
│   ├── lifecycle/               # Asset lifecycle management
│   ├── bitcoin/                 # Bitcoin integration
│   ├── did/                     # DID management
│   └── credentials/             # Verifiable credentials
├── tests/                       # Test suite
└── legacy/                      # Legacy code

```

## Getting Started

See the documentation in `apps/originals-explorer/` for setup instructions.

## Features

- ✅ Asset creation with DID identifiers
- ✅ Layer tracking (peer → webvh → btco)
- ✅ Provenance chain management
- ✅ Verifiable credentials
- ✅ Asset migration between layers
- ✅ Transfer ownership
- ✅ Bitcoin inscription integration

## Development Status

Currently implementing the complete asset migration system across all three protocol layers.

## License

See LICENSE file for details.
