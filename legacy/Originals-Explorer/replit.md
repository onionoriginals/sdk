# Originals - Digital Asset Authentication Platform

## Overview

Originals is a minimal protocol for creating, discovering, and transferring digital assets with cryptographically verifiable provenance. The protocol organizes asset lifecycle into three infrastructure-native layers: private (did:peer), public (did:webvh), and transferable (did:btco). Assets can migrate unidirectionally through these layers, with ownership secured by Bitcoin's consensus network. The web application provides an interface for users to create, manage, and migrate their digital assets through this three-layer system, featuring email/OTP authentication, Bitcoin wallet integration, and a clean directory tree visualization.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript for type safety
- **Build Tool**: Vite for fast development and optimized production builds
- **Routing**: Wouter for lightweight client-side routing
- **UI Framework**: shadcn/ui components built on Radix UI primitives
- **Styling**: Tailwind CSS with custom design system and CSS variables
- **State Management**: TanStack Query (React Query) for server state management
- **Form Handling**: React Hook Form with Zod validation schemas

### Backend Architecture
- **Runtime**: Node.js with Express.js framework
- **Language**: TypeScript with ES modules
- **API Design**: RESTful API with structured error handling
- **File Processing**: Uppy for file uploads with cloud storage integration
- **QR Code Generation**: Server-side QR code generation for asset sharing

### Database & ORM
- **Database**: PostgreSQL with Neon serverless driver
- **ORM**: Drizzle ORM for type-safe database operations
- **Schema Management**: Drizzle Kit for migrations and schema management
- **Schema Definition**: Shared schema types between frontend and backend

### Authentication & Wallet Integration
- **Wallet Support**: Multi-wallet Bitcoin integration (UniSat, Xverse)
- **Authentication**: Wallet-based authentication system
- **Asset Ownership**: Cryptographic proof of ownership verification

### File Storage & Media
- **Cloud Storage**: Google Cloud Storage integration
- **Upload Handling**: Uppy dashboard with drag-and-drop support
- **Media Types**: Support for various digital asset formats

### Data Models
The application manages three core entities:
- **Users**: Authentication and profile management
- **Assets**: Digital asset metadata, credentials, and status tracking
- **Wallet Connections**: Blockchain wallet associations and verification

### Development & Deployment
- **Development**: Hot reload with Vite development server
- **Build Process**: Separate frontend (Vite) and backend (esbuild) compilation
- **Code Quality**: TypeScript strict mode with comprehensive type checking
- **Environment**: Replit-optimized with development banner integration

## External Dependencies

### Blockchain & Wallet Services
- **UniSat Wallet**: Bitcoin wallet integration for asset management
- **Xverse Wallet**: Alternative Bitcoin wallet provider
- **Bitcoin Network**: Ordinals and inscription verification

### Cloud Services
- **Google Cloud Storage**: Media file storage and CDN
- **Neon Database**: Serverless PostgreSQL hosting

### Development Tools
- **Replit**: Development environment and deployment platform
- **Vercel**: Alternative deployment option for production

### UI Component Libraries
- **Radix UI**: Accessible component primitives
- **Lucide React**: Icon library for consistent iconography
- **Tailwind CSS**: Utility-first CSS framework

### Form & Validation
- **React Hook Form**: Form state management
- **Zod**: Runtime type validation and schema definition

### File Upload & Processing
- **Uppy**: Modular file uploader with cloud storage support
- **QRCode**: Server-side QR code generation for sharing