# Spreadsheet Upload Guide

## Overview
The spreadsheet upload feature allows you to create multiple assets at once by uploading a CSV or XLSX file. Each row in the spreadsheet will create a new asset with a unique `did:peer` identifier.

## Required Columns

Your spreadsheet must include these columns:

- **title** - The name/title of the asset (required)
- **assetType** - The type of asset (e.g., Camera, Guitar, Vinyl) (required)
- **category** - Category classification (e.g., collectible, music, art) (required)

## Optional Columns

- **description** - Detailed description of the asset
- **tags** - Comma-separated tags (e.g., "vintage,camera,rare")
- **mediaUrl** - URL to associated media file (image, video, etc.)
- **status** - Asset status: "draft", "pending", or "completed" (defaults to "draft")

## Custom Properties

Any additional columns you add will be stored as custom properties for that asset type. For example:

- **serialNumber** - Serial or identification number
- **manufacturer** - Manufacturer or creator
- **yearProduced** - Year of production
- **edition** - Edition information
- **condition** - Condition rating

## Spreadsheet Format Example

See `sample-assets.csv` for a complete example:

```csv
title,assetType,category,description,tags,mediaUrl,status,serialNumber,manufacturer,yearProduced
Vintage Camera 001,Camera,collectible,Rare vintage camera from 1950s,"vintage,camera,photography",https://example.com/camera1.jpg,completed,CAM-1950-001,Leica,1952
Guitar Collection Item,Guitar,music,Classic electric guitar,"music,guitar,instrument",https://example.com/guitar1.jpg,completed,GTR-1965-042,Fender,1965
```

## Features

### Automatic did:peer Creation
Each asset automatically receives a unique `did:peer` identifier that cryptographically binds the asset metadata. This provides:

- Decentralized identity for each asset
- Cryptographic verification
- Provenance tracking
- Future migration capabilities to Bitcoin or Web layers

### Asset Type Management
- If an asset type doesn't exist, it will be automatically created
- Custom properties are extracted and stored as part of the asset type definition
- Asset types are stored in the database and linked to your user account

### Error Handling
- The system validates each row independently
- If some rows fail, successful rows are still created
- Detailed error reporting shows which rows failed and why
- Error messages include row numbers for easy troubleshooting

### Upload Limits
- Maximum file size: 10MB
- Supported formats: CSV, XLSX, XLS
- No limit on number of rows (reasonable limits apply for performance)

## Upload Process

1. Navigate to Dashboard or Assets page
2. Click "Upload Spreadsheet" button
3. Drag and drop your file or click to browse
4. Preview the first 5 rows to verify data
5. Click "Upload Assets" to process
6. View results showing created assets and any errors
7. Navigate to Assets page to view all created assets

## Best Practices

1. **Test with Small Batches**: Start with a few rows to verify your format
2. **Use Consistent Asset Types**: Group similar items with the same assetType
3. **Include Descriptions**: Rich descriptions help with searchability
4. **Tag Appropriately**: Tags make assets easier to filter and find
5. **Validate URLs**: Ensure media URLs are accessible
6. **Check Required Fields**: Verify title, assetType, and category are present

## Troubleshooting

### Common Errors

**"Missing required fields"**
- Ensure every row has title, assetType, and category
- Check for empty cells in required columns

**"Invalid file type"**
- Use only CSV or XLSX files
- Verify file extension matches content

**"Spreadsheet is empty"**
- Ensure file has header row and at least one data row
- Check for hidden characters or formatting issues

**"Failed to create asset"**
- Check error details for specific validation failures
- Verify data types match expected formats

## Technical Details

### DID Document Storage
Each asset's `did:peer` identifier is stored in the `credentials` field as:

```json
{
  "didDocument": { ... },
  "did": "did:peer:..."
}
```

### Asset Type Schema
Auto-created asset types include:
- User ID reference
- Asset type name
- Description
- Custom property definitions

### Processing Flow
1. File upload and validation
2. Spreadsheet parsing (CSV or XLSX)
3. Row-by-row processing:
   - Field validation
   - Custom property extraction
   - did:peer creation via Originals SDK
   - Asset storage
4. Asset type auto-creation
5. Results compilation and response

## API Endpoint

**POST** `/api/assets/upload-spreadsheet`

- Authentication: Required (Bearer token)
- Content-Type: multipart/form-data
- Field name: `file`
- Response: JSON with created assets and errors

## Migration from localStorage

Previously, asset types were stored in browser localStorage. The new system:
- Stores asset types in the database
- Links asset types to user accounts
- Enables server-side processing
- Supports bulk operations
- Provides better data persistence

Existing localStorage asset types can be migrated by recreating them through the Setup page.
